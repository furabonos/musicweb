import { beforeEach, describe, expect, it } from 'vitest';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import type { EventInput, EventSink } from './events.js';
import { createPlaylist, type CreateDeps } from './playlists.js';
import type { RecommendResult } from './recommend.js';
import { firestoreRequestTally } from './requestTally.js';

/** 요청 횟수 집계 저장 (SPEC 4.3b, T42, D-056). 에뮬레이터 Firestore */
const db = emulatorDb();
beforeEach(clearFirestore);

const KEY = 'k'.repeat(32);
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-26T20:00:00Z'); // 태평양 2026-11-26
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const tallyAt = (now: Date) => firestoreRequestTally(db, KEY, () => now);

const SONG = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3';
const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const hit = (uid: string, locale: 'en' | 'ko' = 'en') => ({
  uid,
  songId: SONG,
  artistMbid: ARTIST,
  locale,
});
const MISSING = { artist: 'Nobody Knows', title: 'Secret Song' };

/** 저장소 전체를 글자로 펼친다: uid·이름이 어디에도 없는지 보려고 */
async function dump(col: string) {
  return JSON.stringify((await db.collection(col).get()).docs.map((d) => [d.id, d.data()]));
}

describe('성공한 요청', () => {
  it('같은 사람이 같은 날 두 번 찾으면 1명, 다른 날이면 2명', async () => {
    await tallyAt(T0).success(hit('alice'));
    await tallyAt(T0).success(hit('alice'));
    expect(await tallyAt(T0).topSongs(10, 1)).toEqual([{ id: SONG, people: 1, locales: ['en'] }]);
    await tallyAt(at(1)).success(hit('alice'));
    expect((await tallyAt(at(1)).topSongs(10, 1))[0]?.people).toBe(2);
  });

  it('2명인 곡·아티스트는 조회에 없고, 3명부터 있다. 언어는 실제로 요청된 것만', async () => {
    await tallyAt(T0).success(hit('alice'));
    await tallyAt(T0).success(hit('bob', 'ko'));
    expect(await tallyAt(T0).topSongs(10)).toEqual([]);
    expect(await tallyAt(T0).topArtists(10)).toEqual([]);
    await tallyAt(T0).success(hit('carol'));
    expect(await tallyAt(T0).topSongs(10)).toEqual([
      { id: SONG, people: 3, locales: ['en', 'ko'] },
    ]);
    expect(await tallyAt(T0).topArtists(10)).toEqual([{ id: ARTIST, people: 3 }]);
  });

  it('31일 지난 요청은 합계에서 빠진다', async () => {
    for (const uid of ['alice', 'bob', 'carol']) await tallyAt(T0).success(hit(uid));
    expect(await tallyAt(at(29)).topSongs(10)).toHaveLength(1);
    expect(await tallyAt(at(31)).topSongs(10)).toEqual([]);
  });

  it('저장 문서에 uid 원문이 없다', async () => {
    for (const uid of ['alice-uid-123', 'bob-uid-456']) await tallyAt(T0).success(hit(uid));
    for (const col of ['requestTally', 'requestTallySeen']) {
      const all = await dump(col);
      expect(all).not.toContain('alice-uid-123');
      expect(all).not.toContain('bob-uid-456');
    }
  });

  it('아티스트 ID가 없으면 곡만 센다', async () => {
    await tallyAt(T0).success({ ...hit('alice'), artistMbid: null });
    expect((await db.collection('requestTally').get()).size).toBe(1);
  });
});

describe('실패한 이름', () => {
  it('3명 전에는 이름이 저장되지 않고, 3명째에 그 요청의 이름이 저장된다', async () => {
    await tallyAt(T0).failure({ uid: 'alice', ...MISSING });
    await tallyAt(T0).failure({ uid: 'alice', ...MISSING }); // 같은 날 같은 사람
    await tallyAt(T0).failure({ uid: 'bob', artist: 'NOBODY KNOWS', title: 'secret song' });
    expect(await dump('failedSeedTally')).not.toMatch(/nobody|secret/i);
    expect(await tallyAt(T0).failedLabels(10)).toEqual([]);

    await tallyAt(T0).failure({ uid: 'carol', ...MISSING });
    const labels = await tallyAt(T0).failedLabels(10);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ people: 3, label: MISSING });
    expect(await dump('failedSeedTally')).not.toContain('carol');
  });
});

describe('실패한 이름 — 한 사람이 여러 날', () => {
  it('한 사람이 사흘 동안 같은 이름을 쳐도 1명이라 이름이 저장되지 않는다', async () => {
    for (const d of [0, 1, 2]) await tallyAt(at(d)).failure({ uid: 'alice', ...MISSING });
    expect(await dump('failedSeedTally')).not.toMatch(/nobody|secret/i);
    expect(await dump('failedSeedTally')).not.toContain('alice');
    // 다른 두 사람이 더 찾으면 3명
    await tallyAt(at(2)).failure({ uid: 'bob', ...MISSING });
    expect(await dump('failedSeedTally')).not.toMatch(/nobody/i);
    await tallyAt(at(2)).failure({ uid: 'carol', ...MISSING });
    expect(await tallyAt(at(2)).failedLabels(10)).toHaveLength(1);
  });

  it('30일 지난 사람 표시는 사람 수에서 빠진다', async () => {
    await tallyAt(T0).failure({ uid: 'alice', ...MISSING });
    await tallyAt(T0).failure({ uid: 'bob', ...MISSING });
    await tallyAt(at(31)).failure({ uid: 'carol', ...MISSING });
    expect(await dump('failedSeedTally')).not.toMatch(/nobody/i);
  });
});

