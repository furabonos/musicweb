import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { SourceUnavailableError } from '../adapters/music-http.js';
import type { LlmBudget } from '../adapters/llm.js';
import { BudgetExceededError } from '../core/budget.js';
import type { EventSink } from '../core/events.js';
import { errName, isOutage } from '../core/jobErrors.js';
import { addOpsLog } from '../core/opsLog.js';
import type { ParsedRequest } from '../core/parseRequest.js';
import { SPARES } from '../core/playlists.js';
import type { RecommendResult } from '../core/recommend.js';
import { firestoreTallyReader } from '../core/requestTally.js';
import { resultCacheKey, withResultCache } from '../core/resultCache.js';
import { assertEnabled, KillSwitchError, type ServiceCounter } from '../core/runtimeConfig.js';

/**
 * 재생목록 미리 만들기 (SPEC 4.3b, T44, D-056). 미리 계산(03:30) 뒤 03:45.
 *
 * - 대상: 최근 30일 서로 다른 3명 이상이 찾은 기준 곡, 사람 수 많은 순, 하룻밤 최대 50곡.
 * - 기본 조합(10곡, 조건 없음)을 실제로 요청된 화면 언어마다 만들어 저장된 결과(resultCache, 7일)에 채운다.
 *   만들기 요청이 같은 조합이면 추천을 다시 계산하지 않는다. 영상 ID는 저장하지 않는다(resultCache 규칙 그대로).
 * - 저장된 결과가 없거나 하루 안에 만료될 것만 만든다.
 * - 지금 추천 방식(recommendMode, 키 없음·절약 모드면 미리 계산)을 따른다. AI를 쓰면 밤 AI 몫(서비스 한도
 *   prewarmAiMicroUsd, 관리자 화면에서 변경) 안에서만, 다 쓰면 그날은 멈춘다. YouTube 검색은 하지 않는다.
 * - 긴급 정지 ingest·호출 한도를 따른다. 운영 일지에는 개수만.
 * - 하룻밤 곡 수(50)는 작업 안의 상수다(미리 계산과 같은 방식, D-056).
 */
export const PREWARM_LIMITS = {
  /** 하룻밤 미리 만들 기준 곡 수(SPEC 6.3) */
  maxSeeds: 50,
  /** 이보다 늦게 만료되는 저장된 결과는 다시 만들지 않는다 */
  refreshWithinMs: 24 * 60 * 60 * 1000,
};
/** 기본 조합: 곡 고르기 화면과 검색창의 기본 곡 수(SPEC 4.2) */
const DEFAULT_COUNT = 10;
const NO_INCLUDE = { live: false, cover: false, remix: false };

/**
 * 밤 AI 몫을 다 썼는지 지켜본다. 예약(firestorePrewarmLlmBudget)이 밤 몫(prewarmAiMicroUsd)이나 서비스 하루 AI 비용
 * (aiCostMicroUsd) 상한에 닿아 거부하면 표시하고 그대로 던진다. 추천은 이 오류를 잡아 AI 없이 고르므로
 * (AI 방식에서는 저장 안 됨) 작업이 이 표시를 보고 멈춘다.
 */
export function nightAiBudget(inner: LlmBudget) {
  let exhausted = false;
  const budget: LlmBudget = {
    async run(maxMicroUsd, fn) {
      try {
        return await inner.run(maxMicroUsd, fn);
      } catch (err) {
        if (err instanceof BudgetExceededError) exhausted = true;
        throw err;
      }
    },
  };
  return { budget, exhausted: () => exhausted };
}

export interface PrewarmDeps {
  db: Firestore;
  events: EventSink;
  /** 지금 쓰는 추천 방식. 저장된 결과의 키에 들어간다 */
  mode: 'ai' | 'precomputed';
  /** 추천 계산(작업이 조립: AI 몫·검색 끔). 저장은 이 작업이 한다 */
  recommend(req: ParsedRequest, spares: number): Promise<RecommendResult>;
  /** 밤 AI 몫을 다 썼나(nightAiBudget.exhausted) */
  aiExhausted?: () => boolean;
  now?: () => Date;
  limits?: Partial<typeof PREWARM_LIMITS>;
  deadlineMs?: number;
  clock?: () => number;
}

export interface PrewarmSummary {
  stoppedBy: 'limit' | 'killSwitch' | 'outage' | 'deadline' | null;
  /** 새로 저장한 결과 수 */
  made: number;
  /** 저장된 결과가 아직 충분히 남아 건너뛴 수 */
  fresh: number;
  /** 추천은 했지만 저장하지 않은 수(곡 모자람, 기준 곡 못 찾음, AI 방식인데 AI 없이 고름) */
  skipped: number;
  failed: number;
}

