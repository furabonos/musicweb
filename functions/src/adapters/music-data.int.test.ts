import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../core/budget.js';
import { pacificDay } from '../core/day.js';
import { enforceCacheCap, firestoreLastfmCache, purgeExpiredCache } from './lastfm.js';
import { firestoreCallBudget } from './music-http.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();

beforeEach(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  expect(res.ok).toBe(true);
});

describe('firestoreLastfmCache (에뮬레이터)', () => {
  it('넣고·읽고·지우면 전체 크기가 맞게 더해지고 빠진다(같은 키를 덮어써도)', async () => {
    const cache = firestoreLastfmCache(db);
    await cache.put('a', { body: '{"x":1}', bytes: 100, storedAt: 1, expiresAt: 10 });
    await cache.put('b', { body: '{"x":2}', bytes: 50, storedAt: 2, expiresAt: 10 });
    await cache.put('a', { body: '{"x":3}', bytes: 70, storedAt: 3, expiresAt: 10 });
    expect(await cache.totalBytes()).toBe(120);
    expect(await cache.get('a')).toEqual({
      body: '{"x":3}',
      bytes: 70,
      storedAt: 3,
      expiresAt: 10,
    });
    await cache.delete('b');
    await cache.delete('missing');
    expect(await cache.totalBytes()).toBe(70);
    expect(await cache.get('b')).toBeNull();
  });

  it('기간이 지난 항목을 지우면 전체 크기도 맞게 줄고, _meta는 정렬·만료 목록에 끼지 않는다', async () => {
    const cache = firestoreLastfmCache(db);
    await cache.put('gone', { body: '{}', bytes: 30, storedAt: 1, expiresAt: 100 });
    await cache.put('keep', { body: '{}', bytes: 20, storedAt: 2, expiresAt: 10_000 });
    expect((await cache.oldest(10)).map((e) => e.key)).toEqual(['gone', 'keep']);
    expect(await purgeExpiredCache(cache, 500)).toBe(1);
    expect(await cache.get('gone')).toBeNull();
    expect(await cache.totalBytes()).toBe(20);
    expect(await cache.expired(Number.MAX_SAFE_INTEGER, 10)).toEqual(['keep']);
  });

  it('상한을 넘으면 저장 시각이 오래된 것부터 지운다', async () => {
    const cache = firestoreLastfmCache(db);
    for (const [k, at] of [
      ['old', 1],
      ['mid', 2],
      ['new', 3],
    ] as const) {
      await cache.put(k, { body: '{}', bytes: 40, storedAt: at, expiresAt: 99 });
    }
    await enforceCacheCap(cache, 80);
    expect(await cache.get('old')).toBeNull();
    expect(await cache.get('mid')).not.toBeNull();
    expect(await cache.get('new')).not.toBeNull();
    expect(await cache.totalBytes()).toBe(80);
  });
});

describe('firestoreCallBudget (에뮬레이터)', () => {
  it('요청마다 musicDataCalls를 1 쓰고, 상한에 닿으면 거부한다', async () => {
    await db.doc('config/runtime').set({ limits: { service: { musicDataCalls: 2 } } });
    const budget = firestoreCallBudget(db);
    await budget.spendCall('musicbrainz');
    await budget.spendCall('wikidata');
    await expect(budget.spendCall('lastfm')).rejects.toBeInstanceOf(BudgetExceededError);
    const day = pacificDay(new Date());
    expect((await db.doc(`usage/${day}`).get()).get('musicDataCalls')).toBe(2);
  });
});
