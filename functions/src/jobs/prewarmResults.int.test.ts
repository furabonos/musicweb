import { DEMO_SEED, DEMO_SONGS } from '@musicweb/shared/demo';
import { firestorePrewarmLlmBudget } from '../adapters/llm.js';
import { recommend, type RecommendPorts } from '../core/recommend.js';
import { firestoreRecommendPorts } from '../core/recommendPorts.js';
import { fakeLlm, fakeMusicAndYt } from '../dev/fakeWorld.js';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../core/budget.js';
import type { ParsedRequest } from '../core/parseRequest.js';
import type { RecommendResult } from '../core/recommend.js';
import { resultCacheKey, withResultCache } from '../core/resultCache.js';
import { seedDemoCatalog } from '../testing/demoCatalog.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import {
  nightAiBudget,
  PREWARM_LIMITS,
  runPrewarmResults,
  type PrewarmDeps,
} from './prewarmResults.js';

/** 재생목록 미리 만들기 (SPEC 4.3b, T44, D-056). 가짜 곡 목록 + 가짜 추천 함수 */
const db = emulatorDb();
const NOW = new Date('2026-11-26T11:45:00Z'); // 태평양 2026-11-26 03:45
const DAY = '2026-11-26';
beforeEach(async () => {
  await clearFirestore();
  await seedDemoCatalog(db, NOW);
});

const [SEED, SEED2, SEED3, ...REST] = DEMO_SONGS;
if (!SEED || !SEED2 || !SEED3) throw new Error('가짜 곡이 모자랍니다.');

/** 3명이 찾은 기준 곡 */
async function popular(song: (typeof DEMO_SONGS)[number], people = 3, locales = ['en']) {
  await db.doc(`requestTally/song_${song.mbid}`).set({
    kind: 'song',
    id: song.mbid,
    days: { [DAY]: people },
    locales: Object.fromEntries(locales.map((l) => [l, { [DAY]: people }])),
    updatedAt: Timestamp.fromDate(NOW),
  });
}

const req = (song: (typeof DEMO_SONGS)[number], locale: 'en' | 'ko' = 'en'): ParsedRequest => ({
  seed: { artist: song.artist, title: song.title },
  count: 10,
  include: { live: false, cover: false, remix: false },
  locale,
  unsupported: [],
});

/** 가짜 추천: 기준 곡 말고 15곡(10 + 예비 5). 부를 때마다 기록 */
function fakeRecommend(mode: 'ai' | 'precomputed' = 'precomputed') {
  const calls: string[] = [];
  const fn = async (r: ParsedRequest): Promise<RecommendResult> => {
    calls.push(`${r.seed?.title}|${r.locale}`);
    const seed = DEMO_SONGS.find((s) => s.title === r.seed?.title);
    if (!seed) return { ok: false, reason: 'seed_not_found' };
    return {
      ok: true,
      seed: {
        songId: seed.mbid,
        artistMbid: seed.artistMbid,
        artist: seed.artist,
        title: seed.title,
      },
      items: DEMO_SONGS.filter((s) => s.mbid !== seed.mbid)
        .slice(0, 15)
        .map((s) => ({
          songId: s.mbid,
          artist: s.artist,
          title: s.title,
          releaseYear: s.releaseYear,
          videoId: s.videoId,
          kind: 'official_audio' as const,
          madeForKids: false,
          reason: `because ${r.locale}`,
        })),
      shortfall: null,
      pickedBy: mode === 'ai' ? 'ai' : 'rule',
    };
  };
  return { calls, fn };
}

function run(over: Partial<PrewarmDeps> = {}, rec = fakeRecommend()) {
  const ev = memoryEvents();
  return {
    rec,
    events: ev.events,
    run: runPrewarmResults({
      db,
      events: ev.sink,
      mode: 'precomputed',
      recommend: rec.fn,
      now: () => NOW,
      ...over,
    }),
  };
}

