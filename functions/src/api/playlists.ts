import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { SUPPORTED_LOCALES } from '@musicweb/shared';
import { z } from 'zod';
import { createLastfm, firestoreLastfmCache } from '../adapters/lastfm.js';
import { createListenBrainz } from '../adapters/listenbrainz.js';
import { createLlm, firestoreLlmBudget, LlmConfigError, type Llm } from '../adapters/llm.js';
import { firestoreCallBudget } from '../adapters/music-http.js';
import { createMusicBrainz } from '../adapters/musicbrainz.js';
import { createWikidata } from '../adapters/wikidata.js';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { fakeExternalEnabled } from '../config/runtimeEnv.js';
import { MB_CONTACT, secrets } from '../config/secrets.js';
import type { CallerAuth } from '../core/auth.js';
import type { EventSink } from '../core/events.js';
import { enqueueArtist } from '../core/ingestQueue.js';
import { touchRequested } from '../core/precomputeOnDemand.js';
import { parseFallback, parseWithFallback } from '../core/parseFallback.js';
import { enterSavingMode, readSavingMode, savingModeState } from '../core/savingMode.js';
import { createPlaylist, getPlaylist, savePlaylist, updatePlaylist } from '../core/playlists.js';
import { readRuntimeConfig, RuntimeConfigError } from '../core/runtimeConfig.js';
import { recommend, type RecommendPorts } from '../core/recommend.js';
import { firestoreRecommendPorts } from '../core/recommendPorts.js';
import { fakeLlm, fakeMusicAndYt } from '../dev/fakeWorld.js';
import { requireAdmin } from './admin.js';
import { handle } from './errors.js';
import { callableEventSink } from './eventSink.js';

/**
 * 재생목록 callable (SPEC 1.3, 4.3, T14, D-031).
 * - 만들기는 로그인 기능(T24) 전까지 관리자만(D-015).
 * - 만들기는 인스턴스 1개: 음악 데이터 출처별 초당 1회 줄이 인스턴스 안에서만 공유되고(D-024),
 *   조회로 찾은 연결 저장의 "이미 연결된 영상" 확인이 동시에 돌지 않게 하기 위함(D-030). 동시 요청은 줄을 선다.
 * - 에뮬레이터의 가짜 프로젝트에서는 가짜 AI·음악 데이터·YouTube를 쓴다(config/runtimeEnv.ts).
 */

const createInput = z.strictObject({
  // 200자(코드 포인트) 검사는 parseRequest가 한다(넘으면 too_long). 여기서는 터무니없이 긴 값만 막는다.
  text: z.string().max(2000),
  locale: z.enum(SUPPORTED_LOCALES),
});
const playlistId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/);
const updateInput = z.strictObject({
  id: playlistId,
  action: z.enum(['remove', 'replace']),
  position: z.number().int().min(0).max(99),
});
const saveInput = z.strictObject({ id: playlistId });
const getInput = z.strictObject({ id: playlistId });

function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new HttpsError('invalid-argument', 'invalid input', { reason: 'input' });
  return parsed.data;
}

function requireUid(auth: { uid?: string } | undefined): string {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'sign in required');
  return auth.uid;
}

const fake = () => fakeExternalEnabled();

/** 실제 어댑터(또는 에뮬레이터 가짜)로 추천 포트와 AI를 만든다. */
/** AI 키가 없을 때 넣는 자리. AI 없는 방식(aiMode no_key)이라 불리지 않는다 */
const NO_LLM: Llm = {
  structured: async () => {
    throw new LlmConfigError('ANTHROPIC_API_KEY가 없습니다.');
  },
};

function buildPorts(db: Firestore, events: EventSink): { ports: RecommendPorts; llm: Llm | null } {
  if (fake()) {
    const llm = fakeLlm(firestoreLlmBudget(db));
    const base = firestoreRecommendPorts({
      db,
      mb: {} as never,
      lb: {} as never,
      wd: {} as never,
      yt: {} as never,
      llm,
      events,
    });
    return { ports: { ...base, ...fakeMusicAndYt(), officialChannels: async () => [] }, llm };
  }
  const music = { events, budget: firestoreCallBudget(db), contact: MB_CONTACT.value() };
  // 키가 없으면(사이트 AI 키 미정, D-039) AI 없는 방식으로 돈다
  let llm: Llm | null = null;
  try {
    llm = createLlm({
      apiKey: secrets.ANTHROPIC_API_KEY.value(),
      events,
      budget: firestoreLlmBudget(db),
    });
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err;
  }
  const lastfmKey = secrets.LASTFM_API_KEY.value();
  const ports = firestoreRecommendPorts({
    db,
    mb: createMusicBrainz(music),
    lb: createListenBrainz(music),
    wd: createWikidata(music),
    // Last.fm은 보조 출처: 키가 없으면 빼고 진행한다
    ...(lastfmKey
      ? { lastfm: createLastfm({ ...music, apiKey: lastfmKey, cache: firestoreLastfmCache(db) }) }
      : {}),
    yt: createYouTubeRead({
      apiKey: secrets.YOUTUBE_API_KEY.value(),
      events,
      budget: firestoreYtBudget(db, 'create'),
    }),
    llm: llm ?? NO_LLM,
    events,
  });
  return { ports, llm };
}