export async function runPrewarmResults(deps: PrewarmDeps): Promise<PrewarmSummary> {
  const { db, events } = deps;
  const L = { ...PREWARM_LIMITS, ...deps.limits };
  const now = (deps.now ?? (() => new Date()))();
  const clock = deps.clock ?? Date.now;
  const summary: PrewarmSummary = { stoppedBy: null, made: 0, fresh: 0, skipped: 0, failed: 0 };

  try {
    await assertEnabled(db, 'ingest');
  } catch (err) {
    if (!(err instanceof KillSwitchError)) throw err;
    await events.record({
      type: 'kill_switch_blocked',
      attrs: { feature: 'ingest' },
      outcome: 'rejected',
    });
    return { ...summary, stoppedBy: 'killSwitch' };
  }
  await events.record({ type: 'job_started', attrs: { job: 'prewarmResults' }, outcome: 'ok' });

  const cached = withResultCache(
    { db, mode: deps.mode, now: () => now, events, skipRead: true },
    deps.recommend,
  );
  const seeds = await firestoreTallyReader(db, () => now).topSongs(L.maxSeeds);

  outer: for (const s of seeds) {
    const song = await db.doc(`songs/${s.id}`).get();
    const artist = song.get('artist') as unknown;
    const title = song.get('title') as unknown;
    // 정보가 적은 곡(이름 없음)이나 지워진 곡은 건너뛴다
    if (typeof artist !== 'string' || typeof title !== 'string' || !artist || !title) continue;
    for (const locale of s.locales) {
      if (deps.deadlineMs !== undefined && clock() >= deps.deadlineMs) {
        summary.stoppedBy = 'deadline';
        break outer;
      }
      const req: ParsedRequest = {
        seed: { artist, title },
        count: DEFAULT_COUNT,
        include: NO_INCLUDE,
        locale,
        unsupported: [],
      };
      const key = resultCacheKey(req, deps.mode);
      if (!key) continue;
      const exp = (await db.doc(`resultCache/${key}`).get()).get('expiresAt') as unknown;
      if (exp instanceof Timestamp && exp.toMillis() > now.getTime() + L.refreshWithinMs) {
        summary.fresh++;
        continue;
      }
      try {
        const rec = await cached(req, SPARES);
        // withResultCache가 저장하는 조건과 같다
        const kept =
          rec.ok &&
          rec.items.length > 0 &&
          !rec.shortfall &&
          !(deps.mode === 'ai' && rec.pickedBy !== 'ai');
        if (kept) summary.made++;
        else summary.skipped++;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          summary.stoppedBy = 'limit';
          await events.record({
            type: 'limit_reached',
            attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
            outcome: 'rejected',
          });
          break outer;
        }
        if (isOutage(err)) {
          summary.stoppedBy = 'outage';
          const source = err instanceof SourceUnavailableError ? err.source : 'unknown';
          await events.record({
            type: 'error',
            attrs: { code: errName(err), where: `prewarmResults.${source}` },
            outcome: 'error',
          });
          break outer;
        }
        summary.failed++;
        await events.record({
          type: 'error',
          attrs: { code: errName(err), where: 'prewarmResults.seed' },
          outcome: 'error',
        });
      }
      // 추천은 AI 몫 초과를 잡아 AI 없이 고르므로(저장 안 됨) 여기서 몫을 보고 멈춘다
      if (deps.aiExhausted?.()) {
        summary.stoppedBy = 'limit';
        break outer;
      }
    }
  }

  const stop =
    summary.stoppedBy === 'limit'
      ? ' Stopped: nightly limit reached.'
      : summary.stoppedBy === 'outage'
        ? ' Stopped because a music data source was down.'
        : summary.stoppedBy === 'deadline'
          ? ' Stopped at the time limit; continues tomorrow.'
          : '';
  await addOpsLog(db, {
    kind: summary.failed ? 'job_failed' : summary.stoppedBy === 'limit' ? 'limit' : 'job',
    message: `Prewarm: ${summary.made} sets made, ${summary.fresh} still fresh, ${summary.skipped} not stored, ${summary.failed} failed.${stop}`,
  });
  await events.record({
    type: 'job_finished',
    attrs: { job: 'prewarmResults', processed: summary.made, failed: summary.failed },
    outcome: summary.failed && !summary.made ? 'error' : summary.stoppedBy ? 'rejected' : 'ok',
  });
  return summary;
}
