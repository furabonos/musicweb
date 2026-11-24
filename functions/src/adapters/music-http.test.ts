import { describe, expect, it } from 'vitest';
import { musicDeps } from '../testing/music.js';
import {
  createSourceClient,
  MusicConfigError,
  RateLimiter,
  SourceHttpError,
  SourceUnavailableError,
  userAgent,
  youtubeChannelId,
  youtubeVideoId,
} from './music-http.js';

const URL1 = 'https://musicbrainz.org/ws/2/recording/x?fmt=json';
const OP = 'musicbrainz.recording.get' as const;

describe('초당 1회 제한', () => {
  it('같은 출처에 연속으로 부르면 앞 요청 시작에서 1초가 지나야 다음이 나간다', async () => {
    const { deps, server } = musicDeps([{ body: { ok: 1 } }]);
    const client = createSourceClient('musicbrainz', deps);
    await Promise.all([client.get(URL1, OP), client.get(URL1, OP), client.get(URL1, OP)]);
    const gaps = server.requests.slice(1).map((r, i) => r.at - (server.requests[i]?.at ?? 0));
    expect(gaps).toEqual([1000, 1000]);
  });

  it('충분히 시간이 지난 뒤의 요청은 기다리지 않는다', async () => {
    const { deps, server } = musicDeps([{ body: {} }]);
    const client = createSourceClient('musicbrainz', deps);
    await client.get(URL1, OP);
    server.clock.advance(5000);
    await client.get(URL1, OP);
    expect(server.clock.sleeps).toEqual([]);
  });

  it('RateLimiter: pushBack은 1시간을 넘겨 미루지 않는다', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const l = new RateLimiter(
      1000,
      async (ms) => void sleeps.push((t += ms)),
      () => t,
    );
    await l.wait();
    l.pushBack(5 * 60 * 60 * 1000);
    await l.wait();
    expect(sleeps).toEqual([60 * 60 * 1000]);
  });

  it('ListenBrainz가 남은 횟수 0을 알리면 초기화 시간만큼 다음 요청을 미룬다', async () => {
    const { deps, server } = musicDeps([
      { body: [], headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-In': '7' } },
      { body: [] },
    ]);
    const client = createSourceClient('listenbrainz', deps);
    await client.get(URL1, 'listenbrainz.similarArtists');
    await client.get(URL1, 'listenbrainz.similarArtists');
    expect((server.requests[1]?.at ?? 0) - (server.requests[0]?.at ?? 0)).toBe(7000);
  });
});

describe('User-Agent 연락처', () => {
  it('요청마다 연락처가 든 User-Agent를 보낸다', async () => {
    const { deps, server } = musicDeps([{ body: {} }]);
    await createSourceClient('musicbrainz', deps).get(URL1, OP);
    expect(server.requests[0]?.headers.get('User-Agent')).toBe(
      'tunetrail/0.1 ( https://github.com/furabonos/musicweb )',
    );
  });

  it.each(['', '   ', 'a\r\nX-Injected: 1', 'x (y)'])(
    '연락처가 없거나 이상하면 시작하지 않는다: %j',
    (c) => {
      expect(() => userAgent(c)).toThrow(MusicConfigError);
      const { deps } = musicDeps([{ body: {} }]);
      expect(() => createSourceClient('musicbrainz', { ...deps, contact: c })).toThrow(
        MusicConfigError,
      );
    },
  );
});

