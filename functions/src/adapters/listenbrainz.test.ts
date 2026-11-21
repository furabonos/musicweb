import { describe, expect, it } from 'vitest';
import { fixture, musicDeps } from '../testing/music.js';
import {
  createListenBrainz,
  LB_RECORDING_ALGORITHM,
  parseRecordingSearch,
  parseSimilarArtists,
  parseSimilarRecordings,
} from './listenbrainz.js';
import { MusicConfigError } from './music-http.js';

const KARMA = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3';
const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

describe('녹화 응답 해석', () => {
  it('녹음 검색: 첫 결과가 ListenBrainz 대표 녹음, 커버·라이브도 후보로 온다', () => {
    const r = parseRecordingSearch(fixture('lb-recording-search-karma-police.json'));
    expect(r[0]).toEqual({
      mbid: KARMA,
      title: 'Karma Police',
      artist: 'Radiohead',
      releaseName: 'OK Computer',
    });
    expect(r.some((x) => /cover/i.test(x.title))).toBe(true);
  });

  it('비슷한 곡: 기준 곡을 빼고 점수 높은 순', () => {
    const r = parseSimilarRecordings(fixture('lb-similar-recordings-karma-police.json'), KARMA);
    expect(r.length).toBeGreaterThanOrEqual(50);
    expect(r[0]).toMatchObject({ title: 'Come as You Are', artist: 'Nirvana' });
    expect(r.every((x) => x.mbid !== KARMA)).toBe(true);
    expect(r.map((x) => x.score)).toEqual([...r.map((x) => x.score)].sort((a, b) => b - a));
  });

  it('비슷한 곡: 다른 기준 곡의 결과가 섞여 오면 버린다', () => {
    const rows = [
      {
        recording_mbid: RADIOHEAD,
        recording_name: 'x',
        artist_credit_name: 'y',
        score: 1,
        reference_mbid: 'other',
      },
    ];
    expect(parseSimilarRecordings(rows, KARMA)).toEqual([]);
  });

  it('비슷한 아티스트: 점수 높은 순, 기준 아티스트 제외', () => {
    const r = parseSimilarArtists(fixture('lb-similar-artists-radiohead.json'), RADIOHEAD);
    expect(r.slice(0, 3).map((a) => a.name)).toEqual(['Nirvana', 'Red Hot Chili Peppers', 'Muse']);
    expect(r.every((a) => a.mbid !== RADIOHEAD)).toBe(true);
  });

  it('형식이 깨진 행은 버린다', () => {
    expect(
      parseRecordingSearch([
        { recording_mbid: 'nope', recording_name: 'x', artist_credit_name: 'y' },
        'z',
      ]),
    ).toEqual([]);
    expect(parseSimilarArtists({ not: 'array' }, RADIOHEAD)).toEqual([]);
  });
});

describe('요청', () => {
  it('비슷한 곡은 정해진 알고리즘과 대표 MBID로 요청하고, 개수를 자른다', async () => {
    const { deps, server } = musicDeps([
      { body: fixture('lb-similar-recordings-karma-police.json') },
    ]);
    const r = await createListenBrainz(deps).similarRecordings(KARMA, 10);
    expect(r).toHaveLength(10);
    const url = new URL(server.requests[0]?.url ?? '');
    expect(url.searchParams.get('recording_mbids')).toBe(KARMA);
    expect(url.searchParams.get('algorithm')).toBe(LB_RECORDING_ALGORITHM);
  });

  it('빈 검색어는 요청하지 않고, MBID가 아니면 거부', async () => {
    const { deps, server } = musicDeps([{ body: [] }]);
    const lb = createListenBrainz(deps);
    expect(await lb.searchRecording('   ')).toEqual([]);
    await expect(lb.similarArtists('radiohead')).rejects.toBeInstanceOf(MusicConfigError);
    expect(server.requests).toHaveLength(0);
  });
});
