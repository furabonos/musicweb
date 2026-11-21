import { describe, expect, it } from 'vitest';
import { fixture, musicDeps } from '../testing/music.js';
import { MusicConfigError } from './music-http.js';
import { artistsQuery, createWikidata, parseArtists, parseWorks, worksQuery } from './wikidata.js';

const WORK = 'babefb9d-3d87-3378-bfac-e13f89ae7a48';
const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

describe('녹화 응답 해석', () => {
  it('작품: YouTube 영상 ID(P1651), 장르(P136, 출처 Wikidata), 발표 연도(P577)', () => {
    expect(parseWorks(fixture('wd-work-karma-police.json')).get(WORK)).toEqual({
      workMbid: WORK,
      wikidataId: 'Q1750699',
      youtubeVideoIds: ['IBH97ma9YiI'],
      genres: [
        { name: 'alternative rock', source: 'wikidata' },
        { name: 'indie rock', source: 'wikidata' },
        { name: 'art rock', source: 'wikidata' },
      ],
      publicationYear: 1997,
    });
  });

  it('아티스트: YouTube 채널(P2397)', () => {
    expect(parseArtists(fixture('wd-artist-radiohead.json')).get(RADIOHEAD)).toEqual({
      artistMbid: RADIOHEAD,
      wikidataId: 'Q44190',
      youtubeChannelIds: ['UCq19-LqvG35A-30oyAiPiqA', 'UCr_iyUANcn9OX_yy9piYoLw'],
    });
  });

  it('형식에 안 맞는 영상 ID·채널 ID·라벨 없는 장르(Q번호)는 버린다', () => {
    const json = {
      results: {
        bindings: [
          { work: { value: WORK }, yt: { value: 'bad' }, genreLabel: { value: 'Q123' } },
          { artist: { value: RADIOHEAD }, channel: { value: 'not-a-channel' } },
        ],
      },
    };
    expect(parseWorks(json).get(WORK)).toMatchObject({ youtubeVideoIds: [], genres: [] });
    expect(parseArtists(json).get(RADIOHEAD)?.youtubeChannelIds).toEqual([]);
  });
});

describe('질의 만들기', () => {
  it('MBID만 질의에 들어간다 (질의 주입 방지)', () => {
    expect(worksQuery([WORK, WORK])).toContain(`VALUES ?work { "${WORK}" }`);
    expect(() => worksQuery(['" } ?x ?y ?z . #'])).toThrow(MusicConfigError);
    expect(() => artistsQuery(['Q44190'])).toThrow(MusicConfigError);
  });

  it('50개를 넘으면 버리지 않고 50개씩 나눠 요청한다', async () => {
    const ids = Array.from(
      { length: 120 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const { deps, server } = musicDeps([{ body: { results: { bindings: [] } } }]);
    await createWikidata(deps).works(ids);
    expect(server.requests).toHaveLength(3);
    expect(() => worksQuery(ids)).toThrow(MusicConfigError);
  });

  it('SPARQL JSON 형식으로 요청하고, 빈 목록이면 요청하지 않는다', async () => {
    const { deps, server } = musicDeps([{ body: fixture('wd-work-karma-police.json') }]);
    const wd = createWikidata(deps);
    expect((await wd.works([])).size).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect((await wd.works([WORK])).get(WORK)?.youtubeVideoIds).toEqual(['IBH97ma9YiI']);
    expect(server.requests[0]?.headers.get('Accept')).toBe('application/sparql-results+json');
    expect(new URL(server.requests[0]?.url ?? '').searchParams.get('query')).toBe(
      worksQuery([WORK]),
    );
  });
});
