import type { Firestore } from 'firebase-admin/firestore';
import { consume } from '../core/budget.js';
import { pacificDay } from '../core/day.js';
import { fingerprint, RULES, type Finding, type Rule } from '../core/detectors.js';
import { OPAQUE_TOKEN, recordCall, type EventSink } from '../core/events.js';

/**
 * 자동 이슈 (SPEC 4.9, T19, D-037). GitHub REST API로 이 저장소에만 쓴다.
 * - 같은 지문(issueFingerprints/{fp})이 있고 그 이슈가 열려 있으면 새 이슈 없이 댓글만 단다. 닫혔으면 새로 만든다.
 *   같은 날 두 번째부터는 아무 호출도 하지 않는다(작업을 다시 돌려도 댓글이 쌓이지 않게).
 * - 호출 전에 상한을 쓴다: 새 이슈는 autoIssues(하루 5) + githubCalls, 조회·댓글은 githubCalls.
 *   상한 확인과 같은 트랜잭션에서 긴급 정지(autoIssue)도 본다 → 꺼져 있으면 요청 0건.
 * - 제목·본문은 코드가 만든 고정 영어 문장 + 허용한 사실(숫자·짧은 ID)만. 검색 문장·재생목록 이름·이메일·uid는
 *   필드 이름(허용 목록)과 값 모양 두 겹으로 막는다. 검사는 상한·요청보다 먼저 한다.
 */
export const GITHUB_REPO = 'furabonos/musicweb';
const API = `https://api.github.com/repos/${GITHUB_REPO}`;
export const ISSUE_LABELS = ['auto-issue'];
export const GITHUB_TIMEOUT_MS = 10_000;

export interface FingerprintRecord {
  issueNumber: number;
  /** 태평양 시간 날짜 yyyy-mm-dd */
  firstSeen: string;
  lastSeen: string;
  count: number;
}
export interface FingerprintStore {
  get(fp: string): Promise<FingerprintRecord | null>;
  set(fp: string, rec: FingerprintRecord): Promise<void>;
}
export interface IssueBudget {
  /** 새 이슈 1개 (autoIssues + githubCalls) */
  create(): Promise<void>;
  /** 조회·댓글 1회 (githubCalls) */
  call(): Promise<void>;
}

export type FileResult = {
  action: 'created' | 'commented' | 'already_today';
  number: number;
  url: string;
};

export class IssueContentError extends Error {
  override name = 'IssueContentError';
}
export class GitHubError extends Error {
  override name = 'GitHubError';
  constructor(readonly status: number) {
    super(`GitHub 요청 실패: ${status}`);
  }
}

/** 이슈에 넣어도 되는 사실 이름. 새 감지 규칙이 다른 이름을 쓰면 여기에 더한다(자유 텍스트 필드는 금지). */
export const ALLOWED_FACTS = new Set([
  'job',
  'reason',
  'count',
  'threshold',
  'failed',
  'total',
  'rate',
  'priorRate',
  'suite',
  'score',
  'baseline',
  'tolerance',
  'started',
  'finished',
  'artistMbid',
]);
const SHORT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function assertSafeId(value: string, where: string) {
  if (!SHORT_ID.test(value) || EMAIL.test(value) || OPAQUE_TOKEN.test(value)) {
    throw new IssueContentError(
      `${where}: 짧은 식별자(영문·숫자·_.:-, 64자 이하)만 넣습니다. 문장·이메일·토큰 모양 값은 이슈에 넣지 않습니다.`,
    );
  }
}

/** 감지 결과를 검사한다. 문제가 있으면 IssueContentError(요청 전에). */
export function assertSafeFinding(f: Finding): void {
  if (!(RULES as readonly string[]).includes(f.rule)) {
    throw new IssueContentError(`모르는 규칙: ${String(f.rule)}`);
  }
  assertSafeId(f.key, 'key');
  for (const [k, v] of Object.entries(f.facts)) {
    if (!ALLOWED_FACTS.has(k)) {
      throw new IssueContentError(
        `사실 '${k}'는 허용 목록에 없습니다. 검색 문장·재생목록 이름·계정 정보는 이슈에 넣지 않습니다. 숫자·ID 사실이면 ALLOWED_FACTS에 더하세요.`,
      );
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new IssueContentError(`사실 '${k}'가 유한한 숫자가 아닙니다.`);
    } else if (typeof v === 'string') {
      assertSafeId(v, `facts.${k}`);
    } else {
      throw new IssueContentError(`사실 '${k}'는 숫자나 짧은 ID만 됩니다.`);
    }
  }
}

const TITLES: Record<Rule, (f: Finding) => string> = {
  title_split_failed: () => 'Video titles could not be split into artist and song',
  broken_link: () => 'Players report videos that cannot be embedded',
  unofficial_link: () => 'Non-official videos are linked as active',
  parse_failure_spike: () => 'Request parsing failures spiked',
  eval_drop: (f) => `Test score dropped: ${String(f.facts.suite ?? f.key)}`,
  open_link_broken: () => 'Open-in-YouTube link is broken',
  job_failed: (f) => `Scheduled job failed: ${f.key}`,
};

