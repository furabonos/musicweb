import { describe, expect, it } from 'vitest';
import {
  detect,
  fingerprint,
  healthySignals,
  THRESHOLDS,
  type Finding,
  type Signals,
} from './detectors.js';

const base = (patch: Partial<Signals> = {}): Signals => ({ ...healthySignals(), ...patch });
const rules = (fs: Finding[]) => fs.map((f) => `${f.rule}:${f.key}`);

describe('detect: 정상이면 아무것도 없음', () => {
  it('모든 신호가 정상', () => {
    expect(detect(base())).toEqual([]);
  });
});

describe('제목 해석 실패', () => {
  it(`하루 ${THRESHOLDS.titleSplitFailed}건 이상이면 발생`, () => {
    const fs = detect(base({ titleSplitFailed: THRESHOLDS.titleSplitFailed }));
    expect(rules(fs)).toEqual(['title_split_failed:ingest']);
    expect(fs[0]?.facts).toMatchObject({ count: THRESHOLDS.titleSplitFailed });
  });
  it('그보다 적으면 미발생', () => {
    expect(detect(base({ titleSplitFailed: THRESHOLDS.titleSplitFailed - 1 }))).toEqual([]);
  });
});

describe('깨진 영상 연결 (퍼가기 불가 보고)', () => {
  it(`하루 ${THRESHOLDS.embedBlocked}건 이상이면 발생`, () => {
    expect(rules(detect(base({ embedBlocked: THRESHOLDS.embedBlocked })))).toEqual([
      'broken_link:embed_blocked',
    ]);
  });
  it('그보다 적으면 미발생', () => {
    expect(detect(base({ embedBlocked: THRESHOLDS.embedBlocked - 1 }))).toEqual([]);
  });
});

describe('공식 음원이 아닌 연결', () => {
  it('커버·기타 종류가 활성 연결이면 1건이라도 발생', () => {
    expect(rules(detect(base({ unofficialActiveLinks: 1 })))).toEqual(['unofficial_link:active']);
  });
  it('0건이면 미발생', () => {
    expect(detect(base({ unofficialActiveLinks: 0 }))).toEqual([]);
  });
});

describe('요청 해석 실패 급증', () => {
  it('실패가 최소 건수 이상이고 비율이 기준·평소 두 배를 넘으면 발생', () => {
    const fs = detect(base({ parse: { ok: 15, failed: 5, priorOk: 665, priorFailed: 35 } }));
    expect(rules(fs)).toEqual(['parse_failure_spike:request']);
    expect(fs[0]?.facts).toMatchObject({ failed: 5, total: 20, rate: 0.25, priorRate: 0.05 });
  });
  it('실패 건수가 적으면 비율이 높아도 미발생', () => {
    expect(
      detect(
        base({
          parse: { ok: 0, failed: THRESHOLDS.parseFailedMin - 1, priorOk: 0, priorFailed: 0 },
        }),
      ),
    ).toEqual([]);
  });
  it('비율이 20% 미만이면 미발생', () => {
    expect(detect(base({ parse: { ok: 95, failed: 5, priorOk: 0, priorFailed: 0 } }))).toEqual([]);
  });
  it('평소에도 그만큼 실패했으면(두 배 미만) 미발생', () => {
    expect(detect(base({ parse: { ok: 15, failed: 5, priorOk: 100, priorFailed: 30 } }))).toEqual(
      [],
    );
  });
});

