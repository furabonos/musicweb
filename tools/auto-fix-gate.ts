import { appendFileSync, readFileSync } from 'node:fs';

/**
 * 자동 수정 관문 (SPEC 4.9, T20, D-038). auto-fix.yml의 gate job이 Claude를 부르기 전에 실행한다.
 * - 라벨 붙인 사람과 이슈 작성자 모두 저장소 쓰기 권한이 있어야 한다.
 *   공개 저장소라 누구나 이슈를 쓸 수 있다. 남이 쓴 글을 Claude에게 일감으로 넘기지 않는다
 *   (자동 이슈는 저장소 주인의 토큰으로 만들어지므로 통과한다).
 * - 하루(태평양 시간) 수정 실행은 DAILY_AUTO_FIX_LIMIT회까지. 구독 사용량을 같이 쓰기 때문이다.
 * - 구독 토큰(CLAUDE_CODE_OAUTH_TOKEN)이 없으면 등록 방법을 알린다.
 * GitHub 응답을 못 읽으면 던져서 job을 실패시킨다(막는 쪽으로 실패).
 */
export const AUTO_FIX_LABEL = 'auto-fix';
export const DAILY_AUTO_FIX_LIMIT = 3;
const WORKFLOW_FILE = 'auto-fix.yml';
const FIX_JOB = 'fix';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export interface GateInput {
  label: string;
  isPullRequest: boolean;
  issueOpen: boolean;
  hasToken: boolean;
  /** 라벨을 붙인 사람의 권한 (GitHub collaborator permission) */
  senderPermission: string;
  /** 이슈를 쓴 사람의 권한 */
  authorPermission: string;
  /** 오늘 수정 job이 실제로 돈 횟수 (지금 실행 제외) */
  runsToday: number;
}

export type GateDecision = { ok: true } | { ok: false; reason: string; comment: string | null };

const no = (reason: string, comment: string | null): GateDecision => ({
  ok: false,
  reason,
  comment,
});

export function decideAutoFix(i: GateInput): GateDecision {
  if (i.label !== AUTO_FIX_LABEL) return no('other_label', null);
  if (i.isPullRequest) return no('pull_request', null);
  if (!i.issueOpen) return no('closed', null);
  if (!WRITE_PERMISSIONS.has(i.senderPermission)) {
    return no(
      'sender_permission',
      '자동 수정은 저장소 쓰기 권한이 있는 사람이 라벨을 붙였을 때만 실행합니다.',
    );
  }
  if (!WRITE_PERMISSIONS.has(i.authorPermission)) {
    return no(
      'author_permission',
      '자동 수정은 저장소 쓰기 권한이 있는 사람이 쓴 이슈에서만 실행합니다. 이 이슈 작성자에게는 권한이 없어 실행하지 않았습니다. 필요하면 관리자가 내용을 확인해 새 이슈로 옮겨 주세요.',
    );
  }
  if (!i.hasToken) {
    return no(
      'no_token',
      '자동 수정을 실행하지 않았습니다: 저장소 비밀값 `CLAUDE_CODE_OAUTH_TOKEN`이 없습니다. `claude setup-token`으로 만든 토큰을 등록하고 Claude GitHub App을 설치한 뒤 라벨을 다시 붙여 주세요.',
    );
  }
  if (i.runsToday >= DAILY_AUTO_FIX_LIMIT) {
    return no(
      'daily_limit',
      `자동 수정을 실행하지 않았습니다: 오늘(태평양 시간) 실행 상한 ${DAILY_AUTO_FIX_LIMIT}회에 닿았습니다. 내일 라벨을 다시 붙여 주세요.`,
    );
  }
  return { ok: true };
}

