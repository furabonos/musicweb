import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from './callable.js';
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
import { MB_CONTACT, optionalSecret, secrets } from '../config/secrets.js';
import type { CallerAuth } from '../core/auth.js';
import type { EventSink } from '../core/events.js';
import { enqueueArtist } from '../core/ingestQueue.js';
import { firestoreParseCache } from '../core/parseCache.js';
import { withResultCache } from '../core/resultCache.js';
import { errName } from '../core/jobErrors.js';
import { touchRequested } from '../core/precomputeOnDemand.js';
import { parseFallback, parseWithFallback } from '../core/parseFallback.js';
import { COUNT_MAX, COUNT_MIN, type Locale, type ParsedRequest } from '../core/parseRequest.js';
import { enterSavingMode, readSavingMode, savingModeState } from '../core/savingMode.js';
import {
  assertNotBlocked,
  createPlaylist,
  getPlaylist,
  savePlaylist,
  updatePlaylist,
} from '../core/playlists.js';
import { explainPlaylist } from '../core/explain.js';
import { BudgetExceededError } from '../core/budget.js';
import {
  effectiveRecommendMode,
  readRuntimeConfig,
  RuntimeConfigError,
} from '../core/runtimeConfig.js';
import { recommend, type RecommendPorts } from '../core/recommend.js';
import { firestoreRecommendPorts } from '../core/recommendPorts.js';
import { fakeLlm, fakeMusicAndYt } from '../dev/fakeWorld.js';
import { requireAdmin } from './admin.js';
import { handle } from './errors.js';
import { isPickable } from './songs.js';
import { callableEventSink, serverHashKey } from './eventSink.js';

/**
 * 재생목록 callable (SPEC 1.3, 4.3, T14, D-031).
 * - 만들기는 로그인 기능(T24) 전까지 관리자만(D-015).
 * - 만들기는 인스턴스 1개: 음악 데이터 출처별 초당 1회 줄이 인스턴스 안에서만 공유되고(D-024),
 *   조회로 찾은 연결 저장의 "이미 연결된 영상" 확인이 동시에 돌지 않게 하기 위함(D-030). 동시 요청은 줄을 선다.
 * - 에뮬레이터의 가짜 프로젝트에서는 가짜 AI·음악 데이터·YouTube를 쓴다(config/runtimeEnv.ts).
 */

const createInput = z.union([
  z.strictObject({
    // 200자(코드 포인트) 검사는 parseRequest가 한다(넘으면 too_long). 여기서는 터무니없이 긴 값만 막는다.
    text: z.string().max(2000),
    locale: z.enum(SUPPORTED_LOCALES),
  }),
  // 곡 고르기 화면(T33): 해석 단계 없이 곡 ID·곡 수·조건
  z.strictObject({
    seedSongId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    count: z.number().int().min(COUNT_MIN).max(COUNT_MAX),
    include: z.strictObject({ live: z.boolean(), cover: z.boolean(), remix: z.boolean() }),
    locale: z.enum(SUPPORTED_LOCALES),
  }),
]);

/**
 * 곡 고르기 입력을 해석 결과로 바꾼다(AI·규칙 없음). 곡 목록에 없거나 정보가 적은 곡이면 거부.
 * 저장되는 요청 글은 사용자가 쓴 문장이 아니라 "아티스트 - 제목"이다.
 */
async function pickedRequest(
  db: Firestore,
  input: { seedSongId: string; count: number; include: ParsedRequest['include']; locale: Locale },
): Promise<{ text: string; value: ParsedRequest }> {
  const snap = await db.doc(`songs/${input.seedSongId}`).get();
  if (!isPickable(snap)) {
    throw new HttpsError('not-found', 'song not found', { reason: 'seedSongNotFound' });
  }
  const artist = snap.get('artist') as string;
  const title = snap.get('title') as string;
  return {
    text: `${artist} - ${title}`.slice(0, 200),
    value: {
      seed: { artist, title },
      count: input.count,
      include: input.include,
      locale: input.locale,
      unsupported: [],
    },
  };
}
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

/**
 * AI 연결만. 키가 없으면(사이트 AI 키 미정, D-039) null → AI 없는 방식으로 돈다.
 * 자세한 이유(explain)는 음악·YouTube 연결 없이 이것만 쓴다(그 함수에 선언하지 않은 비밀값을 읽지 않게).
 */