describe('시험 점수 하락', () => {
  it('곡 연결 점수가 기준 − 허용 폭보다 낮으면 발생', () => {
    const fs = detect(
      base({
        eval: { fresh: true, matching: 0.96, parse: null },
        baseline: { matching: { score: 0.98, tolerance: 0 }, parse: null },
      }),
    );
    expect(rules(fs)).toEqual(['eval_drop:matching']);
    expect(fs[0]?.facts).toMatchObject({ suite: 'matching', score: 0.96, baseline: 0.98 });
  });
  it('허용 폭 안이면 미발생', () => {
    expect(
      detect(
        base({
          eval: { fresh: true, matching: 0.98, parse: 0.9 },
          baseline: {
            matching: { score: 0.98, tolerance: 0 },
            parse: { score: 0.95, tolerance: 0.05 },
          },
        }),
      ),
    ).toEqual([]);
  });
  it('요청 해석 점수도 따로 본다', () => {
    expect(
      rules(
        detect(
          base({
            eval: { fresh: true, matching: 0.98, parse: 0.8 },
            baseline: {
              matching: { score: 0.98, tolerance: 0 },
              parse: { score: 0.95, tolerance: 0.05 },
            },
          }),
        ),
      ),
    ).toEqual(['eval_drop:parse']);
  });
  it('오늘 잰 점수가 아니면(오래됨) 비교하지 않음 — 작업 실패 규칙이 따로 잡음', () => {
    expect(
      detect(
        base({
          eval: { fresh: false, matching: 0.5, parse: null },
          baseline: { matching: { score: 0.98, tolerance: 0 }, parse: null },
        }),
      ),
    ).toEqual([]);
  });
});

describe('YouTube에서 열기 링크 고장', () => {
  it('링크 확인 작업이 고장을 기록했으면 발생', () => {
    expect(rules(detect(base({ openLinkBroken: 1 })))).toEqual(['open_link_broken:watch_videos']);
  });
  it('기록이 없으면 미발생', () => {
    expect(detect(base({ openLinkBroken: 0 }))).toEqual([]);
  });
});

describe('예약 작업 실패', () => {
  it('실패로 끝난 실행이 있으면 작업마다 하나씩', () => {
    const fs = detect(
      base({
        jobs: {
          ingest: { started: 1, finished: 1, failedRuns: 1 },
          purge: { started: 1, finished: 1, failedRuns: 0 },
        },
      }),
    );
    expect(rules(fs)).toEqual(['job_failed:ingest']);
    expect(fs[0]?.facts).toMatchObject({ job: 'ingest', reason: 'failed', failed: 1 });
  });
  it('시작했는데 끝 기록이 없으면(중간에 죽음·시간 초과) 발생', () => {
    const fs = detect(base({ jobs: { refresh: { started: 1, finished: 0, failedRuns: 0 } } }));
    expect(rules(fs)).toEqual(['job_failed:refresh']);
    expect(fs[0]?.facts).toMatchObject({ reason: 'unfinished' });
  });
  it('링크 확인이 "고장 발견"으로 끝난 것은 링크 고장 이슈 하나만 (작업 실패로 또 열지 않음)', () => {
    const fs = detect(
      base({ openLinkBroken: 1, jobs: { linkHealth: { started: 1, finished: 1, failedRuns: 1 } } }),
    );
    expect(rules(fs)).toEqual(['open_link_broken:watch_videos']);
  });
  it('링크 확인 자체가 실패했으면(고장 기록 없음) 작업 실패', () => {
    const fs = detect(base({ jobs: { linkHealth: { started: 1, finished: 1, failedRuns: 1 } } }));
    expect(rules(fs)).toEqual(['job_failed:linkHealth']);
  });
  it('정상으로 끝났으면 미발생', () => {
    expect(detect(base({ jobs: { refresh: { started: 2, finished: 2, failedRuns: 0 } } }))).toEqual(
      [],
    );
  });
  it('연속 3회 실패해 멈춘 아티스트는 아티스트마다 하나씩', () => {
    const mbid = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
    const fs = detect(base({ failedArtists: [mbid, mbid] }));
    expect(rules(fs)).toEqual([`job_failed:artist-${mbid}`]);
    expect(fs[0]?.facts).toMatchObject({ job: 'ingest', artistMbid: mbid });
  });
});

describe('fingerprint', () => {
  it('같은 규칙·대상이면 같은 지문, 다르면 다른 지문 (숫자는 지문에 안 들어감)', () => {
    const a = fingerprint({ rule: 'job_failed', key: 'ingest', facts: { failed: 1 } });
    const b = fingerprint({ rule: 'job_failed', key: 'ingest', facts: { failed: 9 } });
    const c = fingerprint({ rule: 'job_failed', key: 'refresh', facts: { failed: 1 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
