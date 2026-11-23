import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from './callable.js';
import { z } from 'zod';
import {
  createEvalCaseFiler,
  createGitHubReader,
  firestoreGitHubReadBudget,
  firestoreIssueBudget,
} from '../adapters/github.js';
import { createOpenLinkChecker, firestoreOpenLinkBudget } from '../adapters/youtube-openlink.js';
import { fakeExternalEnabled } from '../config/runtimeEnv.js';
import { ADMIN_EMAILS, optionalSecret, secrets } from '../config/secrets.js';
import {
  addArtist,
  adminOverview,
  setArtistStatus,
  setLinkStatus,
  setUserFlag,
} from '../core/adminOps.js';
import type { EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { runGithubStats } from '../jobs/githubStats.js';
import { firestoreLinkHealthPorts, runLinkHealth } from '../jobs/linkHealth.js';
import { runMetrics } from '../jobs/metrics.js';
import { callableEventSink } from './eventSink.js';
import { syncAdminClaim, verifyAdmin, type CallerAuth } from '../core/auth.js';
import { addOpsLogInTx, opsLogEntry } from '../core/opsLog.js';
import {
  FEATURES,
  KillSwitchError,
  limitsPatchSchema,
  parseRuntimeConfig,
  RUNTIME_DOC,
  RuntimeConfigError,
  type Feature,
  type LimitsPatch,
  type RuntimeConfig,
  type ServiceCounter,
} from '../core/runtimeConfig.js';
import { BudgetExceededError } from '../core/budget.js';
import { handle } from './errors.js';

/**
 * 관리자 callable (SPEC 4.11, T06). 화면은 T22.
 * - 모든 함수는 assertAdmin(ADMIN_EMAILS 기준)을 먼저 통과해야 한다.
 * - 설정 변경, adminAudit(누가·언제·전후 값), 운영 일지를 한 트랜잭션에서 쓴다. 하나라도 실패하면 아무것도 안 바뀐다.
 * - 운영 일지는 누구나 읽으므로 uid·이메일을 넣지 않는다. 누가 바꿨는지는 adminAudit(관리자만 읽음)에 있다.
 */

const setKillSwitchInput = z.strictObject({ feature: z.enum(FEATURES), enabled: z.boolean() });
const setLimitsInput = limitsPatchSchema.refine(
  (v) => Object.keys(v.service ?? {}).length + Object.keys(v.user ?? {}).length > 0,
  '바꿀 한도가 하나 이상 있어야 합니다.',
);

export interface AdminChange<T> {
  before: T;
  after: T;
}

export async function setKillSwitch(
  db: Firestore,
  adminUid: string,
  input: { feature: Feature; enabled: boolean },
): Promise<AdminChange<Record<Feature, boolean>>> {
  return changeRuntime(db, adminUid, 'setKillSwitch', (cfg) => {
    const before = { ...cfg.killSwitches };
    const after = { ...before, [input.feature]: input.enabled };
    const state = input.enabled ? 'on' : 'off';
    return {
      patch: { killSwitches: { [input.feature]: input.enabled } },
      change: { before, after },
      message: `Admin set kill switch '${input.feature}' to ${state}.`,
    };
  });
}

export async function setLimits(
  db: Firestore,
  adminUid: string,
  patch: LimitsPatch,
): Promise<AdminChange<RuntimeConfig['limits']>> {
  return changeRuntime(db, adminUid, 'setLimits', (cfg) => {
    const before = structuredClone(cfg.limits);
    const after = {
      service: { ...before.service, ...patch.service },
      user: { ...before.user, ...patch.user },
    };
    const changed = [
      ...Object.keys(patch.service ?? {}).map((k) => `service.${k}`),
      ...Object.keys(patch.user ?? {}).map((k) => `user.${k}`),
    ];
    return {
      patch: { limits: patch },
      change: { before, after },
      message: `Admin changed limits: ${changed.join(', ')}.`,
    };
  });
}

async function changeRuntime<T>(
  db: Firestore,
  adminUid: string,
  action: 'setKillSwitch' | 'setLimits',
  apply: (cfg: RuntimeConfig) => {
    /** 저장된 문서에 합칠 바뀐 필드만. 기본값은 문서에 굳히지 않는다(빠진 값은 SPEC 6.3 기본값). */
    patch: { killSwitches?: Partial<Record<Feature, boolean>>; limits?: LimitsPatch };
    change: AdminChange<T>;
    message: string;
  },
): Promise<AdminChange<T>> {
  const runtimeRef = db.doc(RUNTIME_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(runtimeRef);
    // 지금 설정이 깨졌으면 RuntimeConfigError(failed-precondition). 콘솔에서 고친다(OPERATIONS 3).
    const stored = (snap.exists ? snap.data() : undefined) as StoredRuntime | undefined;
    const current = parseRuntimeConfig(stored);
    const { patch, change, message } = apply(current);
    const next = mergeStored(stored ?? {}, patch);
    // 바꾼 결과도 같은 검사(상한 등)를 통과해야 저장한다. 실패는 입력 오류다.
    try {
      parseRuntimeConfig(next);
    } catch (err) {
      if (err instanceof RuntimeConfigError) {
        throw new HttpsError('invalid-argument', 'limits out of range', { reason: 'limits' });
      }
      throw err;
    }

    // 바뀐 필드만 합쳐 쓴다. 문서 전체를 다시 쓰면 서버가 쓴 값(절약 모드의 Timestamp 등)이 복사본으로 망가진다
    tx.set(
      runtimeRef,
      {
        ...(patch.killSwitches ? { killSwitches: next.killSwitches } : {}),
        ...(patch.limits ? { limits: next.limits } : {}),
      },
      { merge: true },
    );
    tx.create(db.collection('adminAudit').doc(), {
      adminUid,
      at: FieldValue.serverTimestamp(),
      action,
      before: change.before,
      after: change.after,
    });
    addOpsLogInTx(db, tx, { kind: 'admin_change', message });
    return change;
  });
}

