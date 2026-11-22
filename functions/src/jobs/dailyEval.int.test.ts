import { beforeEach, describe, expect, it } from 'vitest';
import type { Llm } from '../adapters/llm.js';
import { pacificDay } from '../core/day.js';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { runDailyEval } from './dailyEval.js';

const db = emulatorDb();
beforeEach(clearFirestore);
const NOW = new Date('2026-11-22T20:00:00Z');

describe('dailyEval', () => {
  it('AI가 없으면 곡 연결 시험만 재고 metrics/{day}·current에 점수와 계산 방법을 씀', async () => {
    const ev = memoryEvents();
    await runDailyEval({ db, events: ev.sink, llm: null, now: () => NOW });
    for (const path of [`metrics/${pacificDay(NOW)}`, 'metrics/current']) {
      const e = (await db.doc(path).get()).get('eval');
      expect(e.matching).toMatchObject({ cases: 50, score: expect.any(Number) });
      expect(e.matching.method).toContain('50 song-matching');
      expect(e.parse).toMatchObject({ skipped: 'no AI key' });
    }
    expect(ev.events.at(-1)).toMatchObject({
      type: 'job_finished',
      attrs: { job: 'dailyEval', processed: 50, failed: 0 },
    });
  });

  it('AI가 있으면 요청 해석 시험도 재고, AI가 실패하면 그 시험만 빠지고 기록', async () => {
    const alwaysNull: Llm = { structured: async () => null };
    const r = await runDailyEval({
      db,
      events: memoryEvents().sink,
      llm: alwaysNull,
      now: () => NOW,
    });
    expect(r.parse).toMatchObject({ score: 0, cases: 20 });

    const broken: Llm = {
      structured: async () => {
        throw new Error('budget exceeded');
      },
    };
    const ev = memoryEvents();
    await runDailyEval({ db, events: ev.sink, llm: broken, now: () => NOW });
    const e = (await db.doc('metrics/current').get()).get('eval');
    expect(e.parse.skipped).toBe('error');
    expect(ev.events.find((x) => x.type === 'error')?.attrs).toEqual({
      code: 'error',
      where: 'dailyEval.parse',
    });
    expect(ev.events.at(-1)).toMatchObject({
      type: 'job_finished',
      outcome: 'error',
      attrs: { failed: 1 },
    });
  });

  it('시험 문항의 해석 결과는 운영 이벤트(request_parsed 등)로 남지 않음', async () => {
    const answer: Llm = {
      structured: async () => ({
        seed: null,
        count: null,
        include: { live: false, cover: false, remix: false },
        unsupported: [],
      }),
    };
    const ev = memoryEvents();
    await runDailyEval({ db, events: ev.sink, llm: answer, now: () => NOW });
    expect(ev.events.filter((x) => x.type.startsWith('request_'))).toEqual([]);
  });
});