/** 실제 recommend + 가짜 음악 데이터·AI(만들기 함수의 가짜 모드와 같은 조립). AI 예약은 실제 Firestore 카운터 */
async function runWithRealRecommend() {
  await popular(DEMO_SEED, 5);
  await popular(DEMO_SONGS[1] ?? DEMO_SEED, 4);
  const ev = memoryEvents();
  const night = nightAiBudget(firestorePrewarmLlmBudget(db));
  const base = firestoreRecommendPorts({
    db,
    mb: {} as never,
    lb: {} as never,
    wd: {} as never,
    yt: {} as never,
    llm: fakeLlm(night.budget),
    events: ev.sink,
    now: () => NOW,
  });
  const ports: RecommendPorts = {
    ...base,
    ...fakeMusicAndYt(),
    officialChannels: async () => [],
    now: () => NOW,
  };
  let recommendCalls = 0;
  let savingModeCalls = 0;
  const summary = await runPrewarmResults({
    db,
    events: ev.sink,
    mode: 'ai',
    now: () => NOW,
    aiExhausted: night.exhausted,
    recommend: (q, spares) => {
      recommendCalls++;
      return recommend(
        ports,
        q,
        { uid: 'job:prewarm' },
        {
          spares,
          mode: 'ai',
          search: false,
          ai: { mode: 'on', onLimit: async () => void savingModeCalls++ },
        },
      );
    },
  });
  return { summary, recommendCalls, savingModeCalls };
}