interface StoredRuntime {
  killSwitches?: Record<string, unknown>;
  limits?: { service?: Record<string, unknown>; user?: Record<string, unknown> };
  [k: string]: unknown;
}

function mergeStored(
  stored: StoredRuntime,
  patch: { killSwitches?: Partial<Record<Feature, boolean>>; limits?: LimitsPatch },
): StoredRuntime {
  const next: StoredRuntime = structuredClone(stored);
  if (patch.killSwitches) next.killSwitches = { ...next.killSwitches, ...patch.killSwitches };
  if (patch.limits?.service) {
    next.limits = { ...next.limits, service: { ...next.limits?.service, ...patch.limits.service } };
  }
  if (patch.limits?.user) {
    next.limits = { ...next.limits, user: { ...next.limits?.user, ...patch.limits.user } };
  }
  return next;
}

/**
 * 관리자 확인(끊긴 토큰·사용 중지 계정 포함). 규칙용 클레임이 없으면 붙이되,
 * 실패해도 긴급 정지 같은 관리자 작업은 막지 않는다(클레임은 보조).
 */
export async function requireAdmin(caller: CallerAuth | undefined): Promise<string> {
  const list = ADMIN_EMAILS.value();
  const { uid, claimSynced } = await verifyAdmin(getAuth(), caller, list);
  if (!claimSynced) {
    try {
      await syncAdminClaim(getAuth(), uid, list);
    } catch (err) {
      console.error('관리자 클레임 동기화 실패 (작업은 계속)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
  return uid;
}

/**
 * 다른 계정의 admin 클레임을 목록에 맞춘다. 목록에서 뺀 관리자가 account-syncClaims를 부르지 않아도
 * 규칙 읽기 권한을 지울 수 있게 한다(OPERATIONS 4). 대상 uid는 adminAudit에서 찾는다.
 */
export async function syncUserClaims(db: Firestore, adminUid: string, targetUid: string) {
  const result = await syncAdminClaim(getAuth(), targetUid, ADMIN_EMAILS.value());
  const before = { admin: result.changed ? !result.admin : result.admin };
  const after = { admin: result.admin };
  const batch = db.batch();
  batch.create(db.collection('adminAudit').doc(), {
    adminUid,
    at: FieldValue.serverTimestamp(),
    action: 'syncUserClaims',
    target: { uid: targetUid },
    before,
    after,
  });
  batch.create(
    db.collection('opsLog').doc(),
    opsLogEntry({
      kind: 'admin_change',
      message: result.changed
        ? `Admin re-synced a user's admin access (now ${result.admin ? 'admin' : 'not admin'}).`
        : "Admin re-synced a user's admin access (no change).",
    }),
  );
  await batch.commit();
  return result;
}

const syncUserClaimsInput = z.strictObject({
  uid: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^/]+$/),
});

function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new HttpsError('invalid-argument', 'invalid input', { reason: 'input' });
  return parsed.data;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const addArtistInput = z.strictObject({
  mbid: z.string().regex(MBID),
  name: z.string().trim().min(1).max(200),
  channelId: z
    .string()
    .regex(/^UC[A-Za-z0-9_-]{22}$/)
    .optional(),
});
const setArtistStatusInput = z.strictObject({
  id: z.string().regex(MBID),
  status: z.enum(['active', 'paused']),
});
const setLinkStatusInput = z.strictObject({
  songId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  status: z.enum(['active', 'blocked']),
  suggestEvalCase: z.boolean().optional(),
});
const userFlagInput = z.strictObject({
  email: z.string().trim().email().max(254),
  value: z.boolean(),
});
const runJobInput = z.strictObject({ job: z.enum(['metrics', 'githubStats', 'linkHealth']) });

/** 이메일 → uid (관리자 화면 입력용). 이메일은 저장하지 않는다. */
async function uidByEmail(email: string): Promise<string> {
  try {
    return (await getAuth().getUserByEmail(email)).uid;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'user not found', { reason: 'userNotFound' });
    }
    throw err;
  }
}

