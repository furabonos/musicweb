import { HttpsError } from 'firebase-functions/v2/https';
import { describe, expect, it } from 'vitest';
import { NotAdminError } from '../core/auth.js';
import { BudgetExceededError } from '../core/budget.js';
import { KillSwitchError, RuntimeConfigError } from '../core/runtimeConfig.js';
import { handle, toHttpsError } from './errors.js';

describe('toHttpsError: 서버 오류 → 화면용 오류 코드', () => {
  it('관리자 아님 → permission-denied', () => {
    expect(toHttpsError(new NotAdminError()).code).toBe('permission-denied');
  });
  it('긴급 정지 → unavailable + 어떤 기능인지', () => {
    const e = toHttpsError(new KillSwitchError('create'));
    expect(e.code).toBe('unavailable');
    expect(e.details).toEqual({ reason: 'killSwitch', feature: 'create' });
  });
  it('한도 초과 → resource-exhausted + 초기화 시각', () => {
    const resetAt = new Date('2026-11-22T08:00:00Z');
    const e = toHttpsError(new BudgetExceededError('user', 'playlists', 10, 10, resetAt));
    expect(e.code).toBe('resource-exhausted');
    expect(e.details).toEqual({
      reason: 'limit',
      scope: 'user',
      counter: 'playlists',
      resetAt: '2026-11-22T08:00:00.000Z',
    });
  });
  it('설정 깨짐 → failed-precondition', () => {
    expect(toHttpsError(new RuntimeConfigError('x')).code).toBe('failed-precondition');
  });
  it('모르는 오류는 internal이고 원래 메시지를 화면에 보내지 않는다', () => {
    const e = toHttpsError(new Error('secret detail uid=abc'));
    expect(e.code).toBe('internal');
    expect(e.message).not.toContain('uid=abc');
  });
  it('이미 HttpsError면 그대로', () => {
    const original = new HttpsError('invalid-argument', 'x');
    expect(toHttpsError(original)).toBe(original);
  });
  it('handle은 성공 값은 그대로, 오류는 바꿔서 던진다', async () => {
    await expect(handle(async () => 1)).resolves.toBe(1);
    await expect(
      handle(async () => {
        throw new KillSwitchError('ingest');
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
