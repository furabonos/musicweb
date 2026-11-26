import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createMusicBrainz } from '../adapters/musicbrainz.js';
import { firestoreCallBudget } from '../adapters/music-http.js';
import { createWikidata } from '../adapters/wikidata.js';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { MB_CONTACT, optionalSecret, secrets } from '../config/secrets.js';
import { firestoreEventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { firestoreLastfmCache } from '../adapters/lastfm.js';
import {
  createJudge,
  createLlm,
  firestoreLlmBudget,
  firestorePrewarmLlmBudget,
  LlmConfigError,
} from '../adapters/llm.js';
import { runIngest } from './ingest.js';
import { runPurge } from './purge.js';
import { runRefresh } from './refresh.js';
import { createOpenLinkChecker, firestoreOpenLinkBudget } from '../adapters/youtube-openlink.js';
import { firestoreLinkHealthPorts, runLinkHealth } from './linkHealth.js';
import { runDailyEval } from './dailyEval.js';
import {
  createGitHubReader,
  createIssueFiler,
  firestoreFingerprintStore,
  firestoreGitHubReadBudget,
  firestoreIssueBudget,
} from '../adapters/github.js';
import { runAutoIssue } from './autoIssue.js';
import { runGithubStats } from './githubStats.js';
import { runMetrics } from './metrics.js';
import { runPrecompute } from './precompute.js';
import { runRetryFailedSeeds } from './retryFailedSeeds.js';
import { nightAiBudget, runPrewarmResults } from './prewarmResults.js';
import { recommend } from '../core/recommend.js';
import { firestoreRecommendPorts } from '../core/recommendPorts.js';
import { effectiveRecommendMode, readRuntimeConfig } from '../core/runtimeConfig.js';
import { createLastfm } from '../adapters/lastfm.js';
import { createListenBrainz } from '../adapters/listenbrainz.js';
import { enterSavingMode, readSavingMode } from '../core/savingMode.js';

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
        apiKey: optionalSecret('ANTHROPIC_API_KEY'),
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

/**
 * 자동 이슈 (T19, D-037). 06:00, 다른 작업·매일 시험(05:00)이 끝난 뒤 지난 24시간을 본다.
 * 긴급 정지 autoIssue와 하루 상한(autoIssues 5, githubCalls)을 따른다. 토큰이 없으면 감지만 하고 운영 일지에 남긴다.
 */
export const autoIssueNightly = onSchedule(
  {
    schedule: 'every day 06:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 120,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY, secrets.GITHUB_ISSUE_TOKEN],
  },
  async () => {
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const token = optionalSecret('GITHUB_ISSUE_TOKEN');
    const filer = token
      ? createIssueFiler({
          token,
          events,
          budget: firestoreIssueBudget(db),
          store: firestoreFingerprintStore(db),
        })
      : null;
    await runAutoIssue({ db, events, filer });
  },
);

/**
 * 현황판 GitHub 수치 (T21, D-042). 05:15, 하루 한 번. 자동 이슈와 같은 토큰(이 저장소 이슈·PR 읽기)과 githubCalls 상한.
 * 토큰이 없으면 수치 없이 "토큰 없음"으로 남긴다.
 */
export const githubStatsNightly = onSchedule(
  {
    schedule: 'every day 05:15',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 120,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY, secrets.GITHUB_ISSUE_TOKEN],
  },
  async () => {
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const token = optionalSecret('GITHUB_ISSUE_TOKEN');
    const reader = token
      ? createGitHubReader({ token, events, budget: firestoreGitHubReadBudget(db) })
      : null;
    await runGithubStats({ db, events, reader });
  },
);

/** 현황판 서비스·곡 목록 지표 (T21, D-042). 05:30, 매일 시험(05:00) 뒤. 외부 호출 없음. */
export const metricsNightly = onSchedule(
  {
    schedule: 'every day 05:30',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 120,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const db = getFirestore();
    await runMetrics({ db, events: firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value()) });
  },
);

/**
 * 비슷한 아티스트·숫자 묶음 미리 계산 (T29, D-046). 03:30, 수집(03:00) 뒤. 최근 조회 순 + 수집 대상.
 * 인스턴스 1개: 음악 데이터 초당 1회 줄(D-024). 제한 시간 60초 앞에서 멈추고 다음 밤에 이어 한다.
 */
export const precomputeNightly = onSchedule(
  {
    schedule: 'every day 03:30',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const deadlineMs = Date.now() + 480_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const deps = { events, budget: firestoreCallBudget(db), contact: MB_CONTACT.value() };
    const mb = createMusicBrainz(deps);
    const lb = createListenBrainz(deps);
    await runPrecompute({
      db,
      events,
      deadlineMs,
      music: {
        similarArtists: (mbid, limit) => lb.similarArtists(mbid, limit),
        getRecording: (mbid) => mb.getRecording(mbid),
      },
    });
  },
);

