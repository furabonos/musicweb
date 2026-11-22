import { createHash } from 'node:crypto';
import type { JOBS } from './events.js';

/**
 * 자동 이슈 감지 규칙 (SPEC 4.9, T19, D-037). 외부 접근 없는 순수 함수다.
 * - 입력(Signals)은 jobs/autoIssue.ts가 지난 24시간 기록(events)·곡 목록·시험 결과에서 숫자로만 모은다.
 * - 결과(Finding)는 규칙 이름, 대상 키, 숫자·ID 사실(facts)뿐이다. 검색 문장·재생목록 이름·계정 정보가 들어갈 자리가 없다.
 * - 같은 문제는 같은 지문(rule + key)이 되어 GitHub에서 한 이슈로 묶인다(adapters/github.ts).
 */
export const RULES = [
  'title_split_failed', // 제목 해석 실패
  'broken_link', // 깨진 영상 연결 (재생 중 퍼가기 불가 보고)
  'unofficial_link', // 공식 음원이 아닌 연결
  'parse_failure_spike', // 요청 해석 실패 급증
  'eval_drop', // 시험 점수 하락
  'open_link_broken', // YouTube에서 열기 링크 고장
  'job_failed', // 예약 작업 실패
] as const;
export type Rule = (typeof RULES)[number];

export type JobName = (typeof JOBS)[number];

export interface JobRuns {
  started: number;
  finished: number;
  /** job_finished가 error로 끝난 횟수 */
  failedRuns: number;
}

export interface ScoreBaseline {
  score: number;
  tolerance: number;
}

/** 지난 24시간(parse의 prior*는 그 앞 7일) 숫자 신호 */
export interface Signals {
  /** 수집 중 영상 제목에서 아티스트·곡 제목을 나누지 못한 횟수 */
  titleSplitFailed: number;
  /** 재생 중 퍼가기 불가(101·150) 보고 */
  embedBlocked: number;
  /** 활성 연결 중 커버·기타 종류 (규칙상 연결되면 안 됨) */
  unofficialActiveLinks: number;
  parse: { ok: number; failed: number; priorOk: number; priorFailed: number };
  /** metrics/current.eval. fresh: 지난 24시간 안에 잰 값인가 */
  eval: { fresh: boolean; matching: number | null; parse: number | null };
  baseline: { matching: ScoreBaseline | null; parse: ScoreBaseline | null };
  /** linkHealth가 남긴 open_link_broken 오류 */
  openLinkBroken: number;
  jobs: Partial<Record<JobName, JobRuns>>;
  /** 연속 3회 실패로 failed가 된 아티스트 MBID (공개 음악 데이터 ID) */
  failedArtists: string[];
}

export type FactValue = number | string;
export interface Finding {
  rule: Rule;
  /** 같은 규칙 안에서 문제를 구분하는 키 (작업 이름, 시험 이름 등). 지문에 들어간다. */
  key: string;
  facts: Record<string, FactValue>;
}

/** 기준값. 바꾸면 detectors.test.ts와 D-037을 같이 고친다. */
export const THRESHOLDS = {
  titleSplitFailed: 10,
  /**
   * 퍼가기 불가 보고는 로그인 없이 부를 수 있다(App Check는 T23). 몇 번만 불러 이슈를 열 수 없게 높게 둔다.
   * 연결 상태는 야간 재확인(T11)이 따로 고친다. 실제 수치를 보고 다시 정한다(D-037).
   */
  embedBlocked: 20,
  parseFailedMin: 5,
  parseRateMin: 0.2,
  /** 평소(앞 7일) 실패율의 몇 배 이상이면 급증인가 */
  parseSpikeFactor: 2,
} as const;

const round = (x: number) => Math.round(x * 1000) / 1000;

export function healthySignals(): Signals {
  return {
    titleSplitFailed: 0,
    embedBlocked: 0,
    unofficialActiveLinks: 0,
    parse: { ok: 0, failed: 0, priorOk: 0, priorFailed: 0 },
    eval: { fresh: true, matching: null, parse: null },
    baseline: { matching: null, parse: null },
    openLinkBroken: 0,
    jobs: {},
    failedArtists: [],
  };
}

export function detect(s: Signals): Finding[] {
  const out: Finding[] = [];

  if (s.titleSplitFailed >= THRESHOLDS.titleSplitFailed) {
    out.push({
      rule: 'title_split_failed',
      key: 'ingest',
      facts: { count: s.titleSplitFailed, threshold: THRESHOLDS.titleSplitFailed },
    });
  }

  if (s.embedBlocked >= THRESHOLDS.embedBlocked) {
    out.push({
      rule: 'broken_link',
      key: 'embed_blocked',
      facts: { count: s.embedBlocked, threshold: THRESHOLDS.embedBlocked },
    });
  }

  if (s.unofficialActiveLinks > 0) {
    out.push({ rule: 'unofficial_link', key: 'active', facts: { count: s.unofficialActiveLinks } });
  }

  const p = s.parse;
  const total = p.ok + p.failed;
  const priorTotal = p.priorOk + p.priorFailed;
  const rate = total ? p.failed / total : 0;
  const priorRate = priorTotal ? p.priorFailed / priorTotal : 0;
  if (
    p.failed >= THRESHOLDS.parseFailedMin &&
    rate >= Math.max(THRESHOLDS.parseRateMin, THRESHOLDS.parseSpikeFactor * priorRate)
  ) {
    out.push({
      rule: 'parse_failure_spike',
      key: 'request',
      facts: { failed: p.failed, total, rate: round(rate), priorRate: round(priorRate) },
    });
  }

  if (s.eval.fresh) {
    for (const suite of ['matching', 'parse'] as const) {
      const score = s.eval[suite];
      const base = s.baseline[suite];
      if (score === null || !base) continue;
      if (score < base.score - base.tolerance - 1e-9) {
        out.push({
          rule: 'eval_drop',
          key: suite,
          facts: { suite, score, baseline: base.score, tolerance: base.tolerance },
        });
      }
    }
  }

  if (s.openLinkBroken > 0) {
    out.push({
      rule: 'open_link_broken',
      key: 'watch_videos',
      facts: { count: s.openLinkBroken },
    });
  }

  for (const [job, r] of Object.entries(s.jobs) as [JobName, JobRuns][]) {
    // 링크 확인이 "확인했더니 고장"으로 끝난 것은 위 링크 고장 이슈 하나로 충분하다(같은 문제로 이슈 2개 금지)
    const failedRuns =
      job === 'linkHealth' ? Math.max(0, r.failedRuns - s.openLinkBroken) : r.failedRuns;
    if (failedRuns > 0) {
      out.push({
        rule: 'job_failed',
        key: job,
        facts: { job, reason: 'failed', failed: failedRuns, started: r.started },
      });
    } else if (r.started > r.finished) {
      out.push({
        rule: 'job_failed',
        key: job,
        facts: { job, reason: 'unfinished', started: r.started, finished: r.finished },
      });
    }
  }

  for (const mbid of new Set(s.failedArtists)) {
    out.push({
      rule: 'job_failed',
      key: `artist-${mbid}`,
      facts: { job: 'ingest', reason: 'artist_failed', artistMbid: mbid },
    });
  }

  return out;
}

/** 같은 문제 = 같은 규칙과 대상. 숫자(facts)는 날마다 달라도 같은 이슈로 묶인다. */
export function fingerprint(f: Finding | Pick<Finding, 'rule' | 'key'>): string {
  return createHash('sha256').update(`${f.rule}:${f.key}`).digest('hex').slice(0, 16);
}
