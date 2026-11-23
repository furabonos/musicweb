import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  GITHUB_REPO,
  type GhCommit,
  type GhIssue,
  type GhPull,
  type GitHubReader,
} from '../adapters/github.js';
import type { EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { addOpsLog, opsLogEntry, type OpsLogInput } from '../core/opsLog.js';
import type { Metric } from './metrics.js';

/**
 * GitHub 수치 (SPEC 4.10, T21, D-042). 매일 05:15(태평양) 하루 한 번.
 * - 자동 수정 PR = 브랜치 이름이 `claude/`로 시작하는 PR(Claude Code Action이 만드는 브랜치, D-038).
 * - 거절 사유는 관리자가 닫으면서 붙인 `reject: <사유>` 라벨에서 읽는다. 없으면 "no reason given".
 * - 결과는 metrics/current.github(누구나 읽음). PR 상태가 바뀌면 운영 일지(pr)에 한 줄과 PR 링크.
 * - 지난 상태는 서버 전용 githubStatsState/prs에 둔다(보안 규칙에 match 없음 → 거부).
 * - 토큰이 없으면(배포 전, T23) 수치 없이 "토큰 없음"으로 남긴다.
 */
export const AUTO_FIX_BRANCH = 'claude/';
export const WINDOW_DAYS = 30;
const RECENT = 10;
const DAY = 24 * 60 * 60 * 1000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ratio = (num: number, den: number) => (den > 0 ? r3(num / den) : null);

export type CiState = 'success' | 'failure' | 'pending' | 'unknown';
export type PrState = 'open' | 'merged' | 'rejected';
/** 운영 일지용으로 기억하는 상태. 열린 PR은 CI 결과까지 (예: open:pending → open:success도 남긴다) */
export type SeenState = `open:${CiState}` | 'merged' | 'rejected' | 'reverted';

export interface RecentFix {
  number: number;
  url: string;
  state: PrState;
  ci: CiState;
  openedAt: string;
  reverted: boolean;
  rejectReason: string | null;
}

/** `reject: <사유>` 라벨에서 사유만. 짧은 낱말(영문·숫자·공백·-)이 아니면 'other'. 거절 라벨이 아니면 null */
export function safeReason(label: string): string | null {
  const m = /^reject:\s*(.*)$/i.exec(label.trim());
  if (!m) return null;
  const r = (m[1] ?? '').trim().toLowerCase();
  // 운영 일지는 20자 넘게 이어진 영숫자(토큰처럼 보임)를 거부하므로 19자까지만
  return /^[a-z0-9][a-z0-9 -]{0,39}$/.test(r) && !/[a-z0-9]{20,}/.test(r) ? r : 'other';
}

const isAutoFix = (p: GhPull) => p.head.ref.startsWith(AUTO_FIX_BRANCH);
const prState = (p: GhPull): PrState =>
  p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'rejected';
const linkedIssue = (body: string | null) =>
  Number(/\b(?:fixes|closes|resolves)\s+#(\d+)/i.exec(body ?? '')?.[1] ?? NaN);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

export function computeGithubStats(i: {
  issues: GhIssue[];
  pulls: GhPull[];
  commits: GhCommit[];
  ci: Map<number, CiState>;
  now: Date;
}) {
  const since = i.now.getTime() - WINDOW_DAYS * DAY;
  const inWindow = (iso: string) => Date.parse(iso) >= since;

  const realIssues = i.issues.filter((x) => !x.pull_request);
  const autoIssues = realIssues.filter(
    (x) => inWindow(x.created_at) && x.labels.some((l) => l.name === 'auto-issue'),
  ).length;
  const issueCreated = new Map(realIssues.map((x) => [x.number, Date.parse(x.created_at)]));

  const reverted = new Set<string>();
  for (const c of i.commits) {
    for (const m of c.commit.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      if (m[1]) reverted.add(m[1]);
    }
  }
  const isReverted = (p: GhPull) =>
    !!p.merged_at &&
    !!p.merge_commit_sha &&
    [...reverted].some((sha) => p.merge_commit_sha?.startsWith(sha));
  const reasonOf = (p: GhPull) =>
    p.labels.map((l) => safeReason(l.name)).find((r) => r !== null) ?? null;

  // 최신순 (API 정렬에 기대지 않는다)
  const fixes = i.pulls
    .filter(isAutoFix)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const recentWindow = fixes.filter((p) => inWindow(p.created_at));
  const merged = recentWindow.filter((p) => prState(p) === 'merged');
  const rejected = recentWindow.filter((p) => prState(p) === 'rejected');

  const reasons = new Map<string, number>();
  for (const p of rejected) {
    const r = reasonOf(p) ?? 'no reason given';
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  const hours: number[] = [];
  for (const p of merged) {
    const opened = issueCreated.get(linkedIssue(p.body));
    if (opened !== undefined && p.merged_at) {
      hours.push(Math.round(((Date.parse(p.merged_at) - opened) / 3_600_000) * 10) / 10);
    }
  }
  // CI는 최근 10건만 조회한다(요청 수 상한). 그래서 CI 통과율도 최근 10건 기준이다.
  const ciDone = fixes
    .slice(0, RECENT)
    .map((p) => i.ci.get(p.number))
    .filter((c): c is 'success' | 'failure' => c === 'success' || c === 'failure');

  const metric = (value: number | null, unit: Metric['unit'], method: string): Metric => ({
    value,
    unit,
    method,
  });
  return {
    autoIssues: metric(
      autoIssues,
      'count',
      'Issues opened by the auto-issue job in the last 30 days.',
    ),
    approvalRate: metric(
      ratio(merged.length, merged.length + rejected.length),
      'rate',
      'Auto-fix pull requests merged by the admin divided by those merged or closed, last 30 days. Open ones are not counted.',
    ),
    rejectReasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    hoursToFix: metric(
      median(hours),
      'hours',
      'Median hours from the issue being opened to its auto-fix pull request being merged, last 30 days.',
    ),
    revertRate: metric(
      ratio(merged.filter(isReverted).length, merged.length),
      'rate',
      'Merged auto-fix pull requests later reverted on main divided by all merged ones, last 30 days.',
    ),
    ciPassRate: metric(
      ratio(ciDone.filter((c) => c === 'success').length, ciDone.length),
      'rate',
      'Of the latest 10 auto-fix pull requests, those whose required check "ci" passed divided by those whose check finished.',
    ),
    recent: fixes.slice(0, RECENT).map((p): RecentFix => ({
      number: p.number,
      url: `https://github.com/${GITHUB_REPO}/pull/${p.number}`,
      state: prState(p),
      ci: i.ci.get(p.number) ?? 'unknown',
      openedAt: p.created_at,
      reverted: isReverted(p),
      rejectReason: prState(p) === 'rejected' ? (reasonOf(p) ?? 'no reason given') : null,
    })),
  };
}
export type GithubStats = ReturnType<typeof computeGithubStats>;

/** 지난번과 달라진 PR만 운영 일지 문장으로 (처음 본 PR, 상태 변화, 되돌림) */
export function prChanges(
  recent: RecentFix[],
  prev: Partial<Record<number, SeenState>>,
): { kind: 'pr'; message: string; links: string[]; number: number; seen: SeenState }[] {
  const out = [];
  for (const r of recent) {
    const seen: SeenState = r.reverted ? 'reverted' : r.state === 'open' ? `open:${r.ci}` : r.state;
    const before = prev[r.number];
    if (before === seen) continue;
    let message: string;
    if (seen === 'reverted') message = 'Auto-fix PR was reverted on main.';
    else if (seen.startsWith('open:') && before?.startsWith('open:')) {
      message = `Auto-fix PR CI is now ${r.ci}.`;
    } else if (seen.startsWith('open:')) message = `Auto-fix PR opened; CI ${r.ci}.`;
    else if (seen === 'merged') message = `Auto-fix PR merged; CI ${r.ci}.`;
    else message = `Auto-fix PR closed without merging (reason: ${r.rejectReason}); CI ${r.ci}.`;
    out.push({ kind: 'pr' as const, message, links: [r.url], number: r.number, seen });
  }
  return out;
}

export interface GithubStatsDeps {
  db: Firestore;
  events: EventSink;
  /** 토큰이 없으면 null */
  reader: GitHubReader | null;
  now?: () => Date;
  opsLog?: (input: OpsLogInput) => Promise<void>;
}

export async function runGithubStats(deps: GithubStatsDeps) {
  const { db, events } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const opsLog = deps.opsLog ?? ((input: OpsLogInput) => addOpsLog(db, input));
  await events.record({ type: 'job_started', attrs: { job: 'githubStats' }, outcome: 'ok' });
  const finish = (processed: number, failed: number) =>
    events.record({
      type: 'job_finished',
      attrs: { job: 'githubStats', processed, failed },
      outcome: failed ? 'error' : 'ok',
    });

  if (!deps.reader) {
    await db
      .doc('metrics/current')
      .set(
        { github: { unavailable: 'no GitHub token', updatedAt: FieldValue.serverTimestamp() } },
        { merge: true },
      );
    await finish(0, 0);
    return null;
  }

  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
    const [issues, pulls, commits] = await Promise.all([
      deps.reader.listIssues(since),
      deps.reader.listPulls(),
      deps.reader.listMainCommits(since),
    ]);
    const ci = new Map<number, CiState>();
    const latest = pulls
      .filter(isAutoFix)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, RECENT);
    for (const p of latest) {
      ci.set(p.number, await deps.reader.ciState(p.head.sha));
    }
    const stats = computeGithubStats({ issues, pulls, commits, ci, now });

    const stateRef = db.doc('githubStatsState/prs');
    const prev = ((await stateRef.get()).get('seen') ?? {}) as Partial<Record<number, SeenState>>;
    const changes = prChanges(stats.recent, prev);

    // 일지 줄과 지난 상태를 한 번에 쓴다: 중간에 실패해도 다음 날 같은 줄이 두 번 남지 않게
    const batch = db.batch();
    for (const c of changes) {
      batch.create(
        db.collection('opsLog').doc(),
        opsLogEntry({ kind: c.kind, message: c.message, links: c.links }),
      );
    }
    batch.set(
      db.doc('metrics/current'),
      { github: { ...stats, updatedAt: FieldValue.serverTimestamp() } },
      { merge: true },
    );
    batch.set(
      stateRef,
      { seen: { ...prev, ...Object.fromEntries(changes.map((c) => [c.number, c.seen])) } },
      { merge: true },
    );
    await batch.commit();
    await finish(stats.recent.length, 0);
    return stats;
  } catch (err) {
    await events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'githubStats.run' },
      outcome: 'error',
    });
    await opsLog({ kind: 'job_failed', message: 'GitHub stats could not be updated.' });
    await finish(0, 1);
    return null;
  }
}
