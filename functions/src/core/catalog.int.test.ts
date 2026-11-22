import { beforeEach, describe, expect, it } from 'vitest';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { firestoreSongs, recommendableLinks, songKey } from './catalog.js';

const db = emulatorDb();
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

beforeEach(clearFirestore);

const put = (song: string, videoId: string, kind: string, days: number, status = 'active') =>
  db.doc(`songs/${song}/links/${videoId}`).set({
    videoId,
    kind,
    status,
    embeddable: true,
    madeForKids: false,
    durationSec: 200,
    verifiedAt: ago(days),
  });

describe('recommendableLinks — 추천 후보 조회', () => {
  it('25일 넘은 연결은 active여도 제외', async () => {
    await put('a', 'vidA0000001', 'official_audio', 26);
    await put('b', 'vidB0000001', 'official_audio', 24);
    const r = await recommendableLinks(db, ['a', 'b'], NOW);
    expect([...r.keys()]).toEqual(['b']);
  });

  it('곡마다 official_audio > official_mv, 오래된 쪽은 우선순위가 높아도 건너뜀', async () => {
    await put('a', 'audioStale1', 'official_audio', 26);
    await put('a', 'mvFresh0001', 'official_mv', 1);
    await put('b', 'mvFresh0002', 'official_mv', 1);
    await put('b', 'audioFresh1', 'official_audio', 2);
    const r = await recommendableLinks(db, ['a', 'b'], NOW);
    expect(r.get('a')?.videoId).toBe('mvFresh0001');
    expect(r.get('b')?.videoId).toBe('audioFresh1');
  });

  it('active가 아닌 연결, 라이브는 요청 조건이 없으면 제외', async () => {
    await put('a', 'goneVideo01', 'official_audio', 1, 'gone');
    await put('a', 'pendingVid1', 'official_audio', 1, 'pending_ai');
    await put('b', 'liveVideo01', 'live', 1);
    expect((await recommendableLinks(db, ['a', 'b'], NOW)).size).toBe(0);
    expect((await recommendableLinks(db, ['b'], NOW, { live: true })).get('b')?.kind).toBe('live');
  });
});

describe('firestoreSongs — 추천용 곡 목록 조회', () => {
  const song = (id: string, artist: string, title: string, artistMbid = 'artist-a') =>
    db
      .doc(`songs/${id}`)
      .set({ mbid: id, artist, artistMbid, title, key: songKey(artist, title), releaseYear: 2000 });

  it('id·이름 키·아티스트로 찾음 (in 30개 넘게 나눠 묻기 포함)', async () => {
    await song('s1', 'Radiohead', 'Karma Police');
    await song('s2', 'IU', '밤편지', 'artist-b');
    for (let i = 0; i < 35; i++) await song(`x${i}`, 'Filler', `Song ${i}`, 'artist-c');
    const s = firestoreSongs(db);
    expect([...(await s.byIds(['s1', 'missing'])).keys()]).toEqual(['s1']);
    const keys = [
      songKey('radiohead', 'KARMA POLICE!'),
      ...Array.from({ length: 35 }, (_, i) => songKey('Filler', `Song ${i}`)),
    ];
    const byKey = await s.byKeys(keys);
    expect(byKey.get(songKey('Radiohead', 'Karma Police'))?.mbid).toBe('s1');
    expect(byKey.size).toBe(36);
    expect((await s.byArtists(['artist-b', 'artist-c'], 3)).map((x) => x.artistMbid)).toEqual([
      'artist-b',
      'artist-c',
      'artist-c',
      'artist-c',
    ]);
  });
});