describe('runPrewarmResults', () => {
  it('기본 상한(50곡)을 넘는 인기 곡이 있어도 50곡까지만', async () => {
    const many = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`,
    );
    for (const id of many) {
      await db.doc(`songs/${id}`).set({ artist: `A${id}`, title: `T${id}` });
      await db.doc(`requestTally/song_${id}`).set({
        kind: 'song',
        id,
        days: { [DAY]: 3 },
        locales: { en: { [DAY]: 3 } },
        updatedAt: Timestamp.fromDate(NOW),
      });
    }
    const r = run();
    await r.run;
    expect(r.rec.calls).toHaveLength(PREWARM_LIMITS.maxSeeds);
  });

  it('미리 만든 뒤 같은 조합 요청은 추천 계산 없이 같은 곡, 저장된 결과에 영상 ID 없음', async () => {
    await popular(SEED);
    const r = run();
    expect(await r.run).toMatchObject({ stoppedBy: null, made: 1, fresh: 0 });

    const spy = fakeRecommend();
    const later = withResultCache({ db, mode: 'precomputed', now: () => NOW }, spy.fn);
    const out = await later(req(SEED), 5);
    expect(spy.calls).toEqual([]);
    expect(out.ok && out.fromCache).toBe(true);
    expect(out.ok && out.items.slice(0, 10).map((i) => i.songId)).toEqual(
      DEMO_SONGS.filter((s) => s.mbid !== SEED.mbid)
        .slice(0, 10)
        .map((s) => s.mbid),
    );
    const stored = JSON.stringify(
      (await db.collection('resultCache').get()).docs.map((d) => d.data()),
    );
    expect(stored).not.toContain('videoId');
    expect(stored).not.toContain(SEED.videoId);
  });

  it('실제로 요청된 언어마다 만든다', async () => {
    await popular(SEED, 3, ['en', 'ko']);
    const r = run();
    expect((await r.run).made).toBe(2);
    expect(r.rec.calls.sort()).toEqual([`${SEED.title}|en`, `${SEED.title}|ko`]);
    for (const l of ['en', 'ko'] as const) {
      const key = resultCacheKey(req(SEED, l), 'precomputed');
      expect((await db.doc(`resultCache/${key}`).get()).exists).toBe(true);
    }
  });

  it('만료가 먼 결과는 다시 만들지 않고, 하루 안에 만료되는 것은 다시 만든다', async () => {
    await popular(SEED);
    await run().run;
    const again = run();
    expect(await again.run).toMatchObject({ made: 0, fresh: 1 });
    expect(again.rec.calls).toEqual([]);

    const key = resultCacheKey(req(SEED), 'precomputed');
    await db.doc(`resultCache/${key}`).update({
      expiresAt: Timestamp.fromMillis(NOW.getTime() + DAY_MS / 2),
    });
    const soon = run();
    expect((await soon.run).made).toBe(1);
    expect(soon.rec.calls).toHaveLength(1);
  });

  it('2명이 찾은 곡은 만들지 않고, 상한만큼 사람 수 많은 순으로', async () => {
    await popular(SEED, 3);
    await popular(SEED2, 5);
    await popular(SEED3, 4);
    if (REST[0]) await popular(REST[0], 2);
    const r = run({ limits: { maxSeeds: 2 } });
    expect((await r.run).made).toBe(2);
    expect(r.rec.calls).toEqual([`${SEED2.title}|en`, `${SEED3.title}|en`]);
  });

  it('AI 방식인데 밤 AI 몫을 다 쓰면 그 자리에서 멈춘다(실제 추천 + 가짜 AI, 몫 0)', async () => {
    await db.doc('config/runtime').set({ limits: { service: { prewarmAiMicroUsd: 0 } } });
    const out = await runWithRealRecommend();
    expect(out.summary).toMatchObject({ stoppedBy: 'limit', made: 0 });
    expect(out.recommendCalls).toBe(1); // 첫 곡에서 몫이 없어 멈춤
    expect((await db.collection('resultCache').get()).size).toBe(0);
    expect(out.savingModeCalls).toBe(0); // 밤 몫은 서비스 절약 모드를 켜지 않는다
  });

  it('서비스 하루 AI 상한에 닿아도 멈추고 절약 모드를 켠다', async () => {
    await db.doc('config/runtime').set({ limits: { service: { aiCostMicroUsd: 0 } } });
    const out = await runWithRealRecommend();
    expect(out.summary).toMatchObject({ stoppedBy: 'limit', made: 0 });
    expect(out.recommendCalls).toBe(1);
    expect(out.savingModeCalls).toBe(1);
  });

  it('AI 몫이 남아 있으면 실제 추천으로 만들어 저장한다', async () => {
    const out = await runWithRealRecommend();
    expect(out.summary.stoppedBy).toBeNull();
    expect(out.summary.made).toBeGreaterThan(0);
  });

  it('AI 방식인데 AI 없이 골랐으면 저장하지 않아 "만듦"으로 세지 않는다', async () => {
    await popular(SEED);
    const rec = fakeRecommend('precomputed'); // pickedBy: rule
    expect((await run({ mode: 'ai', recommend: rec.fn }, rec).run).made).toBe(0);
    expect((await db.collection('resultCache').get()).size).toBe(0);
  });

  it('호출 한도에 닿으면 멈춘다', async () => {
    await popular(SEED);
    const r = run({
      recommend: async () => {
        throw new BudgetExceededError('service', 'musicDataCalls', 1, 1, NOW);
      },
    });
    expect((await r.run).stoppedBy).toBe('limit');
  });

  it('긴급 정지(ingest)면 추천을 한 번도 부르지 않는다', async () => {
    await db.doc('config/runtime').set({ killSwitches: { ingest: false } });
    await popular(SEED);
    const r = run();
    expect((await r.run).stoppedBy).toBe('killSwitch');
    expect(r.rec.calls).toEqual([]);
  });

  it('운영 일지에는 개수만(곡 이름 없음)', async () => {
    await popular(SEED);
    await run().run;
    const log = JSON.stringify((await db.collection('opsLog').get()).docs.map((d) => d.data()));
    expect(log).toContain('Prewarm');
    expect(log).not.toContain(SEED.title);
  });
});