describe('재시도와 실패 기록', () => {
  it('429가 계속되면 2번 더 시도한 뒤 실패하고, 시도마다 external_call과 마지막에 source_unavailable을 남긴다', async () => {
    const { deps, server, events, spent } = musicDeps([{ status: 429, body: {} }]);
    const err = await createSourceClient('listenbrainz', deps)
      .get(URL1, 'listenbrainz.similarRecordings')
      .catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err).toMatchObject({ source: 'listenbrainz', status: 429 });
    expect(server.requests).toHaveLength(3);
    expect(spent).toHaveLength(3); // 재시도도 한도를 쓴다
    expect(events.map((e) => [e.type, e.outcome, e.attrs.status])).toEqual([
      ['external_call', 'error', 429],
      ['external_call', 'error', 429],
      ['external_call', 'error', 429],
      ['source_unavailable', 'error', 429],
    ]);
  });

  it('Retry-After가 있으면 그만큼 쉬고, 없으면 2초·4초 쉰다', async () => {
    const a = musicDeps([{ status: 503, headers: { 'Retry-After': '5' } }, { body: { ok: true } }]);
    await createSourceClient('musicbrainz', a.deps).get(URL1, OP);
    expect((a.server.requests[1]?.at ?? 0) - (a.server.requests[0]?.at ?? 0)).toBe(5000);

    const b = musicDeps([{ status: 503 }, { status: 503 }, { body: { ok: true } }]);
    await createSourceClient('musicbrainz', b.deps).get(URL1, OP);
    const at = b.server.requests.map((r) => r.at);
    expect([(at[1] ?? 0) - (at[0] ?? 0), (at[2] ?? 0) - (at[1] ?? 0)]).toEqual([2000, 4000]);
  });

  it('Retry-After가 30초를 넘으면 재시도하지 않고 포기하되, 그 시간 동안 이 출처를 쉰다', async () => {
    const { deps, server } = musicDeps([
      { status: 429, headers: { 'Retry-After': '120' } },
      { body: {} },
    ]);
    const client = createSourceClient('musicbrainz', deps);
    await expect(client.get(URL1, OP)).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(server.requests).toHaveLength(1);
    await client.get(URL1, OP);
    expect((server.requests[1]?.at ?? 0) - (server.requests[0]?.at ?? 0)).toBe(120_000);
  });

  it('재시도를 다 쓰고 실패해도 다음 요청은 바로 나가지 않는다', async () => {
    const { deps, server } = musicDeps([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { body: {} },
    ]);
    const client = createSourceClient('musicbrainz', deps);
    await expect(client.get(URL1, OP)).rejects.toBeInstanceOf(SourceUnavailableError);
    await client.get(URL1, OP);
    const at = server.requests.map((r) => r.at);
    expect((at[3] ?? 0) - (at[2] ?? 0)).toBe(8000); // 2초·4초 다음 8초
  });

  it('본문을 받다가 끊겨도 연결 실패처럼 재시도한다', async () => {
    const { deps, server } = musicDeps([{ body: {} }]);
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream({ start: (c) => c.error(new Error('socket hang up')) });
        return new Response(body, { status: 200 });
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const r = await createSourceClient('musicbrainz', { ...deps, fetch: flaky }).get(URL1, OP);
    expect(r.body).toEqual({});
    expect(calls).toBe(2);
  });

  it('MusicBrainz "busy"(503) 뒤 성공하면 결과를 돌려준다', async () => {
    const { deps, events } = musicDeps([
      { status: 503, body: { error: 'The MusicBrainz web server is currently busy.' } },
      { body: { id: 'x' } },
    ]);
    const r = await createSourceClient('musicbrainz', deps).get(URL1, OP);
    expect(r.body).toEqual({ id: 'x' });
    expect(events.map((e) => e.outcome)).toEqual(['error', 'ok']);
  });

  it('연결 실패도 재시도하고, 다 실패하면 상태 없이 source_unavailable', async () => {
    const { deps, events } = musicDeps([{ network: true }]);
    const err = await createSourceClient('wikidata', deps)
      .get(URL1, 'wikidata.sparql')
      .catch((e) => e);
    expect(err).toMatchObject({ name: 'SourceUnavailableError', status: null });
    expect(events.at(-1)).toMatchObject({
      type: 'source_unavailable',
      attrs: { source: 'wikidata' },
    });
  });

  it('404 같은 다른 오류는 재시도하지 않는다', async () => {
    const { deps, server } = musicDeps([{ status: 404, body: { error: 'Not Found' } }]);
    const err = await createSourceClient('musicbrainz', deps)
      .get(URL1, OP)
      .catch((e) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err).toMatchObject({ status: 404 });
    expect(server.requests).toHaveLength(1);
  });

  it('한도에 닿으면 요청을 보내지 않는다', async () => {
    const { deps, server } = musicDeps([{ body: {} }], { budgetLimit: 0 });
    await expect(createSourceClient('musicbrainz', deps).get(URL1, OP)).rejects.toThrow('budget');
    expect(server.requests).toHaveLength(0);
  });

  it('기록·오류 메시지에 요청 주소(키가 들어갈 수 있음)를 넣지 않는다', async () => {
    const secretUrl = 'https://ws.audioscrobbler.com/2.0/?api_key=SECRETKEY123&method=x';
    const { deps, events } = musicDeps([{ status: 500 }]);
    const err = await createSourceClient('lastfm', deps)
      .get(secretUrl, 'lastfm.track.getSimilar')
      .catch((e) => e);
    expect(String(err.message)).not.toContain('SECRETKEY123');
    expect(JSON.stringify(events)).not.toContain('SECRETKEY123');
  });
});

describe('YouTube 주소 해석', () => {
  it.each([
    ['https://www.youtube.com/watch?v=1uYWYWPc9HU', '1uYWYWPc9HU'],
    ['https://youtu.be/1uYWYWPc9HU', '1uYWYWPc9HU'],
    ['https://music.youtube.com/watch?v=1uYWYWPc9HU&list=x', '1uYWYWPc9HU'],
    ['https://m.youtube.com/watch?v=1uYWYWPc9HU', '1uYWYWPc9HU'],
    ['https://www.youtube.com/watch?v=short', null],
    ['https://evil.example/watch?v=1uYWYWPc9HU', null],
    ['not a url', null],
  ])('영상: %s → %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    ['https://www.youtube.com/channel/UCq19-LqvG35A-30oyAiPiqA', 'UCq19-LqvG35A-30oyAiPiqA'],
    ['https://music.youtube.com/channel/UCr_iyUANcn9OX_yy9piYoLw', 'UCr_iyUANcn9OX_yy9piYoLw'],
    ['https://www.youtube.com/@radiohead', null],
    ['https://www.youtube.com/user/radiohead', null],
    ['https://evil.example/channel/UCq19-LqvG35A-30oyAiPiqA', null],
  ])('채널: %s → %s', (url, id) => {
    expect(youtubeChannelId(url)).toBe(id);
  });
});
