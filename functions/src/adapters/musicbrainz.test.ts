import { describe, expect, it } from 'vitest';
import { fixture, musicDeps } from '../testing/music.js';
import { MusicConfigError } from './music-http.js';
import {
  createMusicBrainz,
  luceneQuote,
  parseArtist,
  parseRecording,
  parseRecordingSearch,
} from './musicbrainz.js';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const KARMA = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3';

describe('녹화 응답 해석', () => {
  it('녹음 검색: 후보마다 MBID·제목·아티스트·점수와 라이브 구분 설명', () => {
    const r = parseRecordingSearch(fixture('mb-recording-search-karma-police.json'));
    expect(r).toHaveLength(5);
    for (const c of r) {
      expect(c).toMatchObject({
        title: 'Karma Police',
        artist: 'Radiohead',
        artistMbid: RADIOHEAD,
      });
      expect(c.mbid).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.score).toBeGreaterThan(90);
    }
    expect(r.some((c) => c.disambiguation?.startsWith('live'))).toBe(true);
  });

  it('녹음 검색: 한글 제목', () => {
    expect(parseRecordingSearch(fixture('mb-recording-search-iu.json'))).toEqual([
      expect.objectContaining({
        title: '밤편지',
        artist: 'IU',
        artistMbid: 'b9545342-1e6d-4dae-84ac-013374ad8d7c',
        firstReleaseYear: 2017,
      }),
    ]);
  });

  it('녹음 상세: URL 관계의 YouTube 영상 ID, 작품 MBID, 연도, 장르(출처 MusicBrainz)', () => {
    const r = parseRecording(fixture('mb-recording-karma-police.json'));
    expect(r).toMatchObject({
      mbid: KARMA,
      title: 'Karma Police',
      artist: 'Radiohead',
      artistMbid: RADIOHEAD,
      firstReleaseYear: 1997,
      youtubeVideoIds: ['1uYWYWPc9HU'],
      workMbids: ['babefb9d-3d87-3378-bfac-e13f89ae7a48'],
    });
    expect(r?.genres).toContainEqual({ name: 'alternative rock', source: 'musicbrainz' });
  });

  it('아티스트: 공식 YouTube 채널, YouTube Music 채널, Wikidata ID', () => {
    expect(parseArtist(fixture('mb-artist-radiohead.json'))).toMatchObject({
      mbid: RADIOHEAD,
      name: 'Radiohead',
      youtubeChannelIds: ['UCq19-LqvG35A-30oyAiPiqA'],
      youtubeMusicChannelIds: ['UCr_iyUANcn9OX_yy9piYoLw'],
      wikidataId: 'Q44190',
    });
  });

  it('응답의 ID가 MBID 형식이 아니면 버리고, 아주 긴 아티스트 이름은 자른다', () => {
    const credit = [
      { name: 'A'.repeat(500), joinphrase: ' feat. '.repeat(100), artist: { id: '-'.repeat(36) } },
    ];
    expect(parseRecording({ id: '-'.repeat(36), title: 't', 'artist-credit': credit })).toBeNull();
    const ok = parseRecording({
      id: '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3',
      title: 't',
      'artist-credit': credit,
    });
    expect(ok?.artist.length).toBeLessThanOrEqual(300);
    expect(ok?.artistMbid).toBeNull();
    expect(parseArtist({ id: 'nope', name: 'x' })).toBeNull();
  });

  it('형식이 깨진 응답은 빈 결과·null', () => {
    expect(parseRecordingSearch({ recordings: [{ id: 'x' }, null, 3] })).toEqual([]);
    expect(parseRecordingSearch('oops')).toEqual([]);
    expect(parseRecording({})).toBeNull();
    expect(parseArtist(null)).toBeNull();
  });
});

describe('요청 만들기', () => {
  it('검색어의 따옴표·역슬래시는 이스케이프돼 질의 연산자를 바꾸지 못한다', () => {
    expect(luceneQuote('a" OR artist:"x')).toBe('"a\\" OR artist:\\"x"');
    expect(luceneQuote('back\\slash')).toBe('"back\\\\slash"');
  });

  it('검색은 artist·recording 필드 질의로 보낸다', async () => {
    const { deps, server } = musicDeps([
      { body: fixture('mb-recording-search-karma-police.json') },
    ]);
    const r = await createMusicBrainz(deps).searchRecordings('Radiohead', 'Karma Police');
    expect(r).toHaveLength(5);
    const url = new URL(server.requests[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://musicbrainz.org/ws/2/recording/');
    expect(url.searchParams.get('query')).toBe('artist:"Radiohead" AND recording:"Karma Police"');
    expect(url.searchParams.get('fmt')).toBe('json');
  });

  it('MBID 형식이 아니면 요청 전에 거부한다', async () => {
    const { deps, server } = musicDeps([{ body: {} }]);
    const mb = createMusicBrainz(deps);
    await expect(mb.getRecording('../artist/x')).rejects.toBeInstanceOf(MusicConfigError);
    await expect(mb.getArtist('Q44190')).rejects.toBeInstanceOf(MusicConfigError);
    expect(server.requests).toHaveLength(0);
  });

  it('상세 요청은 필요한 관계(url-rels, work-rels, genres)를 함께 받는다', async () => {
    const { deps, server } = musicDeps([{ body: fixture('mb-recording-karma-police.json') }]);
    await createMusicBrainz(deps).getRecording(KARMA);
    const url = new URL(server.requests[0]?.url ?? '');
    expect(url.pathname).toBe(`/ws/2/recording/${KARMA}`);
    expect(url.searchParams.get('inc')).toBe('artist-credits+url-rels+genres+work-rels');
  });
});
