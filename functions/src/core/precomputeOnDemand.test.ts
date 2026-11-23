import { describe, expect, it } from 'vitest';
import { createOnDemand, needsTouch } from './precomputeOnDemand.js';

/** 요청 때 계산과 조회 시각 (T29, D-046) */
describe('createOnDemand', () => {
  it('같은 아티스트 동시 요청은 한 번만 계산하고 같은 결과를 받는다', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const od = createOnDemand(async (mbid) => {
      calls++;
      await gate;
      return `done:${mbid}`;
    });
    const a = od.ensure('a1');
    const b = od.ensure('a1');
    const c = od.ensure('a2');
    expect(od.running).toBe(2);
    release();
    expect(await Promise.all([a, b, c])).toEqual(['done:a1', 'done:a1', 'done:a2']);
    expect(calls).toBe(2);
    expect(od.running).toBe(0);
    // 끝난 뒤 다시 원하면 새로 계산한다
    await od.ensure('a1');
    expect(calls).toBe(3);
  });

  it('실패하면 기다리던 요청 모두 실패를 받고, 다음 요청은 다시 시도한다', async () => {
    let calls = 0;
    const od = createOnDemand(async () => {
      calls++;
      if (calls === 1) throw new Error('503');
      return 'ok';
    });
    await expect(Promise.all([od.ensure('x'), od.ensure('x')])).rejects.toThrow('503');
    expect(calls).toBe(1);
    expect(await od.ensure('x')).toBe('ok');
  });
});

describe('needsTouch', () => {
  const now = new Date('2026-11-23T20:00:00Z'); // 태평양 11-23 12:00
  it('같은 날(태평양) 두 번째 조회는 쓰지 않는다', () => {
    expect(needsTouch(new Date('2026-11-23T09:00:00Z'), now)).toBe(false); // 태평양 11-23 01:00
  });
  it('어제 또는 처음이면 쓴다', () => {
    expect(needsTouch(new Date('2026-11-23T07:00:00Z'), now)).toBe(true); // 태평양 11-22 23:00
    expect(needsTouch(null, now)).toBe(true);
  });
});
