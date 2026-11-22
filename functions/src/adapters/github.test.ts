import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../core/budget.js';
import { fingerprint, type Finding } from '../core/detectors.js';
import { KillSwitchError } from '../core/runtimeConfig.js';
import { memoryEvents } from '../testing/music.js';
import {
  createIssueFiler,
  GITHUB_REPO,
  IssueContentError,
  renderIssue,
  type FingerprintRecord,
  type IssueBudget,
} from './github.js';

const TOKEN = 'test-token-not-real';
const NOW = new Date('2026-11-23T14:00:00Z'); // 태평양 시간 2026-11-23

interface Req {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** GitHub 흉내: 이슈 번호는 100부터. state는 issueStates로 바꿀 수 있다. */
function fakeGitHub(issueStates: Record<number, 'open' | 'closed'> = {}) {
  const requests: Req[] = [];
  let next = 100;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ method, url, headers: new Headers(init?.headers), body });
    const base = `https://api.github.com/repos/${GITHUB_REPO}/issues`;
    if (method === 'POST' && url === base) {
      const n = next++;
      return Response.json(
        { number: n, html_url: `https://github.com/${GITHUB_REPO}/issues/${n}` },
        { status: 201 },
      );
    }
    const get = new RegExp(`^${base}/(\\d+)$`).exec(url);
    if (method === 'GET' && get) {
      const n = Number(get[1]);
      return Response.json({ number: n, state: issueStates[n] ?? 'open' });
    }
    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(url)) {
      return Response.json({ id: 1 }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, requests };
}

function memoryStore(init: Record<string, FingerprintRecord> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    store: {
      get: async (fp: string) => data.get(fp) ?? null,
      set: async (fp: string, rec: FingerprintRecord) => void data.set(fp, rec),
    },
  };
}

/** 하루 이슈 생성 상한을 흉내: create는 limit번까지, call은 무제한. 순서를 기록한다. */
function countingBudget(limit = 5) {
  const log: string[] = [];
  let created = 0;
  const budget: IssueBudget = {
    create: async () => {
      if (created >= limit)
        throw new BudgetExceededError('service', 'autoIssues', limit, created, NOW);
      created++;
      log.push('create');
    },
    call: async () => void log.push('call'),
  };
  return { budget, log };
}

const finding = (key = 'ingest'): Finding => ({
  rule: 'job_failed',
  key,
  facts: { job: 'ingest', reason: 'failed', failed: 1, started: 1 },
});

function setup(
  opts: {
    states?: Record<number, 'open' | 'closed'>;
    store?: Record<string, FingerprintRecord>;
    limit?: number;
  } = {},
) {
  const gh = fakeGitHub(opts.states);
  const st = memoryStore(opts.store);
  const b = countingBudget(opts.limit);
  const ev = memoryEvents();
  const filer = createIssueFiler({
    token: TOKEN,
    events: ev.sink,
    budget: b.budget,
    store: st.store,
    fetch: gh.fetch,
    now: () => NOW,
  });
  return { filer, gh, st, b, ev };
}

