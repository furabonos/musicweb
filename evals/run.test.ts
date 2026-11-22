import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Llm } from '../functions/src/adapters/llm.js';
import { childEnv, cliArgs, parseCliOutput } from './claudeCli.js';
import { summarizeMatching, type MatchingCase } from './matching/score.js';
import {
  runRecommendCase,
  scorePicks,
  summarizeRecommend,
  type RecommendCase,
} from './recommend/score.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  compareToBaseline,
  EvalConfigError,
  main,
  nextBaseline,
  runAll,
  type Baseline,
} from './run.js';

const read = <T>(p: string) => JSON.parse(readFileSync(join(import.meta.dirname, p), 'utf8')) as T;

describe('기준 비교 (exit 코드)', () => {
  const base: Baseline = {
    suites: {
      matching: { score: 0.9, cases: 50, tolerance: 0 },
      parse: { score: 0.85, cases: 20, tolerance: 0.05 },
    },
  };

  it('기준보다 낮으면 실패(exit≠0), 같거나 높으면 통과', () => {
    expect(compareToBaseline({ matching: { score: 0.88, cases: 50 } }, base).ok).toBe(false);
    expect(compareToBaseline({ matching: { score: 0.9, cases: 50 } }, base).ok).toBe(true);
    expect(compareToBaseline({ matching: { score: 0.94, cases: 50 } }, base).ok).toBe(true);
  });

  it('AI 시험은 허용 폭(0.05)까지는 통과, 넘으면 실패', () => {
    expect(compareToBaseline({ parse: { score: 0.8, cases: 20 } }, base).ok).toBe(true);
    expect(compareToBaseline({ parse: { score: 0.79, cases: 20 } }, base).ok).toBe(false);
  });

  it('문제 수가 기준과 다르면 실패(틀리는 문제를 지워 통과하는 것을 막음)', () => {
    const r = compareToBaseline({ matching: { score: 1, cases: 49 } }, base);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('문제 수');
  });

  it('건너뛴 시험·기준 없는 시험은 비교하지 않음', () => {
    const r = compareToBaseline(
      { parse: { score: 0, cases: 0, skipped: 'no llm' }, recommend: { score: 0.1, cases: 20 } },
      base,
    );
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toContain('건너뜀');
    expect(r.lines.join('\n')).toContain('기준 없음');
  });

  it('기준 갱신은 이번에 잰 시험만 바꾸고 허용 폭을 붙임', () => {
    const next = nextBaseline(
      base,
      { matching: { score: 0.96, cases: 50 }, parse: { score: 0, cases: 0, skipped: 'x' } },
      'test',
      new Date('2026-11-22T00:00:00Z'),
    );
    expect(next.suites.matching).toEqual({
      score: 0.96,
      cases: 50,
      tolerance: 0,
      llm: 'none',
      measuredAt: '2026-11-22T00:00:00.000Z',
    });
    // 이번에 재지 않은 시험은 원래 기준(재던 방식 포함) 그대로
    expect(next.suites.parse).toEqual(base.suites.parse);
  });
});

describe('채점 계산 (손으로 계산한 값)', () => {
  it('곡 연결: 50문제 중 맞은 수 / 50, 소수 둘째 자리', () => {
    const results = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      correct: i < 43,
      pendingAi: i >= 47,
      got: null,
    }));
    expect(summarizeMatching(results)).toMatchObject({
      cases: 50,
      correct: 43,
      score: 0.86,
      pendingAi: 3,
    });
  });

  const c: RecommendCase = {
    id: 'r',
    genre: 'x',
    seed: { artist: 'A', title: 'Seed' },
    count: 5,
    pool: [
      { artist: 'D', title: 'd1', fits: false },
      { artist: 'F', title: 'f1', fits: true },
      { artist: 'D', title: 'd2', fits: false },
      { artist: 'F', title: 'f2', fits: true },
      { artist: 'D', title: 'd3', fits: false },
      { artist: 'F', title: 'f3', fits: true },
      { artist: 'D', title: 'd4', fits: false },
      { artist: 'F', title: 'f4', fits: true },
    ],
  };

  it('추천: 고른 5곡 중 어울리는 곡 3곡 → 0.6, 문제 평균', () => {
    const picked = ['f1', 'f2', 'd1', 'f3', 'd2'].map((t) => ({
      artist: t[0] === 'f' ? 'F' : 'D',
      title: t,
      reason: 'x',
    }));
    const one = scorePicks(c, picked);
    expect(one).toEqual({ id: 'r', score: 0.6, picked: 5, withReason: 5 });
    expect(summarizeRecommend([one, { ...one, id: 'r2', score: 1 }]).score).toBe(0.8);
  });

  it('추천 실제 흐름: AI가 어울리는 곡만 고르면 1.0, AI가 답을 못 하면 점수 순(미끼 먼저)이라 0.4', async () => {
    const pickFits: Llm = {
      structured: async (req) => {
        if (req.op !== 'llm.pick') return { songs: [] };
        const cands = req.input.candidates as { id: string; artist: string }[];
        return {
          picks: cands.filter((x) => x.artist === 'F').map((x) => ({ id: x.id, reason: 'fits' })),
        };
      },
    };
    expect((await runRecommendCase(c, pickFits)).score).toBe(0.8); // 어울리는 곡이 4개뿐 → 4/5
    const silent: Llm = { structured: async () => null };
    // 점수 순 앞 5곡 = d1 f1 d2 f2 d3 → 2/5
    expect((await runRecommendCase(c, silent)).score).toBe(0.4);
  });
});