/** AI 판정 함수. 키 문제 등으로 만들지 못하면 판정 없이 수집한다(애매한 연결은 pending_ai, D-030). */
async function ingestJudge(
  db: ReturnType<typeof getFirestore>,
  events: ReturnType<typeof firestoreEventSink>,
): Promise<{ judge?: ReturnType<typeof createJudge> }> {
  // 절약 모드면 AI 판정 없이 수집한다(애매한 연결은 pending_ai, SPEC 3.4)
  if (await readSavingMode(db, events)) return {};
  try {
    const llm = createLlm({
      apiKey: optionalSecret('ANTHROPIC_API_KEY'),
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

/**
 * 실패한 이름 다시 찾기 (T43, D-056). 02:45, 수집(03:00) 앞: 찾은 아티스트가 그날 밤 대기열에서 옮겨진다.
 * 인스턴스 1개: 음악 데이터 초당 1회 줄(D-024).
 */
export const retryFailedSeedsNightly = onSchedule(
  {
    schedule: 'every day 02:45',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 300,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const deadlineMs = Date.now() + 240_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const mb = createMusicBrainz({
      events,
      budget: firestoreCallBudget(db),
      contact: MB_CONTACT.value(),
    });
    await runRetryFailedSeeds({ db, events, deadlineMs, mb });
  },
);

/**
 * 재생목록 미리 만들기 (T44, D-056). 03:45, 미리 계산(03:30) 뒤. 인스턴스 1개: 음악 데이터 초당 1회 줄(D-024).
 * 추천은 만들기 함수와 같은 부품으로 조립하되, YouTube 검색은 끄고(밤 작업이 사용자 검색 몫을 쓰지 않게)
 * AI는 밤 AI 몫($0.30) 안에서만 쓴다. 설정을 못 읽으면 미리 계산한 방식으로.
 */
export const prewarmResultsNightly = onSchedule(
  {
    schedule: 'every day 03:45',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [
      secrets.ANTHROPIC_API_KEY,
      secrets.YOUTUBE_API_KEY,
      secrets.LASTFM_API_KEY,
      secrets.ACTOR_HASH_KEY,
    ],
  },
  async () => {
    // 추천 한 번이 길 수 있어(조회 여러 번, 초당 1회) 제한 시간보다 2분 앞에서 멈춘다
    const deadlineMs = Date.now() + 420_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const music = { events, budget: firestoreCallBudget(db), contact: MB_CONTACT.value() };
    const night = nightAiBudget(firestorePrewarmLlmBudget(db));
    let llm: ReturnType<typeof createLlm> | null = null;
    try {
      llm = createLlm({
        apiKey: optionalSecret('ANTHROPIC_API_KEY'),
        events,
        budget: night.budget,
      });
    } catch (err) {
      if (!(err instanceof LlmConfigError)) throw err;
    }
    const aiMode = !llm ? 'no_key' : (await readSavingMode(db, events)) ? 'saving' : 'on';
    const configured = await readRuntimeConfig(db)
      .then((c) => c.recommendMode)
      .catch(async (err: unknown) => {
        // 설정이 깨졌으면 기록하고 미리 계산한 방식으로(긴급 정지 확인은 작업 안에서 따로 막는다)
        await events.record({
          type: 'error',
          attrs: { code: errName(err), where: 'prewarmResults.recommend_mode' },
          outcome: 'error',
        });
        return 'precomputed' as const;
      });
    const mode = effectiveRecommendMode(configured, aiMode);
    const yt = createYouTubeRead({
      apiKey: secrets.YOUTUBE_API_KEY.value(),
      events,
      budget: firestoreYtBudget(db, 'ingest'),
    });
    const lastfmKey = optionalSecret('LASTFM_API_KEY');
    const ports = firestoreRecommendPorts({
      db,
      mb: createMusicBrainz(music),
      lb: createListenBrainz(music),
      wd: createWikidata(music),
      ...(lastfmKey
        ? { lastfm: createLastfm({ ...music, apiKey: lastfmKey, cache: firestoreLastfmCache(db) }) }
        : {}),
      yt,
      llm: llm ?? { structured: async () => null },
      events,
    });
    await runPrewarmResults({
      db,
      events,
      mode,
      deadlineMs,
      aiExhausted: night.exhausted,
      recommend: (req, spares) =>
        recommend(
          ports,
          req,
          { uid: 'job:prewarm' },
          {
            spares,
            mode,
            // 검색은 끈다: 영상 확인(videos)만 쓰고, 검색이 필요한 곡은 미리 만들지 않는다
            search: false,
            // 서비스 하루 AI 상한에 닿으면 만들기와 같이 절약 모드를 켠다
            ai: { mode: aiMode, onLimit: async () => void (await enterSavingMode(db, events)) },
          },
        ),
    });
  },
);
