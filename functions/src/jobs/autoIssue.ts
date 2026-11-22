import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { IssueFiler } from '../adapters/github.js';
import baselineData from '../../../evals/baseline.json' with { type: 'json' };
import { BudgetExceededError } from '../core/budget.js';
import {
  detect,
  type JobName,
  type JobRuns,
  type ScoreBaseline,
  type Signals,
} from '../core/detectors.js';
import { JOBS, type EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { addOpsLog, type OpsLogInput } from '../core/opsLog.js';
import { KillSwitchError, readRuntimeConfig, type ServiceCounter } from '../core/runtimeConfig.js';

/**
 * 자동 이슈 작업 (SPEC 4.9, T19, D-037). 매일 06:00(태평양), 다른 예약 작업·매일 시험이 끝난 뒤.
 * 1. 긴급 정지(autoIssue)가 꺼져 있으면 아무것도 읽거나 부르지 않고 끝낸다(GitHub 호출 0건).
 * 2. 지난 24시간 기록을 숫자로 모은다(gatherSignals) → 감지 규칙(detect) → 문제마다 이슈(filer).
 * 3. 하루 새 이슈 상한(5)에 걸리면 나머지 새 문제는 운영 일지에 남기고 넘어간다(기존 이슈 댓글은 계속).
 * 토큰이 없으면(filer=null) 감지만 하고 운영 일지에 남긴다.
 */
export interface AutoIssueDeps {
  db: Firestore;
  events: EventSink;
  filer: IssueFiler | null;
  now?: () => Date;
  opsLog?: (input: OpsLogInput) => Promise<void>;
}

const HOUR = 60 * 60 * 1000;
/** AI·시스템 탓인 해석 실패 (parseRequest의 ParseFailReason 중) */
export const SYSTEM_PARSE_FAILURES = ['no_output', 'schema_invalid'] as const;
export const WINDOW_HOURS = 24;
const PRIOR_DAYS = 7;

type BaselineFile = {
  suites: Partial<
    Record<'matching' | 'parse', { score: number; tolerance?: number; skipped?: string }>
  >;
};
const pickBaseline = (name: 'matching' | 'parse'): ScoreBaseline | null => {
  const b = (baselineData as BaselineFile).suites[name];
  return b && !b.skipped ? { score: b.score, tolerance: b.tolerance ?? 0 } : null;
};

/** 지난 24시간 신호를 모은다. 개수는 count 집계로만 읽는다(이벤트 내용을 옮기지 않음). */
export async function gatherSignals(db: Firestore, now: Date): Promise<Signals> {
  const since = Timestamp.fromMillis(now.getTime() - WINDOW_HOURS * HOUR);
  const priorSince = Timestamp.fromMillis(now.getTime() - (WINDOW_HOURS + PRIOR_DAYS * 24) * HOUR);
  const events = db.collection('events');
  const count = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
  const recent = (type: string) => events.where('type', '==', type).where('at', '>=', since);
  const prior = (type: string) =>
    events.where('type', '==', type).where('at', '>=', priorSince).where('at', '<', since);

  // 해석 실패는 시스템 쪽 이유만 센다. 빈 입력·너무 긴 입력·기준 곡 없음/못 찾음은 사용자 쪽 이유이고,
  // 기준 곡 실패는 request_parsed 뒤에 남아 같은 요청을 두 번 세게 된다(리뷰 지적).
  const sysFail = (q: FirebaseFirestore.Query) =>
    q.where('attrs.reason', 'in', [...SYSTEM_PARSE_FAILURES]);
  const [titleSplitFailed, embedBlocked, ok, failed, priorOk, priorFailed, openLinkBroken] =
    await Promise.all([
      count(recent('title_split_failed')),
      count(recent('embed_blocked')),
      count(recent('request_parsed')),
      count(sysFail(recent('request_parse_failed'))),
      count(prior('request_parsed')),
      count(sysFail(prior('request_parse_failed'))),
      count(recent('error').where('attrs.code', '==', 'open_link_broken')),
    ]);

  // 어떤 경로로도 활성이 되면 안 되는 연결: 종류 other, 그리고 수집(규칙·AI)이 연결한 커버.
  // 사용자가 커버를 요청해 검색 경로(linkedBy: lookup)로 저장된 커버는 정상이다(리뷰 지적).
  const links = db.collectionGroup('links').where('status', '==', 'active');
  const [otherLinks, ingestCovers] = await Promise.all([
    count(links.where('kind', '==', 'other')),
    count(links.where('kind', '==', 'cover').where('linkedBy', 'in', ['rule', 'ai'])),
  ]);
  const unofficialActiveLinks = otherLinks + ingestCovers;

  // 작업 시작·끝 기록은 하루 몇십 건이라 문서로 읽는다
  const jobs: Partial<Record<JobName, JobRuns>> = {};
  const jobSnap = await events
    .where('type', 'in', ['job_started', 'job_finished'])
    .where('at', '>=', since)
    .get();
  for (const d of jobSnap.docs) {
    const job = d.get('attrs.job') as JobName;
    if (!(JOBS as readonly string[]).includes(job) || job === 'autoIssue') continue;
    const r = (jobs[job] ??= { started: 0, finished: 0, failedRuns: 0 });
    if (d.get('type') === 'job_started') r.started++;
    else {
      r.finished++;
      if (d.get('outcome') === 'error') r.failedRuns++;
    }
  }

  const artistSnap = await recent('artist_ingest_failed').get();
  const failedArtists = artistSnap.docs
    .filter((d) => d.get('attrs.status') === 'failed')
    .map((d) => d.get('attrs.artistMbid') as string);

  type SuiteDoc = { score?: number; skipped?: string };
  const evalDoc = (await db.doc('metrics/current').get()).get('eval') as
    { at?: Timestamp; matching?: SuiteDoc; parse?: SuiteDoc } | undefined;
  const at = evalDoc?.at instanceof Timestamp ? evalDoc.at.toMillis() : 0;
  // 오늘 건너뛴 시험(skipped)은 merge로 남은 어제 점수를 쓰지 않는다(리뷰 지적)
  const score = (x: SuiteDoc | undefined) =>
    !x?.skipped && typeof x?.score === 'number' && Number.isFinite(x.score) ? x.score : null;

  return {
    titleSplitFailed,
    embedBlocked,
    unofficialActiveLinks,
    parse: { ok, failed, priorOk, priorFailed },
    eval: {
      fresh: at >= since.toMillis(),
      matching: score(evalDoc?.matching),
      parse: score(evalDoc?.parse),
    },
    baseline: { matching: pickBaseline('matching'), parse: pickBaseline('parse') },
    openLinkBroken,
    jobs,
    failedArtists,
  };
}

export interface AutoIssueSummary {
  stoppedBy?: 'killSwitch';
  findings: number;
  created: number;
  commented: number;
  notFiled: number;
  failed: number;
}

export async function runAutoIssue(deps: AutoIssueDeps): Promise<AutoIssueSummary> {
  const { db, events } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const opsLog = deps.opsLog ?? ((input: OpsLogInput) => addOpsLog(db, input));
  const summary: AutoIssueSummary = {
    findings: 0,
    created: 0,
    commented: 0,
    notFiled: 0,
    failed: 0,
  };

  const blocked = async () => {
    await events.record({
      type: 'kill_switch_blocked',
      attrs: { feature: 'autoIssue' },
      outcome: 'rejected',
    });
    return { ...summary, stoppedBy: 'killSwitch' as const };
  };
  // 설정이 깨져 있으면 readRuntimeConfig가 던진다(막는 쪽으로 실패)
  if (!(await readRuntimeConfig(db)).killSwitches.autoIssue) return blocked();

  await events.record({ type: 'job_started', attrs: { job: 'autoIssue' }, outcome: 'ok' });
  const finish = () =>
    events.record({
      type: 'job_finished',
      attrs: { job: 'autoIssue', processed: summary.findings, failed: summary.failed },
      outcome: summary.failed ? 'error' : 'ok',
    });

  let findings;
  try {
    findings = detect(await gatherSignals(db, now));
  } catch (err) {
    // 색인 없음·설정 문서 깨짐 등: 자동 이슈가 조용히 멈추지 않게 기록을 남긴다(리뷰 지적)
    summary.failed++;
    await events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'autoIssue.gather' },
      outcome: 'error',
    });
    await opsLog({ kind: 'job_failed', message: 'Auto-issue could not collect signals.' });
    await finish();
    return summary;
  }
  summary.findings = findings.length;

  if (!deps.filer) {
    if (findings.length) {
      await opsLog({
        kind: 'issue',
        message: `Auto-issue found ${findings.length} problem(s) but no GitHub token is set.`,
      });
    }
    summary.notFiled = findings.length;
    await finish();
    return summary;
  }

  /** 상한에 걸린 카운터 (현황판 한도 도달 집계와 운영 일지 문구용) */
  const limitsHit = new Set<string>();
  for (const f of findings) {
    try {
      const r = await deps.filer.file(f);
      if (r.action === 'created') {
        summary.created++;
        await opsLog({ kind: 'issue', message: `Auto-issue opened: ${f.rule}.`, links: [r.url] });
      } else if (r.action === 'commented') {
        summary.commented++;
        await opsLog({
          kind: 'issue',
          message: `Auto-issue seen again: ${f.rule}.`,
          links: [r.url],
        });
      }
    } catch (err) {
      if (err instanceof KillSwitchError) {
        // 실행 중에 관리자가 껐다: 바로 멈춘다
        await events.record({
          type: 'kill_switch_blocked',
          attrs: { feature: 'autoIssue' },
          outcome: 'rejected',
        });
        summary.stoppedBy = 'killSwitch';
        summary.notFiled++;
        break;
      }
      if (err instanceof BudgetExceededError && err.scope === 'service') {
        // 이 문제는 넘긴다. 새 이슈 상한(autoIssues)이면 기존 이슈 댓글은 계속할 수 있다
        summary.notFiled++;
        if (!limitsHit.has(err.counter)) {
          limitsHit.add(err.counter);
          await events.record({
            type: 'limit_reached',
            attrs: { scope: 'service', counter: err.counter as ServiceCounter },
            outcome: 'rejected',
          });
        }
        continue;
      }
      summary.failed++;
      await events.record({
        type: 'error',
        attrs: { code: errName(err), where: 'autoIssue.file' },
        outcome: 'error',
      });
    }
  }
  if (limitsHit.size) {
    const which = limitsHit.has('githubCalls') ? 'GitHub request limit' : 'new auto-issue limit';
    await opsLog({
      kind: 'limit',
      message: `Daily ${which} reached; ${summary.notFiled} problem(s) were not filed.`,
    });
  }
  if (summary.failed) {
    await opsLog({
      kind: 'job_failed',
      message: `Auto-issue: filing failed for ${summary.failed} problem(s).`,
    });
  }
  await finish();
  return summary;
}
