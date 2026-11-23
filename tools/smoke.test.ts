import { describe, expect, it } from 'vitest';
import { callableUrl, SMOKE_CALLABLES, smoke, smokeOne } from './smoke';

function fakeFetch(byName: Record<string, { status: number; body: string } | Error>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = byName[url.split('/').pop() ?? ''] ?? {
      status: 401,
      body: '{"error":{"message":"Unauthenticated","status":"UNAUTHENTICATED"}}',
    };
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('배포 뒤 점검: App Check 없는 호출은 거부돼야 한다 (T23)', () => {
  it('주소 형식', () => {
    expect(callableUrl('p', 'us-central1', 'status-get')).toBe(
      'https://us-central1-p.cloudfunctions.net/status-get',
    );
  });

  it('401 + UNAUTHENTICATED만 통과, 빈 데이터로 POST', async () => {
    const { fn, calls } = fakeFetch({});
    const r = await smokeOne(fn, callableUrl('p', 'us-central1', 'health'), 'health');
    expect(r.ok).toBe(true);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"data":{}}');
  });

  it.each([
    ['열려 있음(200)', { status: 200, body: '{"result":{}}' }],
    ['없는 함수(404)', { status: 404, body: 'Not Found' }],
    ['다른 401', { status: 401, body: 'nope' }],
    [
      '로그인 확인의 401(App Check가 빠진 함수)',
      { status: 401, body: '{"error":{"message":"sign in required","status":"UNAUTHENTICATED"}}' },
    ],
  ])('%s → 실패', async (_l, resp) => {
    const { fn } = fakeFetch({ health: resp });
    expect((await smokeOne(fn, 'https://x/health', 'health')).ok).toBe(false);
  });

  it('연결 실패도 실패로 센다', async () => {
    const { fn } = fakeFetch({ health: new Error('ENOTFOUND') });
    const r = await smokeOne(fn, 'https://x/health', 'health');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ENOTFOUND');
  });

  it('로그인 없이 부르는 함수를 모두 포함하고 하나라도 열려 있으면 그 이름이 실패', async () => {
    for (const n of [
      'playlists-get',
      'site-config',
      'status-get',
      'songs-suggest',
      'playback-reportEmbedBlocked',
    ])
      expect(SMOKE_CALLABLES).toContain(n);
    const { fn } = fakeFetch({ 'site-config': { status: 200, body: '{}' } });
    const results = await smoke(fn, 'p');
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(['site-config']);
  });
});
