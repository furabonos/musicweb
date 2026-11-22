import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createMusicBrainz } from '../adapters/musicbrainz.js';
import { firestoreCallBudget } from '../adapters/music-http.js';
import { createWikidata } from '../adapters/wikidata.js';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { MB_CONTACT, secrets } from '../config/secrets.js';
import { firestoreEventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { firestoreLastfmCache } from '../adapters/lastfm.js';
import { createJudge, createLlm, firestoreLlmBudget, LlmConfigError } from '../adapters/llm.js';
import { runIngest } from './ingest.js';
import { runPurge } from './purge.js';
import { runRefresh } from './refresh.js';
import { createOpenLinkChecker, firestoreOpenLinkBudget } from '../adapters/youtube-openlink.js';
import { firestoreLinkHealthPorts, runLinkHealth } from './linkHealth.js';
import { runDailyEval } from './dailyEval.js';

/**
 * 예약 작업 (SPEC 4.4). 태평양 시간 기준, YouTube 할당 초기화(자정) 뒤에 차례로 돈다:
 *   01:00 재확인(refresh) → 02:00 정리(purge) → 03:00 수집(ingest).
 *   재확인이 먼저 돌아야 확인된 연결이 정리에서 지워지지 않는다.
 * - 인스턴스 1개: 음악 데이터 출처별 초당 1회 줄이 인스턴스 안에서만 공유되기 때문(D-024).
 * - 애매한 연결의 AI 판정(judge)은 T13에서 연결했다. AI가 실패하면 그 실행 동안 pending_ai로 남긴다.
 */
export const ingestNightly = onSchedule(
  {
    schedule: 'every day 03:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.YOUTUBE_API_KEY, secrets.ACTOR_HASH_KEY, secrets.ANTHROPIC_API_KEY],
  },
  async () => {
    // 제한 시간(540초)보다 60초 앞에서 멈추고 처리한 데까지 저장한다.
    const deadlineMs = Date.now() + 480_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const music = { events, budget: firestoreCallBudget(db), contact: MB_CONTACT.value() };
    await runIngest({
      db,
      yt: createYouTubeRead({
        apiKey: secrets.YOUTUBE_API_KEY.value(),
        events,
        budget: firestoreYtBudget(db, 'ingest'),
      }),
      mb: createMusicBrainz(music),
      wd: createWikidata(music),
      events,
      // 애매한 연결은 AI가 판정한다. AI가 실패하면 그 실행에서는 pending_ai로 남긴다(D-030).
      ...(await ingestJudge(db, events)),
      deadlineMs,
    });
  },
);

/** 25일 재확인 (T11). YouTube 한도·긴급 정지 ingest를 따른다. */
export const refreshNightly = onSchedule(
  {
    schedule: 'every day 01:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.YOUTUBE_API_KEY, secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const deadlineMs = Date.now() + 480_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    await runRefresh({
      db,
      yt: createYouTubeRead({
        apiKey: secrets.YOUTUBE_API_KEY.value(),
        events,
        budget: firestoreYtBudget(db, 'ingest'),
      }),
      events,
      deadlineMs,
    });
  },
);

/** 30일 정리 (T11). 외부 호출 없이 지우기만 하므로 긴급 정지와 관계없이 돈다. */
export const purgeNightly = onSchedule(
  {
    schedule: 'every day 02:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const db = getFirestore();
    await runPurge({
      db,
      events: firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value()),
      lastfmCache: firestoreLastfmCache(db),
    });
  },
);

/**
 * "YouTube에서 열기" 링크 매일 확인 (T16, D-006). 정리(02:00) 뒤 04:00.
 * 외부 요청 1번(헤더만)이고 하루 상한(linkChecks)을 따른다. 긴급 정지 스위치 대상은 아니다(돈이 들지 않음).
 */
export const linkHealthNightly = onSchedule(
  {
    schedule: 'every day 04:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 60,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const checker = createOpenLinkChecker({ events, budget: firestoreOpenLinkBudget(db) });
    await runLinkHealth(
      firestoreLinkHealthPorts(db, { check: (ids) => checker.check(ids), events }),
    );
  },
);

/**
 * 매일 시험 (T17, D-034). 05:00. 곡 연결 규칙 시험은 항상, 요청 해석 시험은 AI 키가 있을 때만(서비스 하루 비용 상한 안).
 */
export const dailyEvalNightly = onSchedule(
  {
    schedule: 'every day 05:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 300,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY, secrets.ANTHROPIC_API_KEY],
  },
  async () => {
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    let llm = null;
    try {
      llm = createLlm({
        apiKey: secrets.ANTHROPIC_API_KEY.value(),
        events,
        budget: firestoreLlmBudget(db),
      });
    } catch (err) {
      // 키가 없으면(사용자가 아직 API 키를 정하지 않음, D-034) AI 시험은 건너뛴다. 그 밖의 오류는 기록한다.
      if (!(err instanceof LlmConfigError)) {
        await events.record({
          type: 'error',
          attrs: { code: errName(err), where: 'dailyEval.llm_setup' },
          outcome: 'error',
        });
      }
    }
    await runDailyEval({ db, events, llm });
  },
);

/** AI 판정 함수. 키 문제 등으로 만들지 못하면 판정 없이 수집한다(애매한 연결은 pending_ai, D-030). */
async function ingestJudge(
  db: ReturnType<typeof getFirestore>,
  events: ReturnType<typeof firestoreEventSink>,
): Promise<{ judge?: ReturnType<typeof createJudge> }> {
  try {
    const llm = createLlm({
      apiKey: secrets.ANTHROPIC_API_KEY.value(),
      events,
      budget: firestoreLlmBudget(db),
    });
    return { judge: createJudge(llm) };
  } catch (err) {
    await events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'ingest.judge_setup' },
      outcome: 'error',
    });
    return {};
  }
}
