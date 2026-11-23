import { beforeEach, describe, expect, it } from 'vitest';
import { callFunction, clearFirestore, emulatorDb } from '../testing/emulator.js';
import { seedDemoCatalog } from '../testing/demoCatalog.js';
import { SUGGEST_LIMIT, suggestSongs } from './songs.js';

/** 곡 고르기 제안 (T33, D-049) */
const db = emulatorDb();
beforeEach(async () => {
  await clearFirestore();
  await seedDemoCatalog(db);
});

describe('songs-suggest', () => {
  it('아티스트 이름 앞부분·제목 앞부분으로 찾는다(대소문자·악센트 무시)', async () => {
    const byArtist = await suggestSongs(db, 'central');
    expect(byArtist.length).toBeGreaterThan(0);
    expect(byArtist.every((s) => s.artist.toLowerCase().includes('central'))).toBe(true);
    const byTitle = await suggestSongs(db, 'DOJ');
    expect(byTitle.map((s) => s.title)).toContain('Doja');
  });

  it('최대 10개, 두 글자 미만은 빈 목록', async () => {
    const batch = db.batch();
    for (let i = 0; i < 25; i++) {
      batch.set(db.doc(`songs/00000000-0000-4000-9000-${String(i).padStart(12, '0')}`), {
        mbid: `m${i}`,
        artist: 'Same Band',
        title: `Song ${i}`,
        key: `same band|song ${i}`,
        titleKey: `song ${i}`,
      });
    }
    await batch.commit();
    expect(await suggestSongs(db, 'same')).toHaveLength(SUGGEST_LIMIT);
    expect(await suggestSongs(db, 's')).toEqual([]);
  });

  it('정보가 적은 곡(lowInfo, mbid 없음)은 제안하지 않는다', async () => {
    await db.doc('songs/low1').set({
      mbid: null,
      lowInfo: true,
      artist: '',
      title: '',
      key: 'zzlow|x',
      titleKey: 'zzlow x',
    });
    await db.doc('songs/low2').set({
      mbid: 'x',
      lowInfo: true,
      artist: 'Zz',
      title: 'Low',
      key: 'zzlow|y',
      titleKey: 'zzlow y',
    });
    expect(await suggestSongs(db, 'zzlow')).toEqual([]);
  });

  it('callable: 로그인 없이 부르고, 51자는 거부', async () => {
    const ok = await callFunction('songs-suggest', { q: 'central' });
    expect((ok.result as { items: unknown[] }).items.length).toBeGreaterThan(0);
    const bad = await callFunction('songs-suggest', { q: 'x'.repeat(51) });
    expect(bad.error?.status).toBe('INVALID_ARGUMENT');
  });
});
