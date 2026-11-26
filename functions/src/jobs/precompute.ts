import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { VOCAB_VERSION } from '@musicweb/shared/similarity';
import { SourceUnavailableError } from '../adapters/music-http.js';
import type { SimilarArtist } from '../adapters/listenbrainz.js';
import { BudgetExceededError } from '../core/budget.js';
import type { EventSink } from '../core/events.js';
import { errName, isOutage } from '../core/jobErrors.js';
import { addOpsLog } from '../core/opsLog.js';
import { assertEnabled, KillSwitchError, type ServiceCounter } from '../core/runtimeConfig.js';
import { firestoreTallyReader } from '../core/requestTally.js';
import { computeArtistVectors, type VectorPorts } from '../core/vectors.js';

/**
 * 비슷한 아티스트·숫자 묶음 미리 계산 (SPEC 3.3·4.3, T29, D-040·D-046). 매일 03:30(태평양), 수집(03:00) 뒤.
 * - 대상: 최근 조회된 아티스트 몇 명(artistVectors.lastRequestedAt 최근 순) 다음, 가장 오래 계산 안 된 아티스트 순
 *   (artistVectors.computedAt 오름차순, 한 번도 안 한 것(null)이 맨 앞). 돌아가며 모두에게 차례가 온다.
 *   artistVectors 문서는 요청(touchRequested)과 수집(곡이 늘면 songsChangedAt)이 만든다.
 * - 신선함: 30일 안에 같은 낱말 목록 버전으로 끝까지 계산했고, 그 뒤 수집이 곡을 더하지 않았음.
 * - 아티스트마다: 곡 숫자 묶음(T28, 곡 단위로 30일 재사용) → 끝까지 했으면 ListenBrainz 비슷한 아티스트 → artistSimilar.
 * - 처리량은 시간이 정한다: MusicBrainz 초당 1회 × 480초 ≈ 밤에 새로 묻는 곡 450개 정도. 아티스트당 한 밤에 50곡까지.
 * - 긴급 정지 ingest와 음악 데이터 호출 한도(musicDataCalls)를 따른다. 출처 장애·한도·마감 시간이면 멈추고 다음 밤에 이어 한다.
 */
export interface PrecomputePorts extends VectorPorts {
  similarArtists(mbid: string, limit: number): Promise<SimilarArtist[]>;
}

export interface PrecomputeDeps {
  db: Firestore;
  music: PrecomputePorts;
  events: EventSink;
  now?: () => Date;
  clock?: () => number;
  deadlineMs?: number;
  limits?: Partial<typeof PRECOMPUTE_LIMITS>;
}

export const PRECOMPUTE_LIMITS = {
  /** 한 밤에 볼 아티스트 수 위쪽(실제로는 시간이 먼저 닿는다) */
  maxArtists: 500,
  /** 많이 찾은 순(최근 30일 서로 다른 3명 이상, SPEC 4.3b)으로 맨 먼저 볼 아티스트 수 (T44) */
  popularFirst: 50,
  /** 그다음 최근 조회 순으로 볼 아티스트 수 (나머지는 오래 계산 안 된 순) */
  recentFirst: 20,
  similarArtists: 30,
  /** 밤 작업에서 아티스트 하나에 새로 물을 곡 수 (MusicBrainz 초당 1회라 시간이 곡 수에 비례) */
  songsPerArtist: 50,
  /** 다시 계산하는 주기 */
  staleDays: 30,
};

const DAY = 24 * 60 * 60 * 1000;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0);

export interface PrecomputeSummary {
  stoppedBy: 'killSwitch' | 'limit' | 'deadline' | 'outage' | null;
  artists: number;
  skipped: number;
  songs: number;
  failed: number;
}

