import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubReader, type GhIssue, type GhPull } from '../adapters/github.js';
import { memoryEvents } from '../testing/music.js';
import { computeGithubStats, prChanges, safeReason, type CiState } from './githubStats.js';

/** GitHub 수치 (SPEC 4.10, T21, D-042). 응답 모양은 tests/fixtures/github/README.md 참고. */
const fx = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/github/${name}`, 'utf8')) as unknown;
const issues = fx('issues.json') as GhIssue[];
const pulls = fx('pulls.json') as GhPull[];
const commits = fx('commits.json') as { sha: string; commit: { message: string } }[];
const checks = fx('check-runs.json') as Record<
  string,
  { check_runs: { name: string; status: string; conclusion: string | null }[] }
>;
const NOW = new Date('2026-11-23T12:00:00Z');
const ci = new Map<number, CiState>([
  [50, 'success'],
  [51, 'failure'],
  [52, 'success'],
  [53, 'pending'],
]);

describe('computeGithubStats', () => {
  const s = computeGithubStats({ issues, pulls, commits, ci, now: NOW });

  it('지난 30일 자동 이슈 수 (PR·다른 라벨·30일 전 제외)', () => {
    expect(s.autoIssues).toMatchObject({ value: 3, unit: 'count' });
  });
  it('승인 비율 = 합친 자동 수정 PR / (합친 + 거절)', () => {
    expect(s.approvalRate.value).toBe(0.667); // 2 / 3, 열린 PR·사람 PR·30일 전 PR 제외
  });
  it('거절 사유는 reject: 라벨에서', () => {
    expect(s.rejectReasons).toEqual([{ reason: 'wrong fix', count: 1 }]);
  });
  it('수정까지 걸린 시간 = 이슈 생성 → PR 합침의 중앙값(시간)', () => {
    expect(s.hoursToFix).toMatchObject({ value: 32.5, unit: 'hours' }); // 29h, 36h
  });
  it('되돌린 비율 = main에서 되돌린 합친 PR / 합친 PR', () => {
    expect(s.revertRate.value).toBe(0.5); // #50 되돌림
  });
  it('CI 통과 비율 = 끝난 CI 중 성공', () => {
    expect(s.ciPassRate.value).toBe(0.667); // 최근 10건 중 끝난 3건, 진행 중(#53) 제외
  });
  it('최근 자동 수정 10건: 최신순, 상태·CI·링크·되돌림·거절 사유', () => {
    expect(s.recent.map((r) => r.number)).toEqual([53, 52, 51, 50, 20]);
    expect(s.recent[0]).toEqual({
      number: 53,
      url: 'https://github.com/furabonos/musicweb/pull/53',
      state: 'open',
      ci: 'pending',
      openedAt: '2026-11-23T10:00:00Z',
      reverted: false,
      rejectReason: null,
    });
    expect(s.recent.find((r) => r.number === 50)).toMatchObject({
      state: 'merged',
      reverted: true,
    });
    expect(s.recent.find((r) => r.number === 51)).toMatchObject({
      state: 'rejected',
      rejectReason: 'wrong fix',
    });
  });
  it('숫자마다 계산 방법', () => {
    for (const k of [
      'autoIssues',
      'approvalRate',
      'hoursToFix',
      'revertRate',
      'ciPassRate',
    ] as const) {
      expect(s[k].method.length).toBeGreaterThan(20);
    }
  });

  it('자동 수정 PR이 없으면 비율·시간은 null', () => {
    const empty = computeGithubStats({
      issues: [],
      pulls: [],
      commits: [],
      ci: new Map(),
      now: NOW,
    });
    expect(empty.approvalRate.value).toBeNull();
    expect(empty.hoursToFix.value).toBeNull();
    expect(empty.revertRate.value).toBeNull();
    expect(empty.ciPassRate.value).toBeNull();
    expect(empty.autoIssues.value).toBe(0);
    expect(empty.recent).toEqual([]);
  });
});

describe('safeReason', () => {
  it('라벨 글자를 짧은 낱말로만 받는다(운영 일지·현황판에 자유 글이 들어가지 않게)', () => {
    expect(safeReason('reject: wrong fix')).toBe('wrong fix');
    expect(safeReason('reject:Too-Big')).toBe('too-big');
    expect(safeReason('reject: someone@example.com')).toBe('other');
    expect(safeReason('reject: ' + 'x'.repeat(60))).toBe('other');
    expect(safeReason('bug')).toBeNull();
    // 운영 일지가 거부하는 20자 넘는 영숫자 덩어리는 받지 않는다(작업이 매일 실패하지 않게)
    expect(safeReason('reject: abcdefghij0123456789xyz')).toBe('other');
  });
});

describe('prChanges (운영 일지)', () => {
  const s = computeGithubStats({ issues, pulls, commits, ci, now: NOW });
  it('처음 보는 PR·상태가 바뀐 PR만 일지에 남긴다', () => {
    const prev = { 50: 'merged', 51: 'open:pending', 52: 'merged' } as const;
    const changes = prChanges(s.recent, prev);
    expect(changes.map((c) => [c.number, c.message])).toEqual([
      [53, 'Auto-fix PR opened; CI pending.'],
      [51, 'Auto-fix PR closed without merging (reason: wrong fix); CI failure.'],
      [50, 'Auto-fix PR was reverted on main.'],
      [20, 'Auto-fix PR merged; CI unknown.'],
    ]);
    expect(changes[0]?.links).toEqual(['https://github.com/furabonos/musicweb/pull/53']);
  });
  it('되돌린 PR은 되돌렸다고 남긴다', () => {
    const changes = prChanges(s.recent, {
      50: 'merged',
      51: 'rejected',
      52: 'merged',
      53: 'open:pending',
      20: 'merged',
    });
    expect(changes).toEqual([
      expect.objectContaining({ number: 50, message: 'Auto-fix PR was reverted on main.' }),
    ]);
    // 이미 되돌림을 남긴 PR은 다시 남기지 않는다
    expect(
      prChanges(s.recent, {
        50: 'reverted',
        51: 'rejected',
        52: 'merged',
        53: 'open:pending',
        20: 'merged',
      }),
    ).toEqual([]);
  });
});

describe('createGitHubReader', () => {
  const route = (url: string) => {
    if (url.includes('/issues?')) return issues;
    if (url.includes('/pulls?')) return pulls;
    if (url.includes('/commits?')) return commits;
    const m = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(url);
    if (m) return checks[m[1] ?? ''];
    return undefined;
  };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const body = route(String(url));
    return body === undefined
      ? new Response('no', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });

  it('호출마다 상한을 먼저 쓰고 기록을 남긴다. 토큰은 기록에 없다', async () => {
    const ev = memoryEvents();
    const call = vi.fn(async () => {});
    const r = createGitHubReader({ token: 'tok-secret', events: ev.sink, budget: { call }, fetch });
    expect(await r.listIssues(new Date('2026-10-24T12:00:00Z'))).toHaveLength(issues.length);
    expect(await r.listPulls()).toHaveLength(pulls.length);
    expect(await r.listMainCommits(new Date('2026-10-24T12:00:00Z'))).toHaveLength(3);
    expect(await r.ciState('bbbb000000000000000000000000000000000002')).toBe('failure');
    expect(await r.ciState('bbbb000000000000000000000000000000000004')).toBe('pending');
    expect(call).toHaveBeenCalledTimes(5);
    expect(ev.events.map((e) => e.attrs.op)).toEqual([
      'github.issues.list',
      'github.pulls.list',
      'github.commits.list',
      'github.checks.list',
      'github.checks.list',
    ]);
    expect(JSON.stringify(ev.events)).not.toContain('tok-secret');
    const urls = fetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('state=all');
    expect(urls[0]).toContain('since=2026-10-24T12%3A00%3A00Z');
    expect(urls[2]).toContain('sha=main');
  });

  it('상한에 걸리면 요청하지 않는다', async () => {
    fetch.mockClear();
    const r = createGitHubReader({
      token: 't',
      events: memoryEvents().sink,
      budget: {
        call: async () => {
          throw new Error('limit');
        },
      },
      fetch,
    });
    await expect(r.listPulls()).rejects.toThrow('limit');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('CI 기록이 없으면 unknown', async () => {
    const r = createGitHubReader({
      token: 't',
      events: memoryEvents().sink,
      budget: { call: async () => {} },
      fetch,
    });
    fetch.mockImplementationOnce(
      async () => new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 }),
    );
    expect(await r.ciState('bbbb000000000000000000000000000000000001')).toBe('unknown');
  });
});

describe('prChanges: 열린 PR의 CI 결과', () => {
  it('열린 채로 CI가 끝나면 한 줄 남긴다', () => {
    const recent = [
      {
        number: 7,
        url: 'https://github.com/furabonos/musicweb/pull/7',
        state: 'open' as const,
        ci: 'failure' as const,
        openedAt: '2026-11-23T10:00:00Z',
        reverted: false,
        rejectReason: null,
      },
    ];
    expect(prChanges(recent, { 7: 'open:pending' }).map((c) => c.message)).toEqual([
      'Auto-fix PR CI is now failure.',
    ]);
    expect(prChanges(recent, { 7: 'open:failure' })).toEqual([]);
  });
});
