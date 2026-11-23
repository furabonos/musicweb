import { beforeEach, describe, expect, it } from 'vitest';
import type { VideoDetail } from '../adapters/youtube-read.js';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { recommendableLinks } from './catalog.js';
import { firestoreRecommendPorts } from './recommendPorts.js';

const db = emulatorDb();
const NOW = new Date();
beforeEach(clearFirestore);

const ports = () =>
  firestoreRecommendPorts({
    db,
    // 이 테스트에서는 저장·채널 조회만 쓴다
    mb: {} as never,
    lb: {} as never,
    wd: {} as never,
    yt: {} as never,
    llm: { structured: async () => null },
    events: memoryEvents().sink,
    now: () => NOW,
  });

const video: VideoDetail = {
  videoId: 'luckyMB0001',
  title: 'Radiohead - Lucky (Official Video)',
  channelId: 'UCq19-LqvG35A-30oyAiPiqA',
  channelTitle: 'Radiohead',
  description: '',
  durationSec: 260,
  publishedAt: null,
  embeddable: true,
  madeForKids: false,
  privacyStatus: 'public',
};
const LUCKY = {
  mbid: 'lucky-mbid',
  artist: 'Radiohead',
  artistMbid: 'rh',
  title: 'Lucky',
  releaseYear: 1997,
};

describe('firestoreRecommendPorts', () => {
  it('조회로 찾은 연결을 곡 목록에 저장하고(이름 키 포함) 바로 추천 후보가 됨', async () => {
    await ports().saveLink(LUCKY, video, 'official_mv', NOW);
    const song = (await db.doc('songs/lucky-mbid').get()).data();
    expect(song).toMatchObject({ title: 'Lucky', key: 'radiohead|lucky', source: 'musicbrainz' });
    const link = (await db.doc('songs/lucky-mbid/links/luckyMB0001').get()).data();
    expect(link).toMatchObject({
      status: 'active',
      kind: 'official_mv',
      linkedBy: 'lookup',
      ytTitle: video.title,
    });
    expect((await recommendableLinks(db, ['lucky-mbid'], NOW)).get('lucky-mbid')?.videoId).toBe(
      'luckyMB0001',
    );
  });

  it('이미 다른 곡에 연결된 영상은 겹쳐 저장하지 않음', async () => {
    await db.doc('songs/other/links/luckyMB0001').set({ videoId: 'luckyMB0001', status: 'gone' });
    await ports().saveLink(LUCKY, video, 'official_mv', NOW);
    expect((await db.doc('songs/lucky-mbid').get()).exists).toBe(false);
  });

  it('공식 채널은 artists 문서에서', async () => {
    await db.doc('artists/rh').set({ channelId: 'UCq19-LqvG35A-30oyAiPiqA' });
    expect(await ports().officialChannels('rh')).toEqual(['UCq19-LqvG35A-30oyAiPiqA']);
    expect(await ports().officialChannels('nobody')).toEqual([]);
    expect(await ports().officialChannels(null)).toEqual([]);
  });
});

describe('firestorePrecomputed (T30)', () => {
  it('문서가 없으면 null, 깨진 items는 거르고, 낱말 목록 버전이 다른 숫자 묶음은 버린다', async () => {
    const { firestorePrecomputed } = await import('./recommendPorts.js');
    const { VOCAB_VERSION } = await import('@musicweb/shared/similarity');
    const pc = firestorePrecomputed(db);
    expect(await pc.similar('nope')).toBeNull();
    await db.doc('artistSimilar/a1').set({
      items: [{ artistMbid: 'b1', score: 5 }, { artistMbid: 3, score: 'x' }, null],
    });
    expect(await pc.similar('a1')).toEqual([{ artistMbid: 'b1', score: 5 }]);
    await db
      .doc('artistVectors/v1')
      .set({ vocabVersion: VOCAB_VERSION, songs: [{ songId: 's1', w: { 0: 1 }, decade: null }] });
    await db
      .doc('artistVectors/v2')
      .set({ vocabVersion: VOCAB_VERSION - 1, songs: [{ songId: 's2', w: {}, decade: null }] });
    const m = await pc.vectors(['v1', 'v2', 'v3', 'v1']);
    expect([...m.keys()]).toEqual(['v1']);
  });
});
