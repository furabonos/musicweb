import { AggregateField, FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import baselineData from '../../../evals/baseline.json' with { type: 'json' };
import { nextPacificMidnight, pacificDay } from '../core/day.js';
import type { EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { addOpsLog } from '../core/opsLog.js';
import { readRuntimeConfig } from '../core/runtimeConfig.js';

/**
 * 현황판 지표 (SPEC 4.10, T21, D-042). 매일 05:30(태평양), 매일 시험(05:00) 뒤에 돈다.
 * - 이벤트는 개수·합계 집계(count·sum)로만 읽는다. 이벤트 내용(검색 문장 등은 애초에 없음)을 옮기지 않는다.
 * - 결과는 metrics/{day}와 metrics/current의 service·catalog에 쓴다. 누구나 읽는다(보안 규칙), 서버만 쓴다.
 * - 숫자마다 계산 방법(method, 영어 고정 문장)을 같이 쓴다. 분모가 0이면 값은 null(0%로 꾸미지 않음).
 * - 외부 호출이 없어 긴급 정지 대상이 아니다.
 */
export type MetricUnit = 'rate' | 'count' | 'score' | 'hours' | 'minutes' | 'usd';
export interface Metric {
  value: number | null;
  unit: MetricUnit;
  method: string;
}

const HOUR = 60 * 60 * 1000;
export const WINDOW_HOURS = 24;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ratio = (num: number, den: number) => (den > 0 ? r3(num / den) : null);

/** 지난 24시간 이벤트에서 센 숫자 */
export interface EventCounts {
  parsed: number;
  /** 해석 단계 실패만 (PARSE_STAGE_FAILURES). 기준 곡 실패는 request_parsed 뒤에 남아 같은 요청을 두 번 세므로 뺀다 */
  parseFailed: number;
  /** AI 고르기 단계에서 목록 밖이라 버린 곡의 합 */
  hallucinated: number;
  removed: number;
  /** 만든 재생목록의 곡 수 합 */
  songsShown: number;
  /** 곡 찾기(lookup) 단계까지 간 추천 횟수 */
  lookups: number;
  /** 그중 YouTube 검색을 하지 않은 횟수 (usedSearch == false) */
  searchFreeLookups: number;
  /** 만든 재생목록 중 AI를 부른 것 / 부르지 않은 것 (usedAi가 있는 기록만, T35) */
  createdWithAi: number;
  createdWithoutAi: number;
  /** AI 호출 비용 합 (microUSD) */
  aiCostMicroUsd: number;
}

/** 절약 모드가 켜지고 꺼진 기록 (saving_mode 이벤트) */
export interface SavingModeEvent {
  at: number;
  state: 'on' | 'off';
}

/**
 * [from, to) 동안 절약 모드였던 분 (T35, D-051).
 * - 켜짐 → 다음 꺼짐까지. 꺼짐 기록이 없으면 켜진 뒤 첫 태평양 자정까지(절약 모드는 자정에 저절로 꺼진다), 그 전에 to가 오면 to까지.
 * - 꺼짐 기록은 다음 요청 때 늦게 남을 수 있으므로, 구간 끝은 꺼짐 시각과 자정 중 이른 쪽이다(자정을 넘는 구간을 자른다).
 * - 창 밖에서 시작한 구간은 창 안 부분만 센다.
 */
export function savingModeMinutes(list: SavingModeEvent[], from: number, to: number): number {
  // 같은 시각이면 꺼짐을 먼저(전날 꺼짐과 새 켜짐이 같은 시각에 남아도 새 구간을 0분으로 만들지 않게)
  const sorted = [...list].sort((a, b) => a.at - b.at || (a.state === 'off' ? -1 : 1));
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const on = sorted[i];
    if (on?.state !== 'on') continue;
    const off = sorted.slice(i + 1).find((e) => e.state === 'off');
    const midnight = nextPacificMidnight(new Date(on.at)).getTime();
    const end = Math.min(off?.at ?? Infinity, midnight, to);
    const start = Math.max(on.at, from);
    if (end > start) total += end - start;
  }
  return Math.round(total / 60_000);
}

export function aiMetrics(
  c: Pick<EventCounts, 'createdWithAi' | 'createdWithoutAi' | 'aiCostMicroUsd'>,
  savingMinutes: number,
): Record<'aiFreeRate' | 'aiCostPerSet' | 'savingModeMinutes', Metric> {
  const sets = c.createdWithAi + c.createdWithoutAi;
  return {
    aiFreeRate: {
      value: ratio(c.createdWithoutAi, sets),
      unit: 'rate',
      method:
        'Sets made without calling AI (rules, saved results, or song picker) divided by all sets made in the last 24 hours.',
    },
    aiCostPerSet: {
      // 달러, 소수 여섯째 자리(1 microUSD)까지
      value: sets > 0 ? Math.round(c.aiCostMicroUsd / sets) / 1_000_000 : null,
      unit: 'usd',
      method:
        'All AI spending in the last 24 hours (including "More detail" and link checks) divided by sets made in the same 24 hours.',
    },
    savingModeMinutes: {
      value: savingMinutes,
      unit: 'minutes',
      method:
        'Minutes in the last 24 hours when simple mode was on because the daily AI cost limit was reached. Simple mode ends at midnight Pacific.',
    },
  };
}

/** 해석 단계(parseRequest)가 남기는 실패 이유 */
export const PARSE_STAGE_FAILURES = [
  'empty',
  'too_long',
  'no_output',
  'schema_invalid',
  'not_understood',
] as const;

export function serviceMetrics(
  c: EventCounts,
  extra: {
    eval: { fresh: boolean; matchingScore: number | null };
    recommendBaseline: { score: number; measuredAt: string } | null;
  },
): Record<
  | 'parseSuccessRate'
  | 'madeUpSongsFiltered'
  | 'officialLinkAccuracy'
  | 'removedSongRate'
  | 'recommendTestScore',
  Metric
> {
  const b = extra.recommendBaseline;
  return {
    parseSuccessRate: {
      value: ratio(c.parsed, c.parsed + c.parseFailed),
      unit: 'rate',
      method:
        'Requests the parser understood divided by all requests it read in the last 24 hours. Failures include empty or too-long requests.',
    },
    madeUpSongsFiltered: {
      value: c.hallucinated,
      unit: 'count',
      method:
        'Songs the AI suggested that were not in the candidate list, so the code dropped them, in the last 24 hours.',
    },
    officialLinkAccuracy: {
      value: extra.eval.fresh ? extra.eval.matchingScore : null,
      unit: 'score',
      method:
        "Today's song-matching test: share of the test songs where the rules pick the expected official video. Empty if the test did not run today.",
    },
    removedSongRate: {
      value: ratio(c.removed, c.songsShown),
      unit: 'rate',
      method:
        'Songs people removed in the last 24 hours divided by songs shown in sets made in the last 24 hours (removals from older sets also count).',
    },
    recommendTestScore: {
      value: b ? b.score : null,
      unit: 'score',
      method: b
        ? `Share of expected songs found in the recommendation test, last measured ${b.measuredAt.slice(0, 10)} (not run daily).`
        : 'Recommendation test has not been measured yet.',
    },
  };
}

type YtCounters = { ytUnits: number; ytSearchUser: number; ytSearchJob: number };

export function catalogMetrics(i: {
  playableSongs: number;
  previousPlayableSongs: number | null;
  lookups: number;
  searchFreeLookups: number;
  limits: YtCounters;
  usage: YtCounters;
}): Record<
  | 'playableSongs'
  | 'songsAdded'
  | 'searchFreeRate'
  | 'ytUnitsLeft'
  | 'ytUserSearchesLeft'
  | 'ytJobSearchesLeft',
  Metric
> {
  const left = (k: keyof YtCounters) => Math.max(0, i.limits[k] - i.usage[k]);
  return {
    playableSongs: {
      value: i.playableSongs,
      unit: 'count',
      method: 'Songs in the catalog with a checked, playable official video.',
    },
    songsAdded: {
      value: i.previousPlayableSongs === null ? null : i.playableSongs - i.previousPlayableSongs,
      unit: 'count',
      method:
        'Change in playable songs since the previous daily update (can be negative when old links are removed).',
    },
    searchFreeRate: {
      value: ratio(i.searchFreeLookups, i.lookups),
      unit: 'rate',
      method:
        'Sets whose videos were found without any YouTube search divided by all sets that reached the video-finding step, in the last 24 hours.',
    },
    ytUnitsLeft: {
      value: left('ytUnits'),
      unit: 'count',
      method:
        "YouTube API units left today (Pacific time) under the app's daily cap, at update time.",
    },
    ytUserSearchesLeft: {
      value: left('ytSearchUser'),
      unit: 'count',
      method: 'YouTube searches left today for user requests, at update time.',
    },
    ytJobSearchesLeft: {
      value: left('ytSearchJob'),
      unit: 'count',
      method: 'YouTube searches left today for nightly jobs, at update time.',
    },
  };
}

type BaselineFile = { suites: { recommend?: { score: number; measuredAt: string } } };

/** 지난 24시간 이벤트 숫자 (count·sum 집계) */
export async function gatherEventCounts(db: Firestore, now: Date): Promise<EventCounts> {
  const since = Timestamp.fromMillis(now.getTime() - WINDOW_HOURS * HOUR);
  const events = db.collection('events');
  const recent = (type: string) => events.where('type', '==', type).where('at', '>=', since);
  const count = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
  const sum = async (q: FirebaseFirestore.Query, field: string) =>
    Number((await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0);
  const step = (name: string) =>
    events
      .where('type', '==', 'recommend_step')
      .where('attrs.step', '==', name)
      .where('at', '>=', since);

  const created = (usedAi: boolean) =>
    count(
      events
        .where('type', '==', 'playlist_created')
        .where('attrs.usedAi', '==', usedAi)
        .where('at', '>=', since),
    );
  const [
    parsed,
    parseFailed,
    hallucinated,
    removed,
    songsShown,
    lookups,
    searchFreeLookups,
    createdWithAi,
    createdWithoutAi,
    aiCostMicroUsd,
  ] = await Promise.all([
    count(recent('request_parsed')),
    count(
      events
        .where('type', '==', 'request_parse_failed')
        .where('attrs.reason', 'in', [...PARSE_STAGE_FAILURES])
        .where('at', '>=', since),
    ),
    sum(step('ai_pick'), 'attrs.hallucinated'),
    count(recent('song_removed')),
    sum(recent('playlist_created'), 'attrs.songs'),
    count(step('lookup')),
    // usedSearch가 없는 옛 기록은 세지 않는다(false로 직접 셈)
    count(
      events
        .where('type', '==', 'recommend_step')
        .where('attrs.step', '==', 'lookup')
        .where('attrs.usedSearch', '==', false)
        .where('at', '>=', since),
    ),
    created(true),
    created(false),
    sum(
      events
        .where('type', '==', 'external_call')
        .where('attrs.target', '==', 'llm')
        .where('at', '>=', since),
      'attrs.costMicroUsd',
    ),
  ]);
  return {
    parsed,
    parseFailed,
    hallucinated,
    removed,
    songsShown,
    lookups,
    searchFreeLookups,
    createdWithAi,
    createdWithoutAi,
    aiCostMicroUsd,
  };
}

/** 절약 모드 기록: 창 시작 하루 전부터 읽는다(창 밖에서 켜진 구간을 잡으려고) */
export async function gatherSavingModeEvents(db: Firestore, now: Date): Promise<SavingModeEvent[]> {
  const since = Timestamp.fromMillis(now.getTime() - 2 * WINDOW_HOURS * HOUR);
  const snap = await db
    .collection('events')
    .where('type', '==', 'saving_mode')
    .where('at', '>=', since)
    .get();
  return snap.docs.flatMap((d) => {
    const at = d.get('at') as unknown;
    const state = d.get('attrs.state') as unknown;
    return at instanceof Timestamp && (state === 'on' || state === 'off')
      ? [{ at: at.toMillis(), state }]
      : [];
  });
}

export interface MetricsDeps {
  db: Firestore;
  events: EventSink;
  now?: () => Date;
}

export async function runMetrics(deps: MetricsDeps) {
  const { db, events } = deps;
  const now = (deps.now ?? (() => new Date()))();
  await events.record({ type: 'job_started', attrs: { job: 'metrics' }, outcome: 'ok' });
  try {
    const day = pacificDay(now);
    const yesterday = pacificDay(new Date(now.getTime() - WINDOW_HOURS * HOUR));
    const [c, saving, playable, prevDoc, currentDoc, usageDoc, config] = await Promise.all([
      gatherEventCounts(db, now),
      gatherSavingModeEvents(db, now),
      db.collectionGroup('links').where('status', '==', 'active').count().get(),
      db.doc(`metrics/${yesterday}`).get(),
      db.doc('metrics/current').get(),
      db.doc(`usage/${day}`).get(),
      readRuntimeConfig(db),
    ]);

    const evalDoc = currentDoc.get('eval') as
      { at?: Timestamp; matching?: { score?: number } } | undefined;
    const evalAt = evalDoc?.at instanceof Timestamp ? evalDoc.at.toMillis() : 0;
    const matchingScore = evalDoc?.matching?.score;
    const prev = prevDoc.get('catalog.playableSongs.value') as unknown;
    const usageNum = (k: keyof YtCounters) => {
      const v = usageDoc.get(k) as unknown;
      return typeof v === 'number' ? v : 0;
    };
    const svc = config.limits.service;

    const service = serviceMetrics(c, {
      eval: {
        fresh: evalAt >= now.getTime() - WINDOW_HOURS * HOUR,
        matchingScore: typeof matchingScore === 'number' ? matchingScore : null,
      },
      recommendBaseline: (baselineData as BaselineFile).suites.recommend ?? null,
    });
    const catalog = catalogMetrics({
      playableSongs: playable.data().count,
      previousPlayableSongs: typeof prev === 'number' ? prev : null,
      lookups: c.lookups,
      searchFreeLookups: c.searchFreeLookups,
      limits: {
        ytUnits: svc.ytUnits,
        ytSearchUser: svc.ytSearchUser,
        ytSearchJob: svc.ytSearchJob,
      },
      usage: {
        ytUnits: usageNum('ytUnits'),
        ytSearchUser: usageNum('ytSearchUser'),
        ytSearchJob: usageNum('ytSearchJob'),
      },
    });

    const ai = aiMetrics(
      c,
      savingModeMinutes(saving, now.getTime() - WINDOW_HOURS * HOUR, now.getTime()),
    );
    const doc = { updatedAt: FieldValue.serverTimestamp(), service, catalog, ai };
    const batch = db.batch();
    batch.set(db.doc(`metrics/${day}`), doc, { merge: true });
    batch.set(db.doc('metrics/current'), doc, { merge: true });
    await batch.commit();
    await events.record({
      type: 'job_finished',
      attrs: { job: 'metrics', processed: 1, failed: 0 },
      outcome: 'ok',
    });
    return { service, catalog, ai };
  } catch (err) {
    await events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'metrics.run' },
      outcome: 'error',
    });
    try {
      await addOpsLog(db, { kind: 'job_failed', message: 'Status numbers could not be updated.' });
    } catch {
      // 일지 저장 실패가 원래 오류를 가리지 않게
    }
    await events.record({
      type: 'job_finished',
      attrs: { job: 'metrics', processed: 0, failed: 1 },
      outcome: 'error',
    });
    throw err;
  }
}