describe('createIssueFiler: 새 문제', () => {
  it('이슈를 만들고 지문을 저장, 상한을 먼저 씀, 호출 기록', async () => {
    const s = setup();
    const r = await s.filer.file(finding());
    expect(r).toEqual({
      action: 'created',
      number: 100,
      url: `https://github.com/${GITHUB_REPO}/issues/100`,
    });
    expect(s.gh.requests).toHaveLength(1);
    const req = s.gh.requests[0] as Req;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.github.com/repos/${GITHUB_REPO}/issues`);
    expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(req.body).toMatchObject({ labels: ['auto-issue'] });
    expect(String(req.body?.title)).toContain('ingest');
    const fp = fingerprint(finding());
    expect(String(req.body?.body)).toContain(fp);
    expect(s.st.data.get(fp)).toEqual({
      issueNumber: 100,
      firstSeen: '2026-11-23',
      lastSeen: '2026-11-23',
      count: 1,
    });
    expect(s.b.log).toEqual(['create']);
    expect(s.ev.events.find((e) => e.type === 'external_call')?.attrs).toMatchObject({
      target: 'github',
      op: 'github.issues.create',
      status: 201,
    });
  });
});

describe('createIssueFiler: 같은 지문', () => {
  const fp = fingerprint(finding());
  const seen = (lastSeen: string): Record<string, FingerprintRecord> => ({
    [fp]: { issueNumber: 7, firstSeen: '2026-11-20', lastSeen, count: 2 },
  });

  it('기존 이슈가 열려 있으면 새 이슈 없이 댓글만, 횟수·마지막 날짜 갱신', async () => {
    const s = setup({ store: seen('2026-11-22') });
    const r = await s.filer.file(finding());
    expect(r).toMatchObject({ action: 'commented', number: 7 });
    expect(
      s.gh.requests.map((q) => `${q.method} ${q.url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')}`),
    ).toEqual(['GET /issues/7', 'POST /issues/7/comments']);
    expect(s.gh.requests.some((q) => q.method === 'POST' && q.url.endsWith('/issues'))).toBe(false);
    expect(s.st.data.get(fp)).toEqual({
      issueNumber: 7,
      firstSeen: '2026-11-20',
      lastSeen: '2026-11-23',
      count: 3,
    });
    expect(s.b.log).toEqual(['call', 'call']); // 생성 상한(autoIssues)은 쓰지 않음
  });

  it('오늘 이미 남겼으면 아무 호출도 하지 않음', async () => {
    const s = setup({ store: seen('2026-11-23') });
    expect(await s.filer.file(finding())).toMatchObject({ action: 'already_today', number: 7 });
    expect(s.gh.requests).toEqual([]);
    expect(s.b.log).toEqual([]);
  });

  it('기존 이슈가 닫혔으면(다시 생긴 문제) 새 이슈를 만들고 이전 번호를 적음', async () => {
    const s = setup({ store: seen('2026-11-22'), states: { 7: 'closed' } });
    const r = await s.filer.file(finding());
    expect(r).toMatchObject({ action: 'created', number: 100 });
    expect(String(s.gh.requests[1]?.body?.body)).toContain('#7');
    expect(s.st.data.get(fp)?.issueNumber).toBe(100);
  });
});

describe('createIssueFiler: 하루 5개', () => {
  it('6번째 새 이슈는 만들지 않음 (상한 오류, 요청 없음)', async () => {
    const s = setup({ limit: 5 });
    for (let i = 0; i < 5; i++) await s.filer.file(finding(`job${i}`));
    expect(s.gh.requests).toHaveLength(5);
    await expect(s.filer.file(finding('job5'))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.gh.requests).toHaveLength(5);
    expect(s.st.data.size).toBe(5);
  });

  it('긴급 정지면 요청 없이 멈춤', async () => {
    const gh = fakeGitHub();
    const filer = createIssueFiler({
      token: TOKEN,
      events: memoryEvents().sink,
      budget: {
        create: async () => {
          throw new KillSwitchError('autoIssue');
        },
        call: async () => {
          throw new KillSwitchError('autoIssue');
        },
      },
      store: memoryStore().store,
      fetch: gh.fetch,
      now: () => NOW,
    });
    await expect(filer.file(finding())).rejects.toBeInstanceOf(KillSwitchError);
    expect(gh.requests).toEqual([]);
  });
});

