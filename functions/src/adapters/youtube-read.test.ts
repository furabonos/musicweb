import { describe, expect, it, vi } from 'vitest';
import { memoryEvents } from '../testing/music.js';
import { ytFixture } from '../testing/youtube.js';
import {
  createYouTubeRead,
  parseDuration,
  parsePlaylistItems,
  parseUploadsPlaylist,
  parseVideos,
  YouTubeConfigError,
  YouTubeReadError,
  type YtBudget,
} from './youtube-read.js';

const KEY = 'AIzaFAKEKEYFORTESTS000000000000000000';
const RH = 'UCq19-LqvG35A-30oyAiPiqA';

function client(reply: (url: URL) => { status?: number; body: unknown }, budgetFails = false) {
  const urls: URL[] = [];
  const order: string[] = [];
  const spend = vi.fn<YtBudget['spend']>(async () => {
    order.push('budget');
    if (budgetFails) throw new Error('budget exceeded');
  });
  const ev = memoryEvents();
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    order.push('fetch');
    const r = reply(url);
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  const yt = createYouTubeRead({ apiKey: KEY, events: ev.sink, budget: { spend }, fetch: fetchFn });
  return { yt, urls, order, spend, events: ev.events };
}

describe('응답 해석 (손으로 만든 응답, D-027)', () => {
  it('channels.list → uploads 재생목록 ID', () => {
    expect(parseUploadsPlaylist(ytFixture('channels-radiohead.json'))).toBe(
      'UUq19-LqvG35A-30oyAiPiqA',
    );
    expect(parseUploadsPlaylist({ items: [] })).toBeNull();
  });

  it('playlistItems.list → 영상 ID·게시 시각·다음 쪽', () => {
    const r = parsePlaylistItems(ytFixture('playlistitems-radiohead-p1.json'));
    expect(r.items[0]).toEqual({ videoId: 'rhKarmaMV01', publishedAt: '2024-03-01T12:00:00Z' });
    expect(r.items).toHaveLength(3);
    expect(r.nextPageToken).toBe('PAGE2');
    expect(
      parsePlaylistItems(ytFixture('playlistitems-radiohead-p2.json')).nextPageToken,
    ).toBeNull();
  });

  it('videos.list → 제목·채널·길이·공개 상태·퍼가기·아동용', () => {
    const [v] = parseVideos(ytFixture('videos-radiohead.json'));
    expect(v).toEqual({
      videoId: 'rhKarmaMV01',
      title: 'Radiohead - Karma Police (Official Music Video)',
      channelId: RH,
      channelTitle: 'Radiohead',
      description: 'The official video for Karma Police.',
      durationSec: 264,
      publishedAt: '2024-03-01T12:00:00Z',
      embeddable: true,
      madeForKids: false,
      privacyStatus: 'public',
    });
  });

  it('형식이 깨진 항목은 버린다 (영상 ID·채널 ID 형식)', () => {
    expect(
      parseVideos({
        items: [
          { id: 'short', snippet: { channelId: RH } },
          { id: 'aaaaaaaaaaa', snippet: { channelId: 'bad' } },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ['PT4M24S', 264],
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['P1DT1S', 86401],
    ['P0D', null],
    ['nonsense', null],
    [undefined, null],
  ])('기간 %s → %s초', (iso, sec) => {
    expect(parseDuration(iso)).toBe(sec);
  });
});

describe('요청과 한도', () => {
  it('호출 전에 한도를 먼저 쓰고(1단위), 한도에 막히면 요청을 보내지 않는다', async () => {
    const ok = client(() => ({ body: ytFixture('channels-radiohead.json') }));
    await ok.yt.uploadsPlaylist(RH);
    expect(ok.order).toEqual(['budget', 'fetch']);
    expect(ok.spend).toHaveBeenCalledWith({ ytUnits: 1 }, undefined);

    const blocked = client(() => ({ body: {} }), true);
    await expect(blocked.yt.uploadsPlaylist(RH)).rejects.toThrow('budget');
    expect(blocked.urls).toHaveLength(0);
  });

  it('영상 상세는 50개씩 나눠 요청한다 (요청당 1단위)', async () => {
    const c = client(() => ({ body: { items: [] } }));
    const ids = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
    await c.yt.videos(ids);
    expect(c.urls.map((u) => u.searchParams.get('id')?.split(',').length)).toEqual([50, 50, 20]);
    expect(c.spend).toHaveBeenCalledTimes(3);
    expect(c.urls[0]?.searchParams.get('part')).toBe('snippet,contentDetails,status');
  });

  it('검색은 단위를 쓰지 않고 하루 검색 횟수 한도(작업/사용자)만 쓴다 (D-007)', async () => {
    const c = client(() => ({ body: { items: [{ id: { videoId: 'abcdefghijk' } }] } }));
    expect(await c.yt.search('Radiohead Karma Police', { kind: 'job' })).toEqual(['abcdefghijk']);
    expect(c.spend).toHaveBeenLastCalledWith({ ytUnits: 0, ytSearchJob: 1 }, undefined);
    await c.yt.search('x', { kind: 'user', uid: 'alice' });
    expect(c.spend).toHaveBeenLastCalledWith(
      { ytUnits: 0, ytSearchUser: 1 },
      { uid: 'alice', searches: 1 },
    );
    expect(c.urls[0]?.searchParams.get('videoEmbeddable')).toBe('true');
  });

  it('요청은 GET이고, 키는 주소에만 있고 기록·오류에는 없다', async () => {
    const c = client(() => ({ status: 403, body: ytFixture('error-quota-exceeded.json') }));
    const err = await c.yt.uploadsPlaylist(RH).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeReadError);
    expect(err).toMatchObject({ status: 403, reason: 'quotaExceeded' });
    expect(c.urls[0]?.searchParams.get('key')).toBe(KEY);
    expect(String(err.message)).not.toContain(KEY);
    expect(JSON.stringify(c.events)).not.toContain(KEY);
    expect(c.events[0]).toMatchObject({
      type: 'external_call',
      outcome: 'error',
      attrs: { target: 'youtube_read', op: 'channels.list', units: 1, status: 403 },
    });
  });

  it('ID 형식이 틀리면 요청 전에 거부, 키가 없으면 시작하지 않는다', async () => {
    const c = client(() => ({ body: {} }));
    await expect(c.yt.uploadsPlaylist('../videos')).rejects.toBeInstanceOf(YouTubeConfigError);
    await expect(c.yt.uploadsPage('bad id!')).rejects.toBeInstanceOf(YouTubeConfigError);
    expect(c.urls).toHaveLength(0);
    expect(() =>
      createYouTubeRead({
        apiKey: '',
        events: memoryEvents().sink,
        budget: { spend: async () => undefined },
      }),
    ).toThrow(YouTubeConfigError);
  });
});