// TODO(T23): App Check 설정 후 enforceAppCheck: true (SPEC 6.1).
export const playlists = {
  create: onCall(
    {
      maxInstances: 1,
      concurrency: 1,
      timeoutSeconds: 120,
      secrets: [
        secrets.ANTHROPIC_API_KEY,
        secrets.YOUTUBE_API_KEY,
        secrets.LASTFM_API_KEY,
        secrets.ACTOR_HASH_KEY,
      ],
    },
    (req) =>
      handle(async () => {
        requireUid(req.auth);
        // D-015: 로그인 기능(T24) 전까지 만들기는 관리자만
        const uid = await requireAdmin(req.auth as CallerAuth | undefined);
        const input = parseInput(createInput, req.data);
        const db = getFirestore();
        const events = callableEventSink(db);
        const { ports, llm } = buildPorts(db, events);
        // 절약 모드·키 없음이면 AI 없이 (SPEC 3.4, D-039). AI 비용 상한에 닿으면 절약 모드를 켠다
        const aiMode = !llm
          ? ('no_key' as const)
          : (await readSavingMode(db, events))
            ? ('saving' as const)
            : ('on' as const);
        const onAiLimit = async () => void (await enterSavingMode(db, events));
        return createPlaylist(
          {
            db,
            events,
            parse: (text, locale) =>
              parseWithFallback({ llm, events, actorUid: uid, aiMode, onAiLimit }, text, locale),
            rejectBeforeLimit: async (text, locale) =>
              aiMode === 'on' || parseFallback(text, locale)
                ? null
                : parseWithFallback({ llm, events, actorUid: uid, aiMode }, text, locale),
            ...(aiMode === 'on'
              ? {
                  reparseWithAi: (text: string, locale: 'en' | 'ko') =>
                    parseWithFallback(
                      { llm, events, actorUid: uid, aiMode, onAiLimit, skipRule: true },
                      text,
                      locale,
                    ),
                }
              : {}),
            recommend: (parsed, spares) =>
              recommend(
                ports,
                parsed,
                { uid },
                { spares, ai: { mode: aiMode, onLimit: onAiLimit } },
              ),
            enqueueArtist: (artist) => enqueueArtist(db, artist),
            touchRequested: (ids) => touchRequested(db, ids),
          },
          uid,
          input,
        );
      }),
  ),
  update: onCall({ secrets: [secrets.ACTOR_HASH_KEY] }, (req) =>
    handle(async () => {
      const uid = requireUid(req.auth);
      const input = parseInput(updateInput, req.data);
      const db = getFirestore();
      return updatePlaylist({ db, events: callableEventSink(db) }, uid, input);
    }),
  ),
  save: onCall((req) =>
    handle(async () => {
      const uid = requireUid(req.auth);
      return savePlaylist({ db: getFirestore() }, uid, parseInput(saveInput, req.data));
    }),
  ),
  /** 재생목록 열기(`/p/:id`). 저장된 것은 로그인 없이. 화면이 "YouTube에서 열기" 방식도 같이 받는다. */
  get: onCall((req) =>
    handle(async () => {
      const { id } = parseInput(getInput, req.data);
      const db = getFirestore();
      const [playlist, openLink] = await Promise.all([
        getPlaylist(db, req.auth?.uid ?? null, id),
        openLinkMode(db),
      ]);
      return { ...playlist, openLink };
    }),
  ),
};

/**
 * "YouTube에서 열기" 방식. 설정 문서가 깨졌으면 곡별 링크(fallback)로 답한다:
 * 부가 정보 때문에 공유 화면 전체가 오류가 되지 않게, 그리고 곡별 링크는 항상 동작하므로.
 */
async function openLinkMode(db: Firestore) {
  try {
    return (await readRuntimeConfig(db)).youtubeOpenLink;
  } catch (err) {
    if (err instanceof RuntimeConfigError) return 'fallback' as const;
    throw err;
  }
}

/** 절약 모드인가(화면 안내용). 요청 처리와 같은 판정(날 바뀜·상한 상향이면 꺼짐). 설정이 깨졌으면 false(부가 정보) */
async function savingModeOn(db: Firestore): Promise<boolean> {
  try {
    return savingModeState((await db.doc('config/runtime').get()).data(), new Date()).active;
  } catch {
    return false;
  }
}

/** 화면용 공개 설정(로그인 불필요): "YouTube에서 열기" 방식(D-006), 절약 모드 여부(SPEC 3.4). */
export const site = {
  // 키 값은 읽기만 해서 "AI 없음"인지 판단한다(값은 내보내지 않음)
  config: onCall({ secrets: [secrets.ANTHROPIC_API_KEY] }, () =>
    handle(async () => {
      const db = getFirestore();
      const noAi = !fake() && !secrets.ANTHROPIC_API_KEY.value().trim();
      return {
        openLink: await openLinkMode(db),
        savingMode: await savingModeOn(db),
        noAi,
      };
    }),
  ),
};
