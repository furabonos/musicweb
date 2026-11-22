import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** YouTube 손으로 만든 응답(tests/fixtures/youtube) — 테스트 도우미, 배포 빌드에서 빠짐. */
const DIR = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'youtube');
export const ytFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Record<string, unknown>;

export const RADIOHEAD = { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead' };
export const IU = { mbid: 'b9545342-1e6d-4dae-84ac-013374ad8d7c', name: 'IU' };
export const KARMA_MBID = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3';
export const NO_SURPRISES_MBID = '980a426e-623e-4ea5-98c7-008d037a0508';
export const NIGHT_LETTER_MBID = 'cf3b2fd9-91d3-4d35-a0c5-d9f2ed8a5a01';

type Route = { status?: number; body: unknown };

/**
 * YouTube·MusicBrainz·Wikidata를 흉내 내는 가짜 서버. 요청 주소로 응답을 고른다.
 * - videos.list는 요청한 id만 돌려준다.
 * - MusicBrainz 검색은 recording:"…"의 제목으로 녹음 후보를 돌려준다.
 */
export function fakeMusicWorld(
  opts: {
    extraRadioheadUpload?: boolean;
    quotaExceeded?: boolean;
    /** MusicBrainz가 계속 503 */
    musicbrainzDown?: boolean;
    /** No Surprises의 게시 시각을 Karma Police (Live)와 같게 */
    tie?: boolean;
    /** channels.list가 빈 결과를 주는 채널(채널 삭제) */
    goneChannels?: string[];
  } = {},
) {
  const calls: { host: string; path: string; url: URL }[] = [];
  const rhPage1 = ytFixture('playlistitems-radiohead-p1.json');
  const rhVideos = ytFixture('videos-radiohead.json');
  if (opts.tie) {
    for (const it of rhPage1.items as {
      contentDetails: { videoId: string; videoPublishedAt: string };
    }[]) {
      if (it.contentDetails.videoId === 'rhNoSurp001')
        it.contentDetails.videoPublishedAt = '2024-02-01T12:00:00Z';
    }
  }
  if (opts.extraRadioheadUpload) {
    (rhPage1.items as unknown[]).unshift({
      kind: 'youtube#playlistItem',
      contentDetails: { videoId: 'rhLucky0001', videoPublishedAt: '2024-04-01T12:00:00Z' },
    });
    (rhVideos.items as unknown[]).push({
      id: 'rhLucky0001',
      snippet: {
        publishedAt: '2024-04-01T12:00:00Z',
        channelId: 'UCq19-LqvG35A-30oyAiPiqA',
        channelTitle: 'Radiohead',
        title: 'Radiohead - No Surprises (Official Video)',
        description: '',
      },
      contentDetails: { duration: 'PT3M50S' },
      status: { privacyStatus: 'public', embeddable: true, madeForKids: false },
    });
  }

  const recordings: Record<string, unknown[]> = {
    'karma police': [
      rec(KARMA_MBID, 'Karma Police', RADIOHEAD, '1997-05-21', 264_000),
      rec(
        '0173a3ab-0000-4000-8000-000000000001',
        'Karma Police',
        RADIOHEAD,
        null,
        270_000,
        'live, 2003-10-15: Toronto',
      ),
    ],
    'no surprises': [rec(NO_SURPRISES_MBID, 'No Surprises', RADIOHEAD, '1997-05-21', 229_000)],
    'through the night': [rec(NIGHT_LETTER_MBID, '밤편지', IU, '2017-03-24', 253_000)],
  };

  function route(url: URL): Route {
    const p = url.searchParams;
    if (url.host === 'www.googleapis.com') {
      if (opts.quotaExceeded) return { status: 403, body: ytFixture('error-quota-exceeded.json') };
      if (url.pathname.endsWith('/channels')) {
        if (opts.goneChannels?.includes(p.get('id') ?? '')) return { body: { items: [] } };
        return {
          body: ytFixture(
            p.get('id') === 'UC3SyT4_WLHzN7JmHQwKQZww'
              ? 'channels-iu.json'
              : 'channels-radiohead.json',
          ),
        };
      }
      if (url.pathname.endsWith('/playlistItems')) {
        if (p.get('playlistId')?.startsWith('UU3SyT4'))
          return { body: ytFixture('playlistitems-iu-p1.json') };
        return {
          body:
            p.get('pageToken') === 'PAGE2' ? ytFixture('playlistitems-radiohead-p2.json') : rhPage1,
        };
      }
      if (url.pathname.endsWith('/videos')) {
        const ids = new Set((p.get('id') ?? '').split(','));
        const all = [
          ...(rhVideos.items as { id: string }[]),
          ...(ytFixture('videos-iu.json').items as { id: string }[]),
        ];
        return { body: { items: all.filter((v) => ids.has(v.id)) } };
      }
    }
    if (url.host === 'musicbrainz.org') {
      if (opts.musicbrainzDown) return { status: 503, body: { error: 'busy' } };
      if (url.pathname.startsWith('/ws/2/artist/')) {
        if (url.pathname.includes(RADIOHEAD.mbid)) {
          return {
            body: JSON.parse(
              readFileSync(join(DIR, '..', 'music', 'mb-artist-radiohead.json'), 'utf8'),
            ),
          };
        }
        return { body: { id: IU.mbid, name: 'IU', relations: [] } };
      }
      if (url.pathname === '/ws/2/recording/') {
        const title = /recording:"((?:[^"\\]|\\.)*)"/.exec(p.get('query') ?? '')?.[1] ?? '';
        return { body: { recordings: recordings[title.toLowerCase()] ?? [] } };
      }
    }
    if (url.host === 'query.wikidata.org') {
      const q = p.get('query') ?? '';
      if (q.includes(IU.mbid)) {
        return {
          body: {
            results: {
              bindings: [
                {
                  artist: { value: IU.mbid },
                  item: { value: 'http://www.wikidata.org/entity/Q15982' },
                  channel: { value: 'UC3SyT4_WLHzN7JmHQwKQZww' },
                },
              ],
            },
          },
        };
      }
      return { body: { results: { bindings: [] } } };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push({ host: url.host, path: url.pathname, url });
    const r = route(url);
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    calls,
    count: (host: string, pathEnd?: string) =>
      calls.filter((c) => c.host === host && (!pathEnd || c.path.endsWith(pathEnd))).length,
  };
}

function rec(
  id: string,
  title: string,
  artist: { mbid: string; name: string },
  date: string | null,
  length: number,
  disambiguation?: string,
) {
  return {
    id,
    score: 100,
    title,
    length,
    ...(disambiguation ? { disambiguation } : {}),
    ...(date ? { 'first-release-date': date } : {}),
    'artist-credit': [{ name: artist.name, artist: { id: artist.mbid, name: artist.name } }],
  };
}
