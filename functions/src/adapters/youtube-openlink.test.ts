import { describe, expect, it } from 'vitest';
import { memoryEvents } from '../testing/music.js';
import { createOpenLinkChecker } from './youtube-openlink.js';

function setup(reply: { status: number; location?: string }) {
  const requests: { url: string; init?: RequestInit }[] = [];
  let cancelled = false;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: reply.status,
      headers: reply.location ? { location: reply.location } : {},
    });
  }) as typeof fetch;
  const spent: number[] = [];
  const ev = memoryEvents();
  const checker = createOpenLinkChecker({
    events: ev.sink,
    budget: { spend: async () => void spent.push(1) },
    fetch: fetchFn,
  });
  return {
    checker,
    requests,
    spent,
    events: ev.events,
    cancelled: () => cancelled,
  };
}

describe('createOpenLinkChecker', () => {
  it('watch_videos에 따라가지 않는 GET, 상한을 먼저 쓰고, 헤더만 보고 본문은 닫음', async () => {
    const s = setup({
      status: 303,
      location: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=TLGGabc',
    });
    expect(await s.checker.check(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])).toEqual({
      status: 303,
      listOk: true,
    });
    expect(s.spent).toEqual([1]);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.url).toBe(
      'https://www.youtube.com/watch_videos?video_ids=aaaaaaaaaaa,bbbbbbbbbbb',
    );
    expect(s.requests[0]?.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(s.requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(s.cancelled()).toBe(true);
    expect(s.events.find((e) => e.type === 'external_call')?.attrs).toMatchObject({
      target: 'youtube_link',
      op: 'watch_videos.check',
      status: 303,
    });
  });

  it('Location에 list=TL이 없으면 listOk false', async () => {
    const s = setup({ status: 303, location: 'https://www.youtube.com/' });
    expect(await s.checker.check(['aaaaaaaaaaa'])).toEqual({ status: 303, listOk: false });
  });

  it('답이 없으면 시간 제한으로 끊고 던짐(작업은 check_failed로 남김)', async () => {
    const checker = createOpenLinkChecker({
      events: memoryEvents().sink,
      budget: { spend: async () => {} },
      timeoutMs: 20,
      fetch: ((_u: string, init?: RequestInit) =>
        new Promise((_r, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        )) as typeof fetch,
    });
    await expect(checker.check(['aaaaaaaaaaa'])).rejects.toThrow();
  });

  it('상한에 막히면 요청하지 않음', async () => {
    const requests: string[] = [];
    const checker = createOpenLinkChecker({
      events: memoryEvents().sink,
      budget: {
        spend: async () => {
          throw new Error('budget exceeded');
        },
      },
      fetch: (async (u: string) => {
        requests.push(u);
        return new Response(null);
      }) as typeof fetch,
    });
    await expect(checker.check(['aaaaaaaaaaa'])).rejects.toThrow('budget exceeded');
    expect(requests).toEqual([]);
  });
});