const WHAT: Record<Rule, string> = {
  title_split_failed:
    'Ingest could not split many video titles into artist and song in the last 24 hours. Check the title rules (song-matching skill).',
  broken_link:
    'Players reported error 101/150 (embedding not allowed) several times in the last 24 hours. Linked videos may need re-checking.',
  unofficial_link:
    'Active links include cover or other videos, which the matching rules should never link.',
  parse_failure_spike:
    'Share of requests the AI could not parse is much higher than usual in the last 24 hours.',
  eval_drop: 'The daily test score is below the baseline in evals/baseline.json.',
  open_link_broken:
    'The daily link check found the watch_videos link broken; the site switched to per-song links.',
  job_failed: 'A scheduled job failed or did not finish in the last 24 hours.',
};

function factsTable(f: Finding): string {
  const rows = Object.entries(f.facts).map(([k, v]) => `| ${k} | ${String(v)} |`);
  return rows.length ? ['| fact | value |', '| --- | --- |', ...rows].join('\n') : '';
}

/** 검사한 뒤 이슈 제목·본문을 만든다. */
export function renderIssue(
  f: Finding,
  fp: string,
  previous?: number,
): { title: string; body: string } {
  assertSafeFinding(f);
  const body = [
    WHAT[f.rule],
    '',
    factsTable(f),
    '',
    ...(previous
      ? [`Previously reported in #${previous} (closed); the problem came back.`, '']
      : []),
    `Rule: \`${f.rule}\` · Fingerprint: \`${fp}\``,
    '',
    '_Opened automatically by musicweb auto-issue (T19). Repeats of the same problem are added as comments._',
  ].join('\n');
  return { title: `[auto] ${TITLES[f.rule](f)}`, body };
}

function renderComment(f: Finding, day: string): string {
  return [`Seen again on ${day} (Pacific).`, '', factsTable(f)].join('\n');
}