/** uid → 이메일 (관리자 화면에 테스트 사용자·차단 계정 보여 주기). 없는 계정은 빈 값 */
async function emailsOf(uids: string[]): Promise<{ uid: string; email: string | null }[]> {
  if (!uids.length) return [];
  const found = new Map<string, string | null>();
  for (let i = 0; i < uids.length; i += 100) {
    const r = await getAuth().getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
    for (const u of r.users) found.set(u.uid, u.email ?? null);
  }
  return uids.map((uid) => ({ uid, email: found.get(uid) ?? null }));
}

/** 바꾼 뒤 admin_change 이벤트(작업 이름만, 관리자는 해시). 기록 실패는 변경을 되돌리지 않는다. */
async function changed<T>(events: EventSink, adminUid: string, action: string, result: T) {
  await events.record({
    type: 'admin_change',
    attrs: { action },
    outcome: 'ok',
    actorUid: adminUid,
  });
  return result;
}

/** 관리자 함수 공통: 관리자 확인 → 입력 검사 → 처리 → admin_change 이벤트 */
function adminCall<S extends z.ZodType, T>(
  schema: S,
  action: string,
  run: (ctx: { db: Firestore; uid: string; events: EventSink; input: z.infer<S> }) => Promise<T>,
  opts: {
    secrets?: (typeof secrets)[keyof typeof secrets][];
    timeoutSeconds?: number;
    /** 한 번에 하나만 (maxInstances 1, concurrency 1) */
    single?: boolean;
  } = {},
) {
  return onCall(
    {
      secrets: [secrets.ACTOR_HASH_KEY, ...(opts.secrets ?? [])],
      ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      ...(opts.single ? { maxInstances: 1, concurrency: 1 } : {}),
    },
    (req) =>
      handle(async () => {
        const uid = await requireAdmin(req.auth as CallerAuth | undefined);
        const input = parseInput(schema, req.data);
        const db = getFirestore();
        const events = callableEventSink(db);
        return changed(events, uid, action, await run({ db, uid, events, input }));
      }),
  );
}

