import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvent, type EventInput, type EventRecord } from '../core/events.js';
import {
  newRateLimiter,
  type CallBudget,
  type MusicHttpDeps,
  type MusicSource,
} from '../adapters/music-http.js';

/** 테스트 도우미 (배포 빌드에서 빠짐). 녹화 응답·가짜 서버·가짜 시계. */

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'music');
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
export const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

export const TEST_HASH_KEY = 'music-test-actor-hash-key-0123456789';

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 연결 실패 */
  network?: true;
}

/** 순서대로 답하는 가짜 서버. 마지막 답은 계속 반복한다. */
export function fakeServer(replies: FakeReply[]) {
  const requests: { url: string; headers: Headers; at: number }[] = [];
  let i = 0;
  const clock = fakeClock();
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), at: clock.now() });
    const r = replies[Math.min(i++, replies.length - 1)] ?? {};
    if (r.network) throw new TypeError('fetch failed');
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { fetch: fetchFn as unknown as typeof fetch, requests, clock };
}

/** 가짜 시계: sleep하면 시간이 그만큼 흐른다(실제로는 기다리지 않음). */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

export function memoryEvents() {
  const events: EventRecord[] = [];
  return {
    events,
    sink: { record: async (e: EventInput) => void events.push(buildEvent(e, TEST_HASH_KEY)) },
  };
}

export function countingBudget(limit = Infinity) {
  const spent: MusicSource[] = [];
  const budget: CallBudget = {
    spendCall: async (source) => {
      if (spent.length >= limit) throw new Error('budget exceeded');
      spent.push(source);
    },
  };
  return { budget, spent };
}

/** 가짜 서버·시계·기록·한도를 묶은 deps. */
export function musicDeps(replies: FakeReply[], opts: { budgetLimit?: number } = {}) {
  const server = fakeServer(replies);
  const ev = memoryEvents();
  const b = countingBudget(opts.budgetLimit);
  const deps: MusicHttpDeps = {
    events: ev.sink,
    budget: b.budget,
    contact: 'https://github.com/furabonos/musicweb',
    fetch: server.fetch,
    now: server.clock.now,
    limiter: newRateLimiter(server.clock.sleep, server.clock.now),
  };
  return { deps, server, events: ev.events, spent: b.spent };
}