describe('실패한 이름 — 저장 시각과 그만 찾기', () => {
  const ref = () => db.collection('failedSeedTally').limit(1).get();
  const labeledAt = async () =>
    ((await ref()).docs[0]?.get('labeledAt') as { toMillis(): number } | null)?.toMillis() ?? null;

  it('3명 전에는 저장 시각이 없고, 3번째 사람 때 기록되며, 그 뒤 요청에도 바뀌지 않는다', async () => {
    await tallyAt(T0).failure({ uid: 'alice', ...MISSING });
    await tallyAt(T0).failure({ uid: 'bob', ...MISSING });
    expect(await labeledAt()).toBeNull();
    await tallyAt(at(1)).failure({ uid: 'carol', ...MISSING });
    expect(await labeledAt()).toBe(at(1).getTime());
    await tallyAt(at(2)).failure({ uid: 'dave', ...MISSING });
    expect(await labeledAt()).toBe(at(1).getTime());
  });

  it('그만 찾기로 한 이름은 새 요청이 와도 다시 저장되지 않는다', async () => {
    for (const uid of ['alice', 'bob', 'carol']) await tallyAt(T0).failure({ uid, ...MISSING });
    const doc = (await ref()).docs[0];
    await doc?.ref.update({ gaveUp: true, label: null });
    await tallyAt(at(1)).failure({ uid: 'dave', ...MISSING });
    expect((await ref()).docs[0]?.get('label')).toBeNull();
    expect(await dump('failedSeedTally')).not.toMatch(/nobody|secret/i);
    expect(await tallyAt(at(1)).failedLabels(10)).toEqual([]);
  });
});

describe('만들기 흐름에서', () => {
  const events: EventInput[] = [];
  const sink: EventSink = { record: async (e) => void events.push(e) };
  const ok: RecommendResult = {
    ok: true,
    seed: { songId: SONG, artistMbid: ARTIST, artist: 'Radiohead', title: 'Karma Police' },
    items: [],
    shortfall: null,
  } as unknown as RecommendResult;
  const deps = (over: Partial<CreateDeps>): CreateDeps => ({
    db,
    events: sink,
    parse: async () => ({
      ok: true,
      via: 'rule',
      value: {
        seed: { artist: 'Radiohead', title: 'Karma Police' },
        count: 10,
        include: { live: false, cover: false, remix: false },
        locale: 'en',
        unsupported: [],
      },
    }),
    recommend: async () => ok,
    enqueueArtist: async () => 'queued',
    now: () => T0,
    ...over,
  });

  it('집계 저장이 실패해도 재생목록은 만들어지고 오류 이벤트만 남는다', async () => {
    events.length = 0;
    const out = await createPlaylist(
      deps({
        tally: {
          success: async () => {
            throw new Error('boom');
          },
          failure: async () => {
            throw new Error('boom');
          },
        },
      }),
      'alice',
      { text: 'Karma Police by Radiohead', locale: 'en' },
    );
    expect(out.ok).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        attrs: expect.objectContaining({ where: 'playlists.tally' }),
      }),
    );
    expect(events.some((e) => e.type === 'playlist_created')).toBe(true);
  });

  it('못 찾은 이름의 집계가 실패해도 결과는 그대로 seed_not_found이고 오류 이벤트만 남는다', async () => {
    events.length = 0;
    const out = await createPlaylist(
      deps({
        tally: {
          success: async () => undefined,
          failure: async () => {
            throw new Error('boom');
          },
        },
        recommend: async () => ({ ok: false, reason: 'seed_not_found' }),
      }),
      'alice',
      { text: 'Karma Police by Radiohead', locale: 'en' },
    );
    expect(out).toEqual({ ok: false, reason: 'seed_not_found' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        attrs: expect.objectContaining({ where: 'playlists.tally' }),
      }),
    );
  });

  it('성공하면 기준 곡을 세고, 음악 데이터에서 못 찾으면 이름 해시를 센다(문장 원문 없음)', async () => {
    const tally = firestoreRequestTally(db, KEY, () => T0);
    const text = 'Karma Police by Radiohead please';
    await createPlaylist(deps({ tally }), 'alice', { text, locale: 'en' });
    expect((await tally.topSongs(10, 1))[0]?.id).toBe(SONG);

    await createPlaylist(
      deps({ tally, recommend: async () => ({ ok: false, reason: 'seed_not_found' }) }),
      'bob',
      { text, locale: 'en' },
    );
    expect((await db.collection('failedSeedTally').get()).size).toBe(1);
    for (const col of ['requestTally', 'failedSeedTally', 'requestTallySeen']) {
      const all = await dump(col);
      expect(all).not.toContain('please');
      expect(all).not.toMatch(/"alice"|"bob"/);
    }
    // 3명 전이라 실패한 이름도 없다
    expect(await dump('failedSeedTally')).not.toMatch(/radiohead|karma/i);
  });

  it('곡 고르기(곡 ID)로 못 찾은 것은 이름 실패로 세지 않는다', async () => {
    const tally = firestoreRequestTally(db, KEY, () => T0);
    const picked = deps({}).parse;
    await createPlaylist(
      deps({
        tally,
        parse: async (t, l) => ({ ...(await picked(t, l)), via: 'pick' }) as never,
        recommend: async () => ({ ok: false, reason: 'seed_not_found' }),
      }),
      'alice',
      { text: 'x', locale: 'en' },
    );
    expect((await db.collection('failedSeedTally').get()).size).toBe(0);
  });
});