/** 계산할 아티스트 순서: 많이 찾은 순(3명 이상) → 최근 조회 몇 명 → 가장 오래 계산 안 된 순. 중복 제거 */
async function targets(
  db: Firestore,
  L: { popularFirst: number; recentFirst: number; maxArtists: number },
  now: Date,
): Promise<string[]> {
  const { recentFirst, maxArtists: max } = L;
  const [popular, requested, oldest] = await Promise.all([
    firestoreTallyReader(db, () => now).topArtists(L.popularFirst),
    db.collection('artistVectors').orderBy('lastRequestedAt', 'desc').limit(recentFirst).get(),
    db.collection('artistVectors').orderBy('computedAt', 'asc').limit(max).get(),
  ]);
  const out: string[] = [];
  for (const id of [
    ...popular.map((a) => a.id),
    ...requested.docs.map((d) => d.id),
    ...oldest.docs.map((d) => d.id),
  ]) {
    if (MBID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 아티스트 하나 계산 (밤 작업·요청 때 계산이 같이 쓴다). 숫자 묶음을 끝까지 했을 때만 비슷한 아티스트를 받는다 */
export async function precomputeArtist(
  deps: { db: Firestore; music: PrecomputePorts },
  mbid: string,
  limits: { similarArtists: number; songsPerArtist: number } = PRECOMPUTE_LIMITS,
  opts: { pastDeadline?: () => boolean; now?: Date } = {},
): Promise<{ songs: number; complete: boolean }> {
  const r = await computeArtistVectors({ db: deps.db, mb: deps.music }, mbid, {
    maxSongs: limits.songsPerArtist,
    ...opts,
  });
  if (!r.complete) return { songs: r.songs, complete: false };
  const similar = await deps.music.similarArtists(mbid, limits.similarArtists);
  await deps.db.doc(`artistSimilar/${mbid}`).set({
    items: similar.map((a) => ({ artistMbid: a.mbid, score: a.score })),
    source: 'listenbrainz',
    // isFresh가 같은 시계(now)로 비교한다. 서버 시각을 쓰면 주입한 시각과 섞여 판정이 날짜에 따라 달라진다
    computedAt: opts.now ? Timestamp.fromDate(opts.now) : FieldValue.serverTimestamp(),
  });
  return { songs: r.songs, complete: true };
}

/** 신선함: 30일 안에 같은 버전으로 끝까지 계산했고, 그 뒤 수집이 곡을 더하지 않았다 */
export async function isFresh(db: Firestore, mbid: string, now: Date, staleDays: number) {
  const [sim, vec] = await Promise.all([
    db.doc(`artistSimilar/${mbid}`).get(),
    db.doc(`artistVectors/${mbid}`).get(),
  ]);
  const since = now.getTime() - staleDays * DAY;
  const computed = millis(vec.get('computedAt'));
  return (
    millis(sim.get('computedAt')) >= since &&
    computed >= since &&
    millis(vec.get('songsChangedAt')) <= computed &&
    vec.get('vocabVersion') === VOCAB_VERSION
  );
}

export async function runPrecompute(deps: PrecomputeDeps): Promise<PrecomputeSummary> {
  const { db, events } = deps;
  const L = { ...PRECOMPUTE_LIMITS, ...deps.limits };
  const now = (deps.now ?? (() => new Date()))();
  const clock = deps.clock ?? Date.now;
  const summary: PrecomputeSummary = {
    stoppedBy: null,
    artists: 0,
    skipped: 0,
    songs: 0,
    failed: 0,
  };

  const blocked = async () => {
    await events.record({
      type: 'kill_switch_blocked',
      attrs: { feature: 'ingest' },
      outcome: 'rejected',
    });
  };
  try {
    await assertEnabled(db, 'ingest');
  } catch (err) {
    if (!(err instanceof KillSwitchError)) throw err;
    await blocked();
    return { ...summary, stoppedBy: 'killSwitch' };
  }
  await events.record({ type: 'job_started', attrs: { job: 'precompute' }, outcome: 'ok' });

  const pastDeadline = () => deps.deadlineMs !== undefined && clock() >= deps.deadlineMs;
  for (const mbid of await targets(db, L, now)) {
    if (summary.artists >= L.maxArtists) break;
    if (pastDeadline()) {
      summary.stoppedBy = 'deadline';
      break;
    }
    if (await isFresh(db, mbid, now, L.staleDays)) {
      summary.skipped++;
      continue;
    }
    try {
      await assertEnabled(db, 'ingest');
      const r = await precomputeArtist({ db, music: deps.music }, mbid, L, { pastDeadline, now });
      summary.artists++;
      summary.songs += r.songs;
      // 아티스트 도중에 시간이 다 됐다: 여기까지 저장했고 다음 밤에 이어 한다
      if (!r.complete && pastDeadline()) {
        summary.stoppedBy = 'deadline';
        break;
      }
    } catch (err) {
      if (err instanceof KillSwitchError) {
        summary.stoppedBy = 'killSwitch';
        await blocked();
        break;
      }
      if (err instanceof BudgetExceededError) {
        summary.stoppedBy = 'limit';
        await events.record({
          type: 'limit_reached',
          attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
          outcome: 'rejected',
        });
        await addOpsLog(db, {
          kind: 'limit',
          message: `Precompute stopped: daily limit reached (${err.counter}). Resumes after the next reset.`,
        });
        break;
      }
      if (isOutage(err)) {
        summary.stoppedBy = 'outage';
        const source = err instanceof SourceUnavailableError ? err.source : 'unknown';
        await events.record({
          type: 'error',
          attrs: { code: errName(err), where: `precompute.${source}` },
          outcome: 'error',
        });
        break;
      }
      summary.failed++;
      await events.record({
        type: 'error',
        attrs: { code: errName(err), where: 'precompute.artist' },
        outcome: 'error',
      });
    }
  }

  const stop =
    summary.stoppedBy === 'deadline'
      ? ' Stopped at the time limit; continues tomorrow.'
      : summary.stoppedBy === 'outage'
        ? ' Stopped because a music data source was down.'
        : '';
  await addOpsLog(db, {
    kind: summary.failed ? 'job_failed' : 'job',
    message: `Precompute: ${summary.artists} artists updated (${summary.songs} songs), ${summary.skipped} still fresh, ${summary.failed} failed.${stop}`,
  });
  // 다른 작업과 같은 관례: 멈춤(한도·마감·장애·정지)은 rejected. 아무것도 못 하고 실패만 했으면 error(자동 이슈 대상)
  await events.record({
    type: 'job_finished',
    attrs: { job: 'precompute', processed: summary.artists, failed: summary.failed },
    outcome: summary.failed && !summary.artists ? 'error' : summary.stoppedBy ? 'rejected' : 'ok',
  });
  return summary;
}