/** 태평양 시간 오늘 0시의 시각 (여름·겨울 시간 모두) */
export function pacificDayStart(now: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (d: Date) =>
    Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<
      string,
      string
    >;
  const p = parts(now);
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  for (const offset of [7, 8]) {
    const c = new Date(Date.UTC(y, m - 1, d, offset));
    const q = parts(c);
    if (q.day === p.day && q.hour === '00') return c;
  }
  throw new Error('태평양 시간 0시를 찾지 못했습니다');
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function gh<T>(fetch: Fetch, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** 오늘 이 워크플로에서 수정 job이 건너뛰어지지 않고 돈 실행 수 */
export async function countRunsToday(o: {
  fetch: Fetch;
  token: string;
  repo: string;
  currentRunId: number;
  since: Date;
}): Promise<number> {
  // GitHub 검색 문법은 초 단위(YYYY-MM-DDTHH:MM:SSZ)다. 밀리초를 붙이지 않는다.
  const since = o.since.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const q = new URLSearchParams({ created: `>=${since}`, per_page: '100' });
  const { workflow_runs } = await gh<{ workflow_runs: { id: number }[] }>(
    o.fetch,
    o.token,
    `/repos/${o.repo}/actions/workflows/${WORKFLOW_FILE}/runs?${q}`,
  );
  let n = 0;
  for (const run of workflow_runs) {
    if (run.id === o.currentRunId) continue;
    const { jobs } = await gh<{ jobs: { name: string; conclusion: string | null }[] }>(
      o.fetch,
      o.token,
      `/repos/${o.repo}/actions/runs/${run.id}/jobs`,
    );
    if (jobs.some((j) => j.name === FIX_JOB && j.conclusion !== 'skipped')) n++;
  }
  return n;
}

export interface LabeledEvent {
  label?: { name?: string };
  issue: { number: number; state: string; pull_request?: unknown; user: { login: string } };
  sender: { login: string };
}

export async function runGate(o: {
  event: LabeledEvent;
  fetch: Fetch;
  token: string;
  repo: string;
  runId: number;
  hasToken: boolean;
  now: Date;
}): Promise<GateDecision> {
  const { event } = o;
  const label = event.label?.name ?? '';
  // 다른 라벨·PR·닫힌 이슈는 GitHub을 부르지 않고 끝낸다
  const pre = decideAutoFix({
    label,
    isPullRequest: Boolean(event.issue.pull_request),
    issueOpen: event.issue.state === 'open',
    hasToken: true,
    senderPermission: 'admin',
    authorPermission: 'admin',
    runsToday: 0,
  });
  if (!pre.ok) return pre;

  const permission = async (login: string) =>
    (
      await gh<{ permission: string }>(
        o.fetch,
        o.token,
        `/repos/${o.repo}/collaborators/${encodeURIComponent(login)}/permission`,
      )
    ).permission;

  const decision = decideAutoFix({
    label,
    isPullRequest: false,
    issueOpen: true,
    hasToken: o.hasToken,
    senderPermission: await permission(event.sender.login),
    authorPermission: await permission(event.issue.user.login),
    runsToday: await countRunsToday({
      fetch: o.fetch,
      token: o.token,
      repo: o.repo,
      currentRunId: o.runId,
      since: pacificDayStart(o.now),
    }),
  });
  if (!decision.ok && decision.comment) {
    await gh(o.fetch, o.token, `/repos/${o.repo}/issues/${event.issue.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: decision.comment }),
    });
  }
  return decision;
}

async function main() {
  const env = process.env;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`환경 변수 ${k}가 없습니다`);
    return v;
  };
  const decision = await runGate({
    event: JSON.parse(readFileSync(need('GITHUB_EVENT_PATH'), 'utf8')) as LabeledEvent,
    fetch: (url, init) => fetch(url, init),
    token: need('GITHUB_TOKEN'),
    repo: need('GITHUB_REPOSITORY'),
    runId: Number(need('GITHUB_RUN_ID')),
    hasToken: env.HAS_FIX_TOKEN === 'true',
    now: new Date(),
  });
  console.log(decision.ok ? '자동 수정 실행' : `자동 수정 건너뜀: ${decision.reason}`);
  appendFileSync(need('GITHUB_OUTPUT'), `allowed=${decision.ok}\n`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
