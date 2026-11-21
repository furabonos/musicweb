import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { ADMIN_EMAILS } from '../config/secrets.js';
import { syncAdminClaim, verifyAdmin, type CallerAuth } from '../core/auth.js';
import { addOpsLogInTx, opsLogEntry } from '../core/opsLog.js';
import {
  FEATURES,
  limitsPatchSchema,
  parseRuntimeConfig,
  RUNTIME_DOC,
  RuntimeConfigError,
  type Feature,
  type LimitsPatch,
  type RuntimeConfig,
} from '../core/runtimeConfig.js';
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

    tx.set(runtimeRef, next);
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
async function requireAdmin(caller: CallerAuth | undefined): Promise<string> {
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
    targetUid,
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

// TODO(T23): App Check 설정 후 enforceAppCheck: true (SPEC 6.1).
export const admin = {
  setKillSwitch: onCall((req) =>
    handle(async () => {
      const uid = await requireAdmin(req.auth as CallerAuth | undefined);
      return setKillSwitch(getFirestore(), uid, parseInput(setKillSwitchInput, req.data));
    }),
  ),
  setLimits: onCall((req) =>
    handle(async () => {
      const uid = await requireAdmin(req.auth as CallerAuth | undefined);
      return setLimits(getFirestore(), uid, parseInput(setLimitsInput, req.data) as LimitsPatch);
    }),
  ),
  syncUserClaims: onCall((req) =>
    handle(async () => {
      const uid = await requireAdmin(req.auth as CallerAuth | undefined);
      const { uid: target } = parseInput(syncUserClaimsInput, req.data);
      try {
        return await syncUserClaims(getFirestore(), uid, target);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'auth/user-not-found') {
          throw new HttpsError('not-found', 'user not found', { reason: 'userNotFound' });
        }
        throw err;
      }
    }),
  ),
};
