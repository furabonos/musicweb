import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_FIX_LABEL,
  DAILY_AUTO_FIX_LIMIT,
  countRunsToday,
  decideAutoFix,
  pacificDayStart,
  runGate,
  type GateInput,
} from './auto-fix-gate.ts';

/** 자동 수정 관문 (SPEC 4.9, T20, D-038): Claude를 부르기 전에 실행 여부를 정한다. */
const base: GateInput = {
  label: AUTO_FIX_LABEL,
  isPullRequest: false,
  issueOpen: true,
  hasToken: true,
  senderPermission: 'admin',
  authorPermission: 'admin',
  runsToday: 0,
};

describe('decideAutoFix', () => {
  it('조건이 모두 맞으면 실행', () => {
    expect(decideAutoFix(base)).toEqual({ ok: true });
  });

  it('다른 라벨이면 조용히 건너뛴다(댓글 없음)', () => {
    expect(decideAutoFix({ ...base, label: 'bug' })).toMatchObject({ ok: false, comment: null });
  });

  it('PR·닫힌 이슈는 건너뛴다', () => {
    expect(decideAutoFix({ ...base, isPullRequest: true }).ok).toBe(false);
    expect(decideAutoFix({ ...base, issueOpen: false }).ok).toBe(false);
  });

  it.each(['read', 'triage', 'none', ''])('라벨 붙인 사람 권한이 %s면 거부', (p) => {
    const r = decideAutoFix({ ...base, senderPermission: p });
    expect(r.ok).toBe(false);
  });

  it.each(['read', 'none'])(
    '이슈 작성자 권한이 %s면 거부(남이 쓴 글을 Claude에게 일감으로 주지 않음)',
    (p) => {
      const r = decideAutoFix({ ...base, authorPermission: p });
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.comment).toMatch(/작성자/);
    },
  );

  it('write·maintain도 허용', () => {
    expect(
      decideAutoFix({ ...base, senderPermission: 'write', authorPermission: 'maintain' }).ok,
    ).toBe(true);
  });

  it('토큰이 없으면 거부하고 등록 방법을 알린다', () => {
    const r = decideAutoFix({ ...base, hasToken: false });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.comment).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it(`하루 ${DAILY_AUTO_FIX_LIMIT}회까지만`, () => {
    expect(decideAutoFix({ ...base, runsToday: DAILY_AUTO_FIX_LIMIT - 1 }).ok).toBe(true);
    const r = decideAutoFix({ ...base, runsToday: DAILY_AUTO_FIX_LIMIT });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.comment).toMatch(/상한/);
  });
});

