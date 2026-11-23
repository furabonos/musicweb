import { beforeEach, describe, expect, it } from 'vitest';
import { firestoreLastfmCache } from '../adapters/lastfm.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { runPurge } from './purge.js';

const db = emulatorDb();
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

beforeEach(clearFirestore);

const purge = (extra: Partial<Parameters<typeof runPurge>[0]> = {}) => {
  const ev = memoryEvents();
  return {
    run: runPurge({
      db,
      events: ev.sink,
      lastfmCache: firestoreLastfmCache(db),
      now: () => NOW,
      ...extra,
    }),
    events: ev.events,
  };
};

describe('runPurge — 30일 넘은 YouTube 데이터 무조건 삭제', () => {
  it('31일 된 연결은 상태와 관계없이 0건이 되고, 29일 된 것은 남음', async () => {
    const statuses = ['active', 'pending_ai', 'blocked', 'rejected', 'gone'];
    for (const [i, status] of statuses.entries()) {
      await db
        .doc(`songs/s${i}/links/old${i}`)
        .set({ videoId: `old${i}`, status, verifiedAt: ago(31) });
      await db
        .doc(`songs/s${i}/links/new${i}`)
        .set({ videoId: `new${i}`, status, verifiedAt: ago(29) });
    }
    const { run, events } = purge();
    const r = await run;
    expect(r.links).toBe(5);
    const old = await db.collectionGroup('links').where('verifiedAt', '<=', ago(30)).get();
    expect(old.size).toBe(0);
    expect((await db.collectionGroup('links').get()).size).toBe(5);
    expect(events.find((e) => e.type === 'job_finished')?.attrs).toMatchObject({
      job: 'purge',
      failed: 0,
    });
  });

  it('BATCH(400)보다 많아도 전부 지움', async () => {
    const w = db.bulkWriter();
    for (let i = 0; i < 450; i++) {
      void w.set(db.doc(`songs/bulk/links/v${i}`), {
        videoId: `v${i}`,
        status: 'active',
        verifiedAt: ago(40),
      });
    }
    await w.close();
    const r = await purge().run;
    expect(r.links).toBe(450);
    expect((await db.collectionGroup('links').get()).size).toBe(0);
  });

  it('아티스트 채널 정보가 31일 지나면 채널·업로드 목록·기준 시각을 지우고 나머지는 남김', async () => {
    const artist = (days: number) => ({
      name: 'x',
      mbid: 'm',
      status: 'active',
      channelId: 'UCq19-LqvG35A-30oyAiPiqA',
      uploadsPlaylistId: 'UUq19-LqvG35A-30oyAiPiqA',
      lastSeenPublishedAt: '2024-01-01T00:00:00Z',
      failCount: 0,
      ytVerifiedAt: ago(days),
    });
    await db.doc('artists/old').set(artist(31));
    await db.doc('artists/new').set(artist(29));
    const r = await purge().run;
    expect(r.artists).toBe(1);
    expect((await db.doc('artists/old').get()).data()).toMatchObject({
      name: 'x',
      status: 'active',
      channelId: null,
      uploadsPlaylistId: null,
      lastSeenPublishedAt: null,
      ytVerifiedAt: null,
    });
    expect((await db.doc('artists/new').get()).get('channelId')).toBe('UCq19-LqvG35A-30oyAiPiqA');
  });

  it('만든 지 31일 된 ytExports 기록은 지우고(지우기만), 29일 된 것은 그대로', async () => {
    await db
      .doc('ytExports/old')
      .set({ ownerUid: 'u1', youtubePlaylistId: 'PLold', itemCount: 3, createdAt: ago(31) });
    await db
      .doc('ytExports/new')
      .set({ ownerUid: 'u1', youtubePlaylistId: 'PLnew', itemCount: 3, createdAt: ago(29) });
    const r = await purge().run;
    expect(r.ytExports).toBe(1);
    expect((await db.doc('ytExports/old').get()).exists).toBe(false);
    expect((await db.doc('ytExports/new').get()).data()).toMatchObject({
      youtubePlaylistId: 'PLnew',
      itemCount: 3,
    });
  });

  it('기간 지난 Last.fm 캐시를 지움', async () => {
    const store = firestoreLastfmCache(db);
    const t = NOW.getTime();
    await store.put('expired-key', { body: '{}', bytes: 2, storedAt: t - 1000, expiresAt: t - 10 });
    await store.put('fresh-key', {
      body: '{}',
      bytes: 2,
      storedAt: t - 1000,
      expiresAt: t + 60_000,
    });
    const r = await purge({ lastfmCache: store }).run;
    expect(r.lastfmCache).toBe(1);
    expect(await store.get('expired-key')).toBeNull();
    expect(await store.get('fresh-key')).not.toBeNull();
  });

  it('긴급 정지 ingest가 꺼져 있어도 정리는 돈다(안전장치)', async () => {
    await db.doc('config/runtime').set({ killSwitches: { ingest: false, create: false } });
    await db.doc('songs/s/links/v').set({ videoId: 'v', status: 'active', verifiedAt: ago(31) });
    const r = await purge().run;
    expect(r.links).toBe(1);
  });

  it('한 단계(Last.fm 캐시)가 실패해도 나머지는 지우고, 기록한 뒤 끝에 오류를 던짐', async () => {
    await db.doc('songs/s/links/v').set({ videoId: 'v', status: 'active', verifiedAt: ago(31) });
    await db
      .doc('ytExports/old')
      .set({ ownerUid: 'u1', youtubePlaylistId: 'PL', itemCount: 1, createdAt: ago(31) });
    const broken = {
      ...firestoreLastfmCache(db),
      expired: async () => {
        throw new Error('cache down');
      },
    };
    const { run, events } = purge({ lastfmCache: broken });
    await expect(run).rejects.toThrow('cache down');
    expect((await db.doc('songs/s/links/v').get()).exists).toBe(false);
    expect((await db.doc('ytExports/old').get()).exists).toBe(false);
    expect(events.find((e) => e.type === 'error')?.attrs).toMatchObject({
      where: 'purge.lastfm_cache',
    });
    expect(events.find((e) => e.type === 'job_finished')).toMatchObject({
      outcome: 'error',
      attrs: { failed: 1 },
    });
    const log = await db.collection('opsLog').where('kind', '==', 'job_failed').get();
    expect(log.size).toBe(1);
  });
});

describe('runPurge — 기간 지난 저장된 해석·결과 (T32, D-048)', () => {
  it('만료된 것만 지우고 남은 것은 그대로', async () => {
    await db.doc('parseCache/old').set({ value: {}, expiresAt: ago(1) });
    await db.doc('parseCache/new').set({ value: {}, expiresAt: ago(-5) });
    await db.doc('resultCache/old').set({ items: [], expiresAt: ago(1) });
    await db.doc('resultCache/new').set({ items: [], expiresAt: ago(-5) });
    await db.doc('reasonCache/old').set({ reason: 'x', expiresAt: ago(1) });
    await db.doc('reasonCache/new').set({ reason: 'y', expiresAt: ago(-5) });
    const summary = await purge().run;
    expect(summary.caches).toBe(3);
    expect((await db.collection('reasonCache').get()).docs.map((d) => d.id)).toEqual(['new']);
    expect((await db.collection('parseCache').get()).docs.map((d) => d.id)).toEqual(['new']);
    expect((await db.collection('resultCache').get()).docs.map((d) => d.id)).toEqual(['new']);
  });
});