export function createIssueFiler(deps: {
  token: string;
  events: EventSink;
  budget: IssueBudget;
  store: FingerprintStore;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}) {
  if (!deps.token) throw new Error('GITHUB_ISSUE_TOKEN이 비었습니다.');
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  const request = async <T>(
    op: 'github.issues.create' | 'github.issues.get' | 'github.issues.comment',
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> =>
    recordCall(
      deps.events,
      { target: 'github', op },
      async () => {
        const res = await f(`${API}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${deps.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'musicweb-auto-issue',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(deps.timeoutMs ?? GITHUB_TIMEOUT_MS),
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new GitHubError(res.status);
        }
        return { result: (await res.json()) as T, status: res.status };
      },
      (err) => (err instanceof GitHubError ? { status: err.status } : {}),
    );

  const issueUrl = (n: number) => `https://github.com/${GITHUB_REPO}/issues/${n}`;

  return {
    async file(finding: Finding): Promise<FileResult> {
      const fp = fingerprint(finding);
      // 내용 검사가 먼저: 금지 필드가 있으면 상한도 쓰지 않고 요청도 하지 않는다
      renderIssue(finding, fp);
      const day = pacificDay(now());
      const rec = await deps.store.get(fp);

      if (rec && rec.lastSeen === day) {
        return { action: 'already_today', number: rec.issueNumber, url: issueUrl(rec.issueNumber) };
      }
      if (rec) {
        await deps.budget.call();
        // 지운·옮긴 이슈(404·410)는 닫힌 것으로 보고 새로 만든다: 그러지 않으면 이 지문은 영원히 막힌다
        const issue = await request<{ state: string }>(
          'github.issues.get',
          'GET',
          `/issues/${rec.issueNumber}`,
        ).catch((err: unknown) => {
          if (err instanceof GitHubError && (err.status === 404 || err.status === 410))
            return { state: 'gone' };
          throw err;
        });
        if (issue.state === 'open') {
          await deps.budget.call();
          await request('github.issues.comment', 'POST', `/issues/${rec.issueNumber}/comments`, {
            body: renderComment(finding, day),
          });
          await deps.store.set(fp, { ...rec, lastSeen: day, count: rec.count + 1 });
          return { action: 'commented', number: rec.issueNumber, url: issueUrl(rec.issueNumber) };
        }
      }

      const { title, body } = renderIssue(finding, fp, rec?.issueNumber);
      await deps.budget.create();
      const created = await request<{ number: number }>('github.issues.create', 'POST', '/issues', {
        title,
        body,
        labels: ISSUE_LABELS,
      });
      if (!Number.isInteger(created.number)) throw new GitHubError(0);
      await deps.store.set(fp, {
        issueNumber: created.number,
        firstSeen: day,
        lastSeen: day,
        count: (rec?.count ?? 0) + 1,
      });
      return { action: 'created', number: created.number, url: issueUrl(created.number) };
    },
  };
}
export type IssueFiler = ReturnType<typeof createIssueFiler>;

/** 운영용: issueFingerprints/{fp} (서버 전용, 보안 규칙에 match 없음) */
export function firestoreFingerprintStore(db: Firestore): FingerprintStore {
  return {
    async get(fp) {
      const snap = await db.doc(`issueFingerprints/${fp}`).get();
      if (!snap.exists) return null;
      const d = snap.data() as Partial<FingerprintRecord>;
      if (
        !Number.isInteger(d.issueNumber) ||
        typeof d.firstSeen !== 'string' ||
        typeof d.lastSeen !== 'string' ||
        !Number.isInteger(d.count)
      ) {
        throw new Error(`issueFingerprints/${fp} 형식이 잘못됐습니다.`);
      }
      return d as FingerprintRecord;
    },
    set: async (fp, rec) => {
      await db.doc(`issueFingerprints/${fp}`).set(rec);
    },
  };
}

/** 운영용 상한: 같은 트랜잭션에서 긴급 정지(autoIssue)도 확인한다. */
export function firestoreIssueBudget(db: Firestore): IssueBudget {
  return {
    create: () => consume(db, { service: { autoIssues: 1, githubCalls: 1 }, feature: 'autoIssue' }),
    call: () => consume(db, { service: { githubCalls: 1 }, feature: 'autoIssue' }),
  };
}

/** GitHub 응답 중 현황판에 쓰는 필드 (T21) */
export interface GhIssue {
  number: number;
  created_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
}
export interface GhPull {
  number: number;
  state: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  body: string | null;
  labels: { name: string }[];
  html_url: string;
}
export interface GhCommit {
  sha: string;
  commit: { message: string };
}

export interface GitHubReadBudget {
  /** 요청 한 번마다 githubCalls 1 */
  call(): Promise<void>;
}

/**
 * GitHub 읽기 (현황판 수치, T21, D-042). 이 저장소만, 읽기만. 요청마다 githubCalls 상한을 먼저 쓴다.
 * 한 번 실행에 이슈 1 + PR 1 + 커밋 1 + CI(최근 자동 수정 PR 최대 10) = 최대 13회.
 */
export function createGitHubReader(deps: {
  token: string;
  events: EventSink;
  budget: GitHubReadBudget;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  if (!deps.token) throw new Error('GitHub 토큰이 비었습니다.');
  const f = deps.fetch ?? fetch;
  const get = async <T>(
    op: 'github.issues.list' | 'github.pulls.list' | 'github.commits.list' | 'github.checks.list',
    path: string,
  ): Promise<T> => {
    await deps.budget.call();
    return recordCall(
      deps.events,
      { target: 'github', op },
      async () => {
        const res = await f(`${API}${path}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${deps.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'musicweb-status',
          },
          signal: AbortSignal.timeout(deps.timeoutMs ?? GITHUB_TIMEOUT_MS),
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new GitHubError(res.status);
        }
        return { result: (await res.json()) as T, status: res.status };
      },
      (err) => (err instanceof GitHubError ? { status: err.status } : {}),
    );
  };
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    listIssues: (since: Date) =>
      get<GhIssue[]>(
        'github.issues.list',
        `/issues?${new URLSearchParams({ state: 'all', since: iso(since), per_page: '100' })}`,
      ),
    listPulls: () =>
      get<GhPull[]>(
        'github.pulls.list',
        `/pulls?${new URLSearchParams({ state: 'all', sort: 'created', direction: 'desc', per_page: '100' })}`,
      ),
    listMainCommits: (since: Date) =>
      get<GhCommit[]>(
        'github.commits.list',
        `/commits?${new URLSearchParams({ sha: 'main', since: iso(since), per_page: '100' })}`,
      ),
    /** 그 커밋의 필수 검사 "ci" 결과 */
    async ciState(sha: string): Promise<'success' | 'failure' | 'pending' | 'unknown'> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('커밋 해시가 이상합니다.');
      const r = await get<{ check_runs: { status: string; conclusion: string | null }[] }>(
        'github.checks.list',
        `/commits/${sha}/check-runs?${new URLSearchParams({ check_name: 'ci', per_page: '1' })}`,
      );
      const run = r.check_runs[0];
      if (!run) return 'unknown';
      if (run.status !== 'completed') return 'pending';
      return run.conclusion === 'success' ? 'success' : 'failure';
    },
  };
}
export type GitHubReader = ReturnType<typeof createGitHubReader>;

/** 현황판 GitHub 읽기 상한: githubCalls(자동 이슈와 같이 씀). 긴급 정지 대상은 아니다(읽기만). */
export function firestoreGitHubReadBudget(db: Firestore): GitHubReadBudget {
  return { call: () => consume(db, { service: { githubCalls: 1 } }) };
}