describe('시험 문제 파일', () => {
  it('곡 연결 50문제: id가 겹치지 않고, 정답 영상은 그 문제의 후보 안에 있음', () => {
    const { cases } = read<{ cases: MatchingCase[] }>('matching/cases.json');
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(50);
    for (const c of cases) {
      if (c.expect.videoId)
        expect(
          c.videos.map((v) => v.videoId),
          c.id,
        ).toContain(c.expect.videoId);
    }
  });

  it('추천 20문제 이상: 문제마다 어울리는 곡이 요청 수 이상', () => {
    const { cases } = read<{ cases: RecommendCase[] }>('recommend/cases.json');
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases)
      expect(c.pool.filter((p) => p.fits).length).toBeGreaterThanOrEqual(c.count);
  });
});

describe('AI 없이 실행', () => {
  it('EVAL_LLM이 없으면 곡 연결만 재고 AI 시험은 건너뛴다고 남김', async () => {
    const { results, label } = await runAll({});
    expect(label).toBe('none');
    expect(results.matching?.cases).toBe(50);
    expect(results.parse?.skipped).toBeDefined();
    expect(results.recommend?.skipped).toBeDefined();
  });
});

describe('설정 오타는 실패 (몰래 건너뛰지 않음)', () => {
  it.each([{ EVAL_LLM: 'CLI' }, { EVAL_LLM: 'true' }, { EVAL_SUITES: 'match' }])(
    '%o → 오류',
    async (env) => {
      await expect(runAll(env)).rejects.toBeInstanceOf(EvalConfigError);
    },
  );
});

describe('main의 exit 코드', () => {
  const baselineFile = (score: number, cases = 50) => {
    const path = join(mkdtempSync(join(tmpdir(), 'eval-base-')), 'baseline.json');
    writeFileSync(path, JSON.stringify({ suites: { matching: { score, cases, tolerance: 0 } } }));
    return path;
  };
  const env = { EVAL_SUITES: 'matching' };

  it('기준보다 낮으면 1, 같거나 높으면 0', async () => {
    const actual = (await runAll(env)).results.matching?.score ?? 0;
    expect(await main(env, baselineFile(actual + 0.01))).toBe(1);
    expect(await main(env, baselineFile(actual))).toBe(0);
    expect(await main(env, baselineFile(actual - 0.1))).toBe(0);
  });

  it('EVAL_UPDATE_BASELINE=1이면 기준을 이번 결과로 쓰고 0', async () => {
    const path = baselineFile(1, 49);
    expect(await main({ ...env, EVAL_UPDATE_BASELINE: '1' }, path)).toBe(0);
    expect(await main(env, path)).toBe(0);
  });
});

describe('Claude Code(구독) 호출', () => {
  it('셸의 ANTHROPIC_API_KEY는 자식에게 넘기지 않음(구독 대신 API로 과금되지 않게)', () => {
    const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('도구 없이·설정 없이·Haiku로, 답 형식은 JSON 스키마', () => {
    const args = cliArgs('SYS', { type: 'object' });
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'claude-haiku-5-5']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(args).not.toContain('--bare');
  });

  it('출력에서 구조화 답을 꺼내고, 오류·깨진 출력은 null', () => {
    expect(parseCliOutput('{"structured_output":{"a":1},"total_cost_usd":0.0004}')).toEqual({
      value: { a: 1 },
      costUsd: 0.0004,
    });
    expect(parseCliOutput('{"is_error":true,"total_cost_usd":0}').value).toBeNull();
    expect(parseCliOutput('not json').value).toBeNull();
  });
});