export const admin = {
  /** 관리자 화면 한눈에 보기: 긴급 정지·한도·오늘 사용량·작업 결과·수집 대상·테스트 사용자·차단 계정. 바꾸지 않음 */
  overview: onCall((req) =>
    handle(async () => {
      await requireAdmin(req.auth as CallerAuth | undefined);
      const o = await adminOverview(getFirestore());
      const { testerUids, blockedUids, ...rest } = o;
      return { ...rest, testers: await emailsOf(testerUids), blocked: await emailsOf(blockedUids) };
    }),
  ),
  setKillSwitch: adminCall(setKillSwitchInput, 'setKillSwitch', ({ db, uid, input }) =>
    setKillSwitch(db, uid, input),
  ),
  setLimits: adminCall(setLimitsInput, 'setLimits', ({ db, uid, input }) =>
    setLimits(db, uid, input as LimitsPatch),
  ),
  syncUserClaims: adminCall(syncUserClaimsInput, 'syncUserClaims', async ({ db, uid, input }) => {
    try {
      return await syncUserClaims(db, uid, input.uid);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'auth/user-not-found') {
        throw new HttpsError('not-found', 'user not found', { reason: 'userNotFound' });
      }
      throw err;
    }
  }),
  addArtist: adminCall(addArtistInput, 'addArtist', async ({ db, uid, input }) => {
    await addArtist(db, uid, input);
    return { ok: true };
  }),
  setArtistStatus: adminCall(
    setArtistStatusInput,
    'setArtistStatus',
    async ({ db, uid, input }) => {
      await setArtistStatus(db, uid, input);
      return { ok: true };
    },
  ),
  /** 잘못된 연결 고치기. suggestEvalCase면 시험 문제 추가 이슈를 연다(토큰이 없으면 건너뜀) */
  setLinkStatus: adminCall(
    setLinkStatusInput,
    'setLinkStatus',
    async ({ db, uid, events, input }) => {
      const r = await setLinkStatus(db, uid, input);
      let evalCase: { url: string } | { skipped: string } | null = null;
      if (input.suggestEvalCase) {
        const token = fakeExternalEnabled() ? '' : optionalSecret('GITHUB_ISSUE_TOKEN');
        // 같은 곡·영상·결정으로는 이슈를 한 번만 연다(서버 전용 기록)
        const seenRef = db.doc(`evalCaseIssues/${input.songId}_${input.videoId}_${input.status}`);
        const seen = (await seenRef.get()).get('url') as string | undefined;
        if (seen) evalCase = { url: seen };
        else if (!token) evalCase = { skipped: 'noToken' };
        else {
          try {
            const filer = createEvalCaseFiler({ token, events, budget: firestoreIssueBudget(db) });
            const { url } = await filer.file({
              songId: input.songId,
              videoId: input.videoId,
              action: input.status,
            });
            await seenRef.set({ url, at: FieldValue.serverTimestamp() });
            evalCase = { url };
          } catch (err) {
            // 연결은 이미 고쳤다. 이슈만 못 열었다고 알린다. 정지·한도는 원래 이벤트 종류로
            if (err instanceof KillSwitchError) {
              await events.record({
                type: 'kill_switch_blocked',
                attrs: { feature: err.feature },
                outcome: 'rejected',
              });
            } else if (err instanceof BudgetExceededError) {
              await events.record({
                type: 'limit_reached',
                attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
                outcome: 'rejected',
              });
            } else {
              await events.record({
                type: 'error',
                attrs: { code: errName(err), where: 'admin.evalCase' },
                outcome: 'error',
              });
            }
            evalCase = { skipped: errName(err) };
          }
        }
      }
      return { ...r, evalCase };
    },
    { secrets: [secrets.GITHUB_ISSUE_TOKEN] },
  ),
  setUserBlocked: adminCall(userFlagInput, 'setUserBlocked', async ({ db, uid, input }) => {
    await setUserFlag(db, uid, {
      uid: await uidByEmail(input.email),
      flag: 'blocked',
      value: input.value,
    });
    return { ok: true };
  }),
  setExportTester: adminCall(userFlagInput, 'setExportTester', async ({ db, uid, input }) => {
    await setUserFlag(db, uid, {
      uid: await uidByEmail(input.email),
      flag: 'exportTester',
      value: input.value,
    });
    return { ok: true };
  }),
  /** 예약 작업 수동 재실행(짧은 작업만). 수집·재확인은 아티스트를 다시 켜서 다음 밤에 돌린다 */
  runJob: adminCall(
    runJobInput,
    'runJob',
    async ({ db, events, input }) => {
      if (input.job === 'metrics') {
        await runMetrics({ db, events });
        return { ok: true };
      }
      if (input.job === 'githubStats') {
        const token = fakeExternalEnabled() ? '' : optionalSecret('GITHUB_ISSUE_TOKEN');
        const reader = token
          ? createGitHubReader({ token, events, budget: firestoreGitHubReadBudget(db) })
          : null;
        await runGithubStats({ db, events, reader });
        return { ok: true };
      }
      if (fakeExternalEnabled()) {
        throw new HttpsError('failed-precondition', 'not in emulator', { reason: 'fakeMode' });
      }
      const checker = createOpenLinkChecker({ events, budget: firestoreOpenLinkBudget(db) });
      await runLinkHealth(
        firestoreLinkHealthPorts(db, { check: (ids) => checker.check(ids), events }),
      );
      return { ok: true };
    },
    // 수동 실행끼리 겹치지 않게 한 번에 하나(예약 작업과 겹치는 것은 githubStats가 일지를 한 batch로 써서 줄 단위 중복만 남을 수 있음)
    { secrets: [secrets.GITHUB_ISSUE_TOKEN], timeoutSeconds: 120, single: true },
  ),
};
