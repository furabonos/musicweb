import { compareKey } from '@musicweb/shared';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { SourceUnavailableError } from '../adapters/music-http.js';
import type { RecordingCandidate } from '../adapters/musicbrainz.js';
import { BudgetExceededError } from '../core/budget.js';
import { pacificDay } from '../core/day.js';
import type { EventSink } from '../core/events.js';
import { enqueueArtist } from '../core/ingestQueue.js';
import { errName, isOutage } from '../core/jobErrors.js';
import { addOpsLog } from '../core/opsLog.js';
import { firestoreTallyReader } from '../core/requestTally.js';
import { assertEnabled, KillSwitchError, type ServiceCounter } from '../core/runtimeConfig.js';

/**
 * 실패한 이름 다시 찾기 (SPEC 4.3b, T43, D-056). 수집(03:00) 앞에 돌아, 찾은 아티스트가 그날 밤 대기열에서 옮겨진다.
 *
 * - 대상: 서로 다른 3명이 찾았는데 곡 목록·MusicBrainz에서 못 찾아 이름이 저장된 실패 기록(사람 수 많은 순, 하룻밤 상한).
 * - MusicBrainz 녹음 검색으로 다시 찾는다. 같은 아티스트(비교 키)의 후보가 있으면 그 아티스트를 대기열에 넣는다.
 *   곡이 아직 MusicBrainz에 없어도 아티스트가 있으면 수집이 그 아티스트의 채널에서 곡을 가져올 수 있다.
 * - 찾으면 실패 기록을 지운다(이름을 더 둘 이유가 없다). 대기열 하루 상한에 걸리면 지우지 않고 다음 밤에 다시 한다.
 * - 이름이 저장된 지 30일 동안 못 찾으면 그만 찾고 이름을 지운다(gaveUp). 같은 날 이미 시도한 것은 건너뛴다.
 * - 긴급 정지 ingest·음악 데이터 호출 한도를 따른다. 운영 일지·이벤트에는 이름 없이 개수만 남긴다.
 * - 새 요청이 30일 동안 없는 이름은 목록(최근 30일 갱신)에서 빠지고 정리 작업(purge)이 문서째 지운다.
 * - 하룻밤 개수는 작업 안의 상수다(미리 계산 PRECOMPUTE_LIMITS와 같은 방식, D-056).
 */
export const RETRY_LIMITS = {
  /** 하룻밤 다시 찾을 이름 수(SPEC 6.3) */
  maxNames: 50,
  /** 이름이 저장된 뒤 이 날수 동안 못 찾으면 그만 */
  giveUpDays: 30,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetryPorts {
  searchRecordings(artist: string, title: string, limit?: number): Promise<RecordingCandidate[]>;
}

export interface RetryDeps {
  db: Firestore;
  events: EventSink;
  mb: RetryPorts;
  now?: () => Date;
  limits?: Partial<typeof RETRY_LIMITS>;
  deadlineMs?: number;
  clock?: () => number;
}

export interface RetrySummary {
  stoppedBy: 'limit' | 'killSwitch' | 'outage' | 'deadline' | null;
  tried: number;
  found: number;
  gaveUp: number;
  failed: number;
}

/** 같은 아티스트(비교 키)의 후보 중 MusicBrainz 아티스트 ID가 있는 첫 후보. 제목까지 같은 것을 앞에 둔다 */
export function matchArtist(
  candidates: RecordingCandidate[],
  label: { artist: string; title: string },
): { mbid: string; name: string } | null {
  const artist = compareKey(label.artist);
  const title = compareKey(label.title);
  const same = candidates.filter((c) => c.artistMbid && compareKey(c.artist) === artist);
  const best = same.find((c) => compareKey(c.title) === title) ?? same[0];
  return best?.artistMbid ? { mbid: best.artistMbid, name: best.artist } : null;
}

export async function runRetryFailedSeeds(deps: RetryDeps): Promise<RetrySummary> {
  const { db, events } = deps;
  const L = { ...RETRY_LIMITS, ...deps.limits };
  const now = (deps.now ?? (() => new Date()))();
  const clock = deps.clock ?? Date.now;
  const today = pacificDay(now);
  const summary: RetrySummary = { stoppedBy: null, tried: 0, found: 0, gaveUp: 0, failed: 0 };

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
  await events.record({
    type: 'job_started',
    attrs: { job: 'retryFailedSeeds' },
    outcome: 'ok',
  });

  // 오늘 이미 시도한 것은 상한에서 빼지 않도록 넉넉히 읽고 거른다
  const labels = (await firestoreTallyReader(db, () => now).failedLabels(L.maxNames * 2))
    .filter((f) => !f.lastTryAt || pacificDay(f.lastTryAt) !== today)
    .slice(0, L.maxNames);

  for (const f of labels) {
    if (deps.deadlineMs !== undefined && clock() >= deps.deadlineMs) {
      summary.stoppedBy = 'deadline';
      break;
    }
    const ref = db.doc(`failedSeedTally/${f.id}`);
    try {
      summary.tried++;
      const artist = matchArtist(
        await deps.mb.searchRecordings(f.label.artist, f.label.title, 5),
        f.label,
      );
      if (artist) {
        const queued = await enqueueArtist(db, artist, now);
        if (queued === 'daily_limit') {
          // 대기열이 오늘 다 찼다: 이름을 두고 다음 밤에 다시 한다
          await ref.update({ lastTryAt: Timestamp.fromDate(now) });
        } else {
          // 대기열에 넣었거나 이미 수집 대상·대기 중이다
          summary.found++;
          await ref.delete();
        }
        continue;
      }
      const since = f.labeledAt ?? now;
      if (now.getTime() - since.getTime() >= L.giveUpDays * DAY_MS) {
        summary.gaveUp++;
        await ref.update({ gaveUp: true, label: null, lastTryAt: Timestamp.fromDate(now) });
      } else {
        await ref.update({ lastTryAt: Timestamp.fromDate(now) });
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        summary.tried--;
        summary.stoppedBy = 'limit';
        await events.record({
          type: 'limit_reached',
          attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
          outcome: 'rejected',
        });
        break;
      }
      if (isOutage(err)) {
        summary.tried--;
        summary.stoppedBy = 'outage';
        const source = err instanceof SourceUnavailableError ? err.source : 'unknown';
        await events.record({
          type: 'error',
          attrs: { code: errName(err), where: `retryFailedSeeds.${source}` },
          outcome: 'error',
        });
        break;
      }
      summary.failed++;
      await events.record({
        type: 'error',
        attrs: { code: errName(err), where: 'retryFailedSeeds.name' },
        outcome: 'error',
      });
    }
  }

  const stop =
    summary.stoppedBy === 'limit'
      ? ' Stopped: daily music data limit reached.'
      : summary.stoppedBy === 'outage'
        ? ' Stopped because a music data source was down.'
        : summary.stoppedBy === 'deadline'
          ? ' Stopped at the time limit; continues tomorrow.'
          : '';
  await addOpsLog(db, {
    kind: summary.failed ? 'job_failed' : summary.stoppedBy === 'limit' ? 'limit' : 'job',
    message: `Retry failed names: ${summary.tried} tried, ${summary.found} found (artist queued or already collected), ${summary.gaveUp} given up, ${summary.failed} failed.${stop}`,
  });
  await events.record({
    type: 'job_finished',
    attrs: { job: 'retryFailedSeeds', processed: summary.tried, failed: summary.failed },
    outcome: summary.failed && !summary.found ? 'error' : summary.stoppedBy ? 'rejected' : 'ok',
  });
  return summary;
}