describe('pacificDayStart', () => {
  it('여름(PDT, UTC-7)', () => {
    expect(pacificDayStart(new Date('2026-07-01T06:59:00Z')).toISOString()).toBe(
      '2026-06-30T07:00:00.000Z',
    );
    expect(pacificDayStart(new Date('2026-07-01T07:00:00Z')).toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
  });
  it('서머타임 시작·끝나는 날(그날 0시는 바뀌기 전 시간 기준)', () => {
    // 2026-03-08 02:00 PST → 03:00 PDT. 그날 0시는 PST(UTC-8)
    expect(pacificDayStart(new Date('2026-03-08T20:00:00Z')).toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    // 2026-11-01 02:00 PDT → 01:00 PST. 그날 0시는 PDT(UTC-7)
    expect(pacificDayStart(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
  });
  it('겨울(PST, UTC-8)', () => {
    expect(pacificDayStart(new Date('2026-11-23T12:00:00Z')).toISOString()).toBe(
      '2026-11-23T08:00:00.000Z',
    );
  });
});

type Route = (url: string, init?: RequestInit) => unknown;
const fakeFetch = (route: Route) =>
  vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = route(String(url), init);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });

describe('countRunsToday', () => {
  const since = new Date('2026-11-23T08:00:00Z');
  const jobs: Record<number, { name: string; conclusion: string | null }[]> = {
    1: [
      { name: 'gate', conclusion: 'success' },
      { name: 'fix', conclusion: 'success' },
    ],
    2: [
      { name: 'gate', conclusion: 'success' },
      { name: 'fix', conclusion: 'skipped' },
    ],
    3: [
      { name: 'gate', conclusion: 'success' },
      { name: 'fix', conclusion: 'failure' },
    ],
    4: [{ name: 'gate', conclusion: null }],
  };
  const route: Route = (url) => {
    if (url.includes('/actions/workflows/auto-fix.yml/runs')) {
      expect(url).toContain(`created=%3E%3D${encodeURIComponent('2026-11-23T08:00:00Z')}`);
      return { workflow_runs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
    }
    const m = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    if (m) return { jobs: jobs[Number(m[1])] };
  };

  it('수정 job이 실제로 돈 실행만 센다(관문에서 멈춘 실행·지금 실행 제외)', async () => {
    const fetch = fakeFetch(route);
    const n = await countRunsToday({
      fetch,
      token: 't',
      repo: 'o/r',
      currentRunId: 4,
      since,
    });
    expect(n).toBe(2); // 1(성공), 3(실패). 2는 건너뜀, 4는 지금 실행
    expect(fetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('/runs/4/jobs'),
    );
  });

  it('GitHub 응답이 실패면 던진다(막는 쪽으로 실패)', async () => {
    await expect(
      countRunsToday({
        fetch: fakeFetch(() => undefined),
        token: 't',
        repo: 'o/r',
        currentRunId: 9,
        since,
      }),
    ).rejects.toThrow(/404/);
  });
});

describe('runGate', () => {
  const event = {
    label: { name: AUTO_FIX_LABEL },
    issue: { number: 7, state: 'open', user: { login: 'owner' } },
    sender: { login: 'owner' },
  };
  const perms: Record<string, string> = { owner: 'admin', stranger: 'read' };

  const github = (runs: number) => {
    const posted: string[] = [];
    const fetch = fakeFetch((url, init) => {
      const p = /\/collaborators\/([^/]+)\/permission/.exec(url);
      if (p) return { permission: perms[decodeURIComponent(p[1] ?? '')] ?? 'none' };
      if (url.includes('/actions/workflows/')) {
        return { workflow_runs: Array.from({ length: runs }, (_, i) => ({ id: 100 + i })) };
      }
      if (url.includes('/jobs')) return { jobs: [{ name: 'fix', conclusion: 'success' }] };
      if (url.endsWith('/issues/7/comments') && init?.method === 'POST') {
        posted.push((JSON.parse(String(init.body)) as { body: string }).body);
        return { id: 1 };
      }
    });
    return { fetch, posted };
  };
  const env = {
    token: 't',
    repo: 'o/r',
    runId: 999,
    hasToken: true,
    now: new Date('2026-11-23T20:00:00Z'),
  };

  it('통과하면 댓글 없이 ok', async () => {
    const g = github(0);
    expect(await runGate({ ...env, event, fetch: g.fetch })).toEqual({ ok: true });
    expect(g.posted).toEqual([]);
  });

  it('남이 쓴 이슈에 관리자가 라벨을 붙여도 거부하고 이유를 댓글로 남긴다', async () => {
    const g = github(0);
    const r = await runGate({
      ...env,
      event: { ...event, issue: { ...event.issue, user: { login: 'stranger' } } },
      fetch: g.fetch,
    });
    expect(r.ok).toBe(false);
    expect(g.posted).toHaveLength(1);
    expect(g.posted[0]).toMatch(/작성자/);
  });

  it('오늘 상한에 닿으면 거부', async () => {
    const g = github(DAILY_AUTO_FIX_LIMIT);
    expect((await runGate({ ...env, event, fetch: g.fetch })).ok).toBe(false);
    expect(g.posted[0]).toMatch(/상한/);
  });

  it('다른 라벨이면 GitHub을 부르지 않는다', async () => {
    const g = github(0);
    const r = await runGate({
      ...env,
      event: { ...event, label: { name: 'bug' } },
      fetch: g.fetch,
    });
    expect(r.ok).toBe(false);
    expect(g.fetch).not.toHaveBeenCalled();
  });
});
