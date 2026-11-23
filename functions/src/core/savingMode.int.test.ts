import { beforeEach, describe, expect, it } from 'vitest';
import {
  callFunction,
  clearAuth,
  clearFirestore,
  DAY_MS,
  emulatorDb,
  googleSignIn,
} from '../testing/emulator.js';
import { seedDemoCatalog } from '../testing/demoCatalog.js';
import { memoryEvents } from '../testing/music.js';
import { enterSavingMode, readSavingMode } from './savingMode.js';

/**
 * 절약 모드 (SPEC 3.4, T22b, D-039). 에뮬레이터의 가짜 AI도 비용 상한을 거치므로(1 microUSD 예약),
 * AI 비용 상한을 0으로 두면 실제처럼 상한에 닿는다.
 */
const db = emulatorDb();
const ADMIN = 'admin@example.com';
const input = { text: '10 songs like Doja by Central Cee', locale: 'en' };

beforeEach(async () => {
  await clearFirestore();
  await clearAuth();
  await seedDemoCatalog(db);
});

const savingMode = async () => (await db.doc('config/runtime').get()).get('savingMode');
const logs = async () =>
  (await db.collection('opsLog').get()).docs.map((d) => d.get('message') as string);

describe('절약 모드', () => {
  it('AI 상한 0에서 만들기 → 성공(AI 없는 방식), 절약 모드 켜짐, 일지 1줄, 긴급 정지는 그대로', async () => {
    await db.doc('config/runtime').set({ limits: { service: { aiCostMicroUsd: 0 } } });
    const { token } = await googleSignIn(ADMIN);

    const r = await callFunction('playlists-create', input, token);
    expect(r.error).toBeUndefined();
    const result = r.result as { ok: boolean; items: { reason: string | null }[] };
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(10);
    // AI 없는 방식의 고정 이유 문장
    expect(result.items[0]?.reason).toMatch(/also play this|similar to/);

    expect(await savingMode()).toMatchObject({ active: true, reason: 'ai_limit', limitAtStart: 0 });
    expect(await logs()).toEqual([
      'Saving mode on: the daily AI cost limit was reached. Sets are made without AI until midnight Pacific.',
    ]);
    const runtime = (await db.doc('config/runtime').get()).data();
    expect(runtime?.killSwitches).toBeUndefined();

    // 같은 날 두 번째: 이미 절약 모드라 AI를 부르지 않고, 일지도 더 쓰지 않는다
    const again = await callFunction('playlists-create', input, token);
    expect((again.result as { ok: boolean }).ok).toBe(true);
    expect(await logs()).toHaveLength(1);

    // 화면용 설정이 절약 모드를 알려 준다
    const cfg = await callFunction('site-config', {});
    expect(cfg.result).toMatchObject({ savingMode: true });

    const types = (await db.collection('events').get()).docs.map((d) => [
      d.get('type'),
      d.get('attrs.state') ?? d.get('attrs.reason'),
    ]);
    expect(types).toContainEqual(['saving_mode', 'on']);
    expect(types).toContainEqual(['ai_fallback', 'saving']);
  });

  it('같은 날 다시 상한에 닿아도 기록은 한 번, 다음 날이면 꺼지고 꺼짐을 한 번 기록', async () => {
    const now = new Date('2026-11-23T20:00:00Z');
    const ev = memoryEvents();
    expect(await enterSavingMode(db, ev.sink, now)).toBe(true);
    expect(await enterSavingMode(db, ev.sink, new Date(now.getTime() + 3600_000))).toBe(false);
    expect(await logs()).toHaveLength(1);
    expect(await readSavingMode(db, ev.sink, now)).toBe(true);

    const tomorrow = new Date(now.getTime() + DAY_MS);
    expect(await readSavingMode(db, ev.sink, tomorrow)).toBe(false);
    expect(await readSavingMode(db, ev.sink, tomorrow)).toBe(false);
    expect(await savingMode()).toMatchObject({ active: false });
    expect(await logs()).toContain('Saving mode off: a new day started (Pacific time).');
    expect(await logs()).toHaveLength(2);
    expect(ev.events.map((e) => [e.type, e.attrs])).toEqual([
      ['saving_mode', { state: 'on', reason: 'ai_limit' }],
      ['saving_mode', { state: 'off', reason: 'new_day' }],
    ]);
  });

  it('관리자가 AI 비용 상한을 올리면 그날 바로 꺼진다', async () => {
    const now = new Date('2026-11-23T20:00:00Z');
    const ev = memoryEvents();
    await enterSavingMode(db, ev.sink, now);
    await db
      .doc('config/runtime')
      .set({ limits: { service: { aiCostMicroUsd: 5_000_000 } } }, { merge: true });
    expect(await readSavingMode(db, ev.sink, now)).toBe(false);
    expect(ev.events.at(-1)?.attrs).toEqual({ state: 'off', reason: 'limit_raised' });
  });
});

describe('해석 순서 (D-044)', () => {
  it('규칙이 잘못 읽어 기준 곡을 못 찾으면 AI로 한 번 다시 읽는다', async () => {
    const { token } = await googleSignIn(ADMIN);
    // 규칙은 제목을 "please play Doja", 아티스트를 "the wrong name"으로 읽는다 → 못 찾음 → AI(가짜)가 Doja를 찾는다
    const r = await callFunction(
      'playlists-create',
      { text: 'please play Doja by the wrong name', locale: 'en' },
      token,
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ ok: true, seed: { title: 'Doja' } });
  });

  it('절약 모드에서 규칙으로도 못 읽는 문장은 하루 만들기 횟수를 쓰지 않고 다시 묻는다', async () => {
    const { token, uid } = await googleSignIn(ADMIN);
    const now = new Date();
    await enterSavingMode(db, memoryEvents().sink, now);
    const r = await callFunction(
      'playlists-create',
      { text: 'something chill for studying', locale: 'en' },
      token,
    );
    expect(r.result).toEqual({ ok: false, reason: 'not_understood' });
    expect((await db.collection(`users/${uid}/usage`).get()).size).toBe(0);
  });
});

describe('리뷰 반영 (T22b)', () => {
  it('절약 모드 중 관리자가 한도를 바꿔도 켜진 시각(Timestamp)이 망가지지 않는다', async () => {
    const { Timestamp } = await import('firebase-admin/firestore');
    const { setLimits } = await import('../api/admin.js');
    await enterSavingMode(db, memoryEvents().sink, new Date());
    await setLimits(db, 'admin-uid', { user: { playlists: 7 } });
    const sm = await savingMode();
    expect(sm.since).toBeInstanceOf(Timestamp);
    expect(sm.active).toBe(true);
  });

  it('전날 켜진 것이 남아 있는 채로 새 날 다시 켜지면 꺼짐·켜짐을 둘 다 남긴다', async () => {
    const ev = memoryEvents();
    const day1 = new Date('2026-11-23T20:00:00Z');
    await enterSavingMode(db, ev.sink, day1);
    await enterSavingMode(db, ev.sink, new Date(day1.getTime() + DAY_MS));
    expect(await logs()).toHaveLength(3);
    expect(ev.events.map((e) => e.attrs.state)).toEqual(['on', 'off', 'on']);
  });
});
