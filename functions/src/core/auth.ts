import type { Auth, UserRecord } from 'firebase-admin/auth';

/**
 * 관리자 판별 (SPEC 4.11, 5, T06, D-022).
 *
 * - 서버 함수의 판단 기준은 ADMIN_EMAILS 목록이다. 클레임은 보지 않는다: 목록에서 빼면 다음 호출부터 바로 거부된다.
 * - 보안 규칙은 클레임(`admin == true`)만 볼 수 있으므로, syncAdminClaim으로 목록과 클레임을 맞춘다
 *   (로그인 직후 account-syncClaims, 관리자 함수 호출 때).
 * - Google로 로그인했고 Google이 확인한 이메일만 인정한다. 계정 기록에서는 연결된 Google 계정의 이메일을 본다.
 * - 관리자 함수는 verifyAdmin으로 끊긴 토큰·사용 중지 계정까지 확인한다(가장 큰 권한이라 한 번 더).
 */

/** callable request.auth에서 필요한 부분. */
export interface CallerAuth {
  uid: string;
  /** 원래 ID 토큰. 끊긴 토큰 확인(verifyIdToken checkRevoked)에 쓴다. */
  rawToken?: string;
  token: {
    email?: string;
    email_verified?: boolean;
    admin?: unknown;
    firebase?: { sign_in_provider?: string };
  };
}

export class NotAdminError extends Error {
  override name = 'NotAdminError';
  constructor() {
    super('관리자만 할 수 있습니다.');
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeAdminList(list: readonly string[]): Set<string> {
  return new Set(list.map(normalizeEmail).filter((e) => e.length > 0));
}

/** 확인된 Google 이메일이 관리자 목록에 있는가. */
export function isAdminEmail(
  email: string | undefined,
  emailVerified: boolean | undefined,
  adminEmails: readonly string[],
): boolean {
  if (!email || emailVerified !== true) return false;
  return normalizeAdminList(adminEmails).has(normalizeEmail(email));
}

/**
 * 관리자가 아니면 NotAdminError. 로그인 안 한 호출도 같은 오류다(SPEC: permission-denied).
 * @returns 관리자 uid
 */
export function assertAdmin(
  caller: CallerAuth | undefined,
  adminEmails: readonly string[],
): string {
  if (!caller?.uid) throw new NotAdminError();
  const { token } = caller;
  if (token.firebase?.sign_in_provider !== 'google.com') throw new NotAdminError();
  if (!isAdminEmail(token.email, token.email_verified, adminEmails)) throw new NotAdminError();
  return caller.uid;
}

type AdminUserFields = Pick<UserRecord, 'email' | 'emailVerified' | 'disabled' | 'providerData'>;

/**
 * 계정 기록 기준 관리자 판별: 사용 중지되지 않았고, 이메일이 확인됐고,
 * 연결된 Google 계정의 이메일이 계정 이메일과 같고 목록에 있다.
 */
export function isAdminUser(user: AdminUserFields, adminEmails: readonly string[]): boolean {
  if (user.disabled) return false;
  const googleEmail = user.providerData.find((p) => p.providerId === 'google.com')?.email;
  if (!googleEmail || !user.email) return false;
  if (normalizeEmail(googleEmail) !== normalizeEmail(user.email)) return false;
  return isAdminEmail(googleEmail, user.emailVerified, adminEmails);
}

/**
 * 관리자 함수용 전체 확인: 토큰 내용(assertAdmin) → 끊긴 토큰·사용 중지 계정 → 계정 기록(isAdminUser).
 * 하나라도 아니면 NotAdminError.
 */
export async function verifyAdmin(
  auth: Auth,
  caller: CallerAuth | undefined,
  adminEmails: readonly string[],
): Promise<{ uid: string; claimSynced: boolean }> {
  const uid = assertAdmin(caller, adminEmails);
  if (!caller?.rawToken) throw new NotAdminError();
  try {
    await auth.verifyIdToken(caller.rawToken, true);
  } catch {
    throw new NotAdminError();
  }
  const user = await auth.getUser(uid);
  if (!isAdminUser(user, adminEmails)) throw new NotAdminError();
  return { uid, claimSynced: user.customClaims?.admin === true };
}

export interface SyncResult {
  admin: boolean;
  changed: boolean;
}

/**
 * 사용자 계정의 admin 클레임을 관리자 목록에 맞춘다. 다른 클레임은 그대로 둔다.
 * 권한을 뺄 때는 로그인 토큰도 끊어(revokeRefreshTokens) 이미 받은 토큰을 새로 받지 못하게 한다.
 */
export async function syncAdminClaim(
  auth: Auth,
  uid: string,
  adminEmails: readonly string[],
): Promise<SyncResult> {
  const user = await auth.getUser(uid);
  const want = isAdminUser(user, adminEmails);
  const claims = { ...(user.customClaims ?? {}) };
  const has = claims.admin === true;
  if (want === has && (want || !('admin' in claims))) return { admin: want, changed: false };

  if (want) claims.admin = true;
  else delete claims.admin;
  await auth.setCustomUserClaims(uid, claims);
  if (!want && has) await auth.revokeRefreshTokens(uid);
  return { admin: want, changed: true };
}