describe('createIssueFiler: GitHub 오류', () => {
  it('실패 응답이면 던지고 지문을 저장하지 않음', async () => {
    const st = memoryStore();
    const filer = createIssueFiler({
      token: TOKEN,
      events: memoryEvents().sink,
      budget: countingBudget().budget,
      store: st.store,
      fetch: (async () => new Response('{}', { status: 403 })) as typeof fetch,
      now: () => NOW,
    });
    await expect(filer.file(finding())).rejects.toThrow('403');
    expect(st.data.size).toBe(0);
  });

  it('기존 이슈가 지워졌으면(404) 닫힌 것으로 보고 새로 만듦', async () => {
    const fp = fingerprint(finding());
    const st = memoryStore({
      [fp]: { issueNumber: 7, firstSeen: '2026-11-20', lastSeen: '2026-11-22', count: 1 },
    });
    const gh = fakeGitHub();
    const f404 = (async (input: string | URL | Request, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? new Response('gone', { status: 404 })
        : gh.fetch(input, init)) as typeof fetch;
    const filer = createIssueFiler({
      token: TOKEN,
      events: memoryEvents().sink,
      budget: countingBudget().budget,
      store: st.store,
      fetch: f404,
      now: () => NOW,
    });
    expect(await filer.file(finding())).toMatchObject({ action: 'created', number: 100 });
    expect(st.data.get(fp)?.issueNumber).toBe(100);
  });

  it('조회가 다른 오류(500)면 던지고 새 이슈를 만들지 않음', async () => {
    const fp = fingerprint(finding());
    const st = memoryStore({
      [fp]: { issueNumber: 7, firstSeen: '2026-11-20', lastSeen: '2026-11-22', count: 1 },
    });
    const requests: string[] = [];
    const filer = createIssueFiler({
      token: TOKEN,
      events: memoryEvents().sink,
      budget: countingBudget().budget,
      store: st.store,
      fetch: (async (u: string, init?: RequestInit) => {
        requests.push(init?.method ?? 'GET');
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
      now: () => NOW,
    });
    await expect(filer.file(finding())).rejects.toThrow('500');
    expect(requests).toEqual(['GET']);
  });

  it('생성 응답에 번호가 없으면 던지고 지문을 저장하지 않음', async () => {
    const st = memoryStore();
    const filer = createIssueFiler({
      token: TOKEN,
      events: memoryEvents().sink,
      budget: countingBudget().budget,
      store: st.store,
      fetch: (async () => Response.json({}, { status: 201 })) as typeof fetch,
      now: () => NOW,
    });
    await expect(filer.file(finding())).rejects.toThrow();
    expect(st.data.size).toBe(0);
  });

  it('토큰이 비었으면 만들 수 없음', () => {
    expect(() =>
      createIssueFiler({
        token: '',
        events: memoryEvents().sink,
        budget: countingBudget().budget,
        store: memoryStore().store,
      }),
    ).toThrow();
  });
});

describe('금지 필드 검사', () => {
  it.each([
    ['검색 문장 필드', { query: 'rainy jazz' }],
    ['검색 문장 필드(짧은 값이어도 이름으로 거부)', { query: 'jazz' }],
    ['재생목록 이름 필드(짧은 값이어도)', { playlistName: 'mix1' }],
    ['검색어 필드(짧은 값이어도)', { text: 'lofi' }],
    ['재생목록 이름 필드', { playlistName: 'My Mix' }],
    ['이메일 필드', { email: 'x' }],
    ['uid 필드', { uid: 'abc' }],
    ['허용 필드에 문장', { job: 'rainy day jazz for studying' }],
    ['허용 필드에 이메일', { job: 'someone@example.com' }],
    ['허용 필드에 토큰 모양 값', { job: 'AbCdEfGhIjKlMnOpQrStUvWx' }],
    ['숫자가 아닌 값', { count: Number.NaN }],
  ])('거부하고 GitHub 호출 0건: %s', async (_n, facts) => {
    const s = setup();
    const bad = { rule: 'job_failed', key: 'ingest', facts } as Finding;
    await expect(s.filer.file(bad)).rejects.toBeInstanceOf(IssueContentError);
    expect(s.gh.requests).toEqual([]);
    expect(s.b.log).toEqual([]);
  });

  it('키에 문장이 들어가도 거부', async () => {
    const s = setup();
    await expect(
      s.filer.file({ rule: 'job_failed', key: 'my secret playlist', facts: {} }),
    ).rejects.toBeInstanceOf(IssueContentError);
    expect(s.gh.requests).toEqual([]);
  });

  it('만든 제목·본문에는 고정 문장과 허용한 사실만 들어감', () => {
    const f: Finding = {
      rule: 'job_failed',
      key: 'artist-a74b1b7f-71a5-4011-9441-d0b5e4122711',
      facts: {
        job: 'ingest',
        reason: 'artist_failed',
        artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      },
    };
    const { title, body } = renderIssue(f, fingerprint(f));
    expect(title).toMatch(/^\[auto\] /);
    expect(body).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    expect(body).toContain('artistMbid');
    expect(body).toContain(fingerprint(f));
  });
});