function buildLlm(db: Firestore, events: EventSink): Llm | null {
  if (fake()) return fakeLlm(firestoreLlmBudget(db));
  try {
    return createLlm({
      apiKey: optionalSecret('ANTHROPIC_API_KEY'),
      events,
      budget: firestoreLlmBudget(db),
    });
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err;
    return null;
  }
}

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
  const llm = buildLlm(db, events);
  const lastfmKey = optionalSecret('LASTFM_API_KEY');
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
        const raw = parseInput(createInput, req.data);
        const db = getFirestore();
        const picked = 'seedSongId' in raw ? await pickedRequest(db, raw) : null;
        const input = picked
          ? { text: picked.text, locale: raw.locale }
          : (raw as { text: string; locale: Locale });
        const events = callableEventSink(db);
        const { ports, llm } = buildPorts(db, events);
        // 절약 모드·키 없음이면 AI 없이 (SPEC 3.4, D-039). AI 비용 상한에 닿으면 절약 모드를 켠다
        const aiMode = !llm
          ? ('no_key' as const)
          : (await readSavingMode(db, events))
            ? ('saving' as const)
            : ('on' as const);
        // 추천 방식(기본 AI, D-052). 설정을 못 읽으면 미리 계산한 방식
        const configured = await readRuntimeConfig(db)
          .then((c) => c.recommendMode)
          .catch(async (err: unknown) => {
            // 설정이 깨졌으면 기록을 남기고 미리 계산한 방식으로(한도·긴급 정지 확인은 만들기 단계가 따로 막는다)
            await events.record({
              type: 'error',
              attrs: { code: errName(err), where: 'playlists.recommend_mode' },
              outcome: 'error',
            });
            return 'precomputed' as const;
          });
        const mode = effectiveRecommendMode(configured, aiMode);
        const onAiLimit = async () => void (await enterSavingMode(db, events));
        // 저장된 해석(30일)·결과(7일) (T32, D-048)
        const parseCache = firestoreParseCache(db, serverHashKey());
        // 설정은 ai인데 지금 AI를 못 쓰면 저장된 AI 결과를 먼저 다시 쓴다(비용 없이 더 나은 결과, 저장은 미리 계산 키에만)
        const alsoRead = configured === 'ai' && mode !== 'ai' ? 'ai' : undefined;
        const cachedRecommend = withResultCache({ db, mode, alsoRead, events }, (parsed, spares) =>
          recommend(
            ports,
            parsed,
            { uid },
            { spares, mode, ai: { mode: aiMode, onLimit: onAiLimit } },
          ),
        );
        return createPlaylist(
          {
            db,
            events,
            parse: async (text, locale) =>
              picked
                ? { ok: true, value: picked.value, via: 'pick' as const }
                : parseWithFallback(
                    { llm, events, actorUid: uid, aiMode, onAiLimit, cache: parseCache },
                    text,
                    locale,
                  ),
            // AI를 못 쓸 때 규칙으로도 못 읽고 저장된 해석도 없는 문장은 한도를 쓰기 전에 다시 묻는다
            rejectBeforeLimit: async (text, locale) =>
              picked ||
              aiMode === 'on' ||
              parseFallback(text, locale) ||
              (await parseCache.get(text, locale).catch(() => null))
                ? null
                : parseWithFallback({ llm, events, actorUid: uid, aiMode }, text, locale),
            ...(aiMode === 'on' && !picked
              ? {
                  reparseWithAi: (text: string, locale: 'en' | 'ko') =>
                    parseWithFallback(
                      {
                        llm,
                        events,
                        actorUid: uid,
                        aiMode,
                        onAiLimit,
                        skipRule: true,
                        cache: parseCache,
                      },
                      text,
                      locale,
                    ),
                }
              : {}),
            recommend: cachedRecommend,
            enqueueArtist: (artist) => enqueueArtist(db, artist),
            touchRequested: (ids) => touchRequested(db, ids),
          },
          uid,
          input,
        );
      }),
  ),
  /**
   * 자세한 이유(T34, D-050): 소유자 재생목록의 곡별 이유를 AI로. 절약 모드·AI 없음이면 거부(failed-precondition).
   * 사용자 하루 explains 상한, (기준 곡, 곡, 언어) 이유 저장소 재사용.
   */
  explain: onCall(
    { secrets: [secrets.ANTHROPIC_API_KEY, secrets.ACTOR_HASH_KEY], timeoutSeconds: 60 },
    (req) =>
      handle(async () => {
        const uid = requireUid(req.auth);
        const { id } = parseInput(getInput, req.data);
        const db = getFirestore();
        const events = callableEventSink(db);
        await assertNotBlocked(db, uid);
        const llm = buildLlm(db, events);
        if (!llm) throw new HttpsError('failed-precondition', 'AI is off', { reason: 'noAi' });
        if (await readSavingMode(db, events)) {
          throw new HttpsError('failed-precondition', 'saving mode', { reason: 'savingMode' });
        }
        try {
          const out = await explainPlaylist({ db, llm, events }, uid, id);
          // AI가 아무 이유도 주지 않았다: 빈 결과를 "받음"으로 보이지 않게 오류로 알린다(화면은 다시 누를 수 있다)
          if (out.requested > 0 && Object.keys(out.reasons).length === 0) {
            throw new HttpsError('unavailable', 'no reasons', { reason: 'explainFailed' });
          }
          return { reasons: out.reasons };
        } catch (err) {
          // AI 비용 상한에 닿으면 절약 모드를 켜고 같은 거부로 답한다
          if (err instanceof BudgetExceededError && err.counter === 'aiCostMicroUsd') {
            await enterSavingMode(db, events);
            throw new HttpsError('failed-precondition', 'saving mode', { reason: 'savingMode' });
          }
          throw err;
        }
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
      const noAi = !fake() && !optionalSecret('ANTHROPIC_API_KEY');
      return {
        openLink: await openLinkMode(db),
        savingMode: await savingModeOn(db),
        noAi,
      };
    }),
  ),
};
