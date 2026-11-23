import { HttpsError } from 'firebase-functions/v2/https';
import { BudgetExceededError } from '../core/budget.js';
import { AdminOpError } from '../core/adminOps.js';
import { NotAdminError } from '../core/auth.js';
import { PlaylistError } from '../core/playlists.js';
import { KillSwitchError, RuntimeConfigError } from '../core/runtimeConfig.js';

/**
 * 서버 오류 → callable 오류 코드. 화면은 code·details.reason으로 언어별 문구를 고른다(D-013).
 * 내부 메시지(서버 로그용)는 화면으로 보내지 않는다.
 */
export function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof NotAdminError) {
    return new HttpsError('permission-denied', 'admin only', { reason: 'notAdmin' });
  }
  if (err instanceof KillSwitchError) {
    return new HttpsError('unavailable', 'feature paused', {
      reason: 'killSwitch',
      feature: err.feature,
    });
  }
  if (err instanceof BudgetExceededError) {
    return new HttpsError('resource-exhausted', 'limit reached', {
      reason: 'limit',
      scope: err.scope,
      counter: err.counter,
      resetAt: err.resetAt.toISOString(),
    });
  }
  if (err instanceof PlaylistError) {
    const code =
      err.reason === 'notFound'
        ? 'not-found'
        : err.reason === 'notOwner' || err.reason === 'blocked'
          ? 'permission-denied'
          : err.reason === 'badPosition'
            ? 'invalid-argument'
            : 'failed-precondition';
    return new HttpsError(code, 'playlist request rejected', { reason: err.reason });
  }
  if (err instanceof AdminOpError) {
    const code =
      err.reason === 'artistExists'
        ? 'already-exists'
        : err.reason === 'artistNotFound' || err.reason === 'linkNotFound'
          ? 'not-found'
          : err.reason === 'testersFull'
            ? 'resource-exhausted'
            : 'failed-precondition';
    return new HttpsError(code, 'admin request rejected', { reason: err.reason });
  }
  if (err instanceof RuntimeConfigError) {
    // 설정이 깨지면 막는 쪽으로 실패한다(D-020). 관리자가 콘솔에서 config/runtime을 고친다.
    return new HttpsError('failed-precondition', 'service configuration error', {
      reason: 'config',
    });
  }
  return new HttpsError('internal', 'internal error');
}

/** 처리 함수를 감싸 오류를 callable 오류로 바꾼다. 알 수 없는 오류는 서버 로그에 이름만 남긴다. */
export async function handle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = toHttpsError(err);
    if (mapped.code === 'internal') {
      console.error('callable 처리 실패', { error: err instanceof Error ? err.name : 'unknown' });
    }
    throw mapped;
  }
}
