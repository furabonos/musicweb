import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreCase, summarize, type ParseCase } from './score.js';

/** 테스트용: 없으면 실패 */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('값이 없습니다');
  return v;
}

const { cases } = JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as {
  cases: ParseCase[];
};

/** 기대값을 그대로 돌려주는 "완벽한" 출력 */
const perfect = (c: ParseCase) => ({
  ok: true,
  value: {
    seed: c.expect.seed ?? null,
    count: c.expect.count ?? 10,
    include: c.expect.include ?? { live: false, cover: false, remix: false },
    unsupported: c.expect.unsupported ?? [],
  },
});

describe('요청 해석 시험 문제', () => {
  it('20문항, 한·영 10개씩, id 중복 없음', () => {
    expect(cases).toHaveLength(20);
    expect(cases.filter((c) => c.locale === 'ko')).toHaveLength(10);
    expect(new Set(cases.map((c) => c.id)).size).toBe(20);
    for (const c of cases) expect([...c.input].length, c.id).toBeLessThanOrEqual(200);
  });

  it('기대 곡 수는 코드가 맞춘 범위(5~30) 안', () => {
    for (const c of cases) {
      if (c.expect.count !== undefined) {
        expect(c.expect.count, c.id).toBeGreaterThanOrEqual(5);
        expect(c.expect.count, c.id).toBeLessThanOrEqual(30);
      }
    }
  });

  it('완벽한 출력은 전부 통과', () => {
    const r = summarize(cases.map((c) => ({ id: c.id, wrong: scoreCase(c, perfect(c)) })));
    expect(r).toEqual({ cases: 20, passed: 20, accuracy: 1, failedIds: [] });
  });
});

describe('scoreCase', () => {
  const c = must(cases.find((x) => x.id === 'en-04'));

  it('대소문자·문장부호는 무시', () => {
    const out = perfect(c);
    out.value.seed = { artist: 'daft punk', title: 'Get Lucky!' };
    expect(scoreCase(c, out)).toEqual([]);
  });

  it('틀린 필드만 알려 줌', () => {
    const out = perfect(c);
    out.value.seed = { artist: 'Daft Punk', title: 'One More Time' };
    out.value.include = { live: true, cover: true, remix: false };
    expect(scoreCase(c, out)).toEqual(['seed', 'include.live', 'include.remix']);
  });

  it('해석 실패는 parse_failed, 기준 곡이 null이어야 하는데 있으면 seed 틀림', () => {
    expect(scoreCase(c, { ok: false })).toEqual(['parse_failed']);
    const noSeed = must(cases.find((x) => x.id === 'ko-06'));
    const out = perfect(noSeed);
    out.value.seed = { artist: 'x', title: 'y' };
    expect(scoreCase(noSeed, out)).toEqual(['seed']);
  });

  it('unsupported는 기대 코드가 들어 있으면 통과', () => {
    const y = must(cases.find((x) => x.id === 'en-07'));
    const out = perfect(y);
    out.value.unsupported = ['mood', 'year'];
    expect(scoreCase(y, out)).toEqual([]);
    out.value.unsupported = [];
    expect(scoreCase(y, out)).toEqual(['unsupported']);
  });
});
