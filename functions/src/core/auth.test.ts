import type { Auth, UserRecord } from 'firebase-admin/auth';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAdmin,
  isAdminEmail,
  isAdminUser,
  NotAdminError,
  syncAdminClaim,
  verifyAdmin,
  type CallerAuth,
} from './auth.js';

const LIST = [' Admin@Example.com ', 'second@example.com', ''];

function caller(token: Partial<CallerAuth['token']>, uid = 'u1'): CallerAuth {
  return {
    uid,
    token: { email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...token },
  };
}

describe('isAdminEmail', () => {
  it('대소문자·앞뒤 공백을 무시하고 목록과 비교한다', () => {
    expect(isAdminEmail('ADMIN@example.COM', true, LIST)).toBe(true);
    expect(isAdminEmail('second@example.com', true, LIST)).toBe(true);
  });
  it.each([
    ['목록에 없음', 'other@example.com', true],
    ['확인 안 된 이메일', 'admin@example.com', false],
    ['이메일 없음', undefined, true],
    ['빈 문자열', '', true],
    ['비슷하지만 다른 주소', 'admin@example.com.evil', true],
  ])('거부: %s', (_n, email, verified) => {
    expect(isAdminEmail(email, verified, LIST)).toBe(false);
  });
  it('목록이 비면 아무도 관리자가 아니다', () => {
    expect(isAdminEmail('admin@example.com', true, [])).toBe(false);
  });
});

describe('assertAdmin', () => {
  it('관리자면 uid를 돌려준다', () => {
    expect(assertAdmin(caller({ email: 'admin@example.com' }), LIST)).toBe('u1');
  });
  it.each<[string, CallerAuth | undefined]>([
    ['로그인 안 함', undefined],
    ['목록에 없음', caller({ email: 'x@example.com' })],
    [
      'Google 로그인이 아님',
      caller({ email: 'admin@example.com', firebase: { sign_in_provider: 'password' } }),
    ],
    ['이메일 미확인', caller({ email: 'admin@example.com', email_verified: false })],
    ['클레임만 있음', caller({ email: 'x@example.com', admin: true })],
  ])('거부: %s', (_n, c) => {
    expect(() => assertAdmin(c, LIST)).toThrow(NotAdminError);
  });
});

function fakeAuth(user: Partial<UserRecord>, opts: { tokenError?: Error } = {}) {
  const setCustomUserClaims = vi.fn(async () => undefined);
  const revokeRefreshTokens = vi.fn(async () => undefined);
  const verifyIdToken = vi.fn(async () => {
    if (opts.tokenError) throw opts.tokenError;
    return {};
  });
  const auth = {
    getUser: vi.fn(async () => ({
      uid: 'u1',
      emailVerified: true,
      disabled: false,
      providerData: [{ providerId: 'google.com', email: user.email }],
      ...user,
    })),
    setCustomUserClaims,
    revokeRefreshTokens,
    verifyIdToken,
  } as unknown as Auth;
  return { auth, setCustomUserClaims, revokeRefreshTokens, verifyIdToken };
}

const GOOGLE = (email: string) =>
  [{ providerId: 'google.com', email }] as UserRecord['providerData'];

describe('isAdminUser (계정 기록 기준)', () => {
  const base = { email: 'admin@example.com', emailVerified: true, disabled: false };
  it('연결된 Google 계정 이메일이 목록에 있으면 관리자', () => {
    expect(isAdminUser({ ...base, providerData: GOOGLE('admin@example.com') }, LIST)).toBe(true);
  });
  it.each([
    ['사용 중지된 계정', { ...base, disabled: true, providerData: GOOGLE('admin@example.com') }],
    ['Google 연결 없음', { ...base, providerData: [] as UserRecord['providerData'] }],
    ['Google 계정 이메일이 다름', { ...base, providerData: GOOGLE('someone@gmail.com') }],
    [
      '목록에 있는 Google 계정을 다른 이메일 계정에 연결함',
      { ...base, email: 'someone@example.com', providerData: GOOGLE('admin@example.com') },
    ],
    ['이메일 미확인', { ...base, emailVerified: false, providerData: GOOGLE('admin@example.com') }],
  ])('거부: %s', (_n, user) => {
    expect(isAdminUser(user, LIST)).toBe(false);
  });
});

describe('verifyAdmin (관리자 함수용 전체 확인)', () => {
  const c = () => ({ ...caller({ email: 'admin@example.com' }), rawToken: 'raw' });
  it('통과하면 uid와 클레임 상태를 돌려주고, 끊긴 토큰 확인을 켠다', async () => {
    const f = fakeAuth({ email: 'admin@example.com', customClaims: { admin: true } });
    await expect(verifyAdmin(f.auth, c(), LIST)).resolves.toEqual({ uid: 'u1', claimSynced: true });
    expect(f.verifyIdToken).toHaveBeenCalledWith('raw', true);
  });
  it('끊긴 토큰·사용 중지 계정(verifyIdToken 실패)이면 거부', async () => {
    const f = fakeAuth(
      { email: 'admin@example.com' },
      { tokenError: new Error('auth/id-token-revoked') },
    );
    await expect(verifyAdmin(f.auth, c(), LIST)).rejects.toBeInstanceOf(NotAdminError);
  });
  it('원래 토큰이 없으면 거부', async () => {
    const f = fakeAuth({ email: 'admin@example.com' });
    await expect(
      verifyAdmin(f.auth, caller({ email: 'admin@example.com' }), LIST),
    ).rejects.toBeInstanceOf(NotAdminError);
  });
  it('토큰은 맞아도 계정 기록이 관리자가 아니면 거부 (Google 이메일이 다름)', async () => {
    const f = fakeAuth({ email: 'admin@example.com', providerData: GOOGLE('other@gmail.com') });
    await expect(verifyAdmin(f.auth, c(), LIST)).rejects.toBeInstanceOf(NotAdminError);
  });
});

describe('syncAdminClaim', () => {
  it('목록에 있으면 admin 클레임을 붙이고 다른 클레임은 그대로 둔다', async () => {
    const f = fakeAuth({ email: 'admin@example.com', customClaims: { exportTester: true } });
    expect(await syncAdminClaim(f.auth, 'u1', LIST)).toEqual({ admin: true, changed: true });
    expect(f.setCustomUserClaims).toHaveBeenCalledWith('u1', { exportTester: true, admin: true });
    expect(f.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('목록에서 빠지면 클레임을 지우고 로그인 토큰을 끊는다', async () => {
    const f = fakeAuth({
      email: 'gone@example.com',
      customClaims: { admin: true, exportTester: true },
    });
    expect(await syncAdminClaim(f.auth, 'u1', LIST)).toEqual({ admin: false, changed: true });
    expect(f.setCustomUserClaims).toHaveBeenCalledWith('u1', { exportTester: true });
    expect(f.revokeRefreshTokens).toHaveBeenCalledWith('u1');
  });

  it('이미 맞으면 아무것도 바꾸지 않는다', async () => {
    for (const user of [
      { email: 'admin@example.com', customClaims: { admin: true } },
      { email: 'user@example.com', customClaims: {} },
      { email: 'user@example.com' },
    ]) {
      const f = fakeAuth(user);
      expect((await syncAdminClaim(f.auth, 'u1', LIST)).changed).toBe(false);
      expect(f.setCustomUserClaims).not.toHaveBeenCalled();
    }
  });

  it('admin이 true가 아닌 값으로 남아 있으면 지우되 토큰은 끊지 않는다', async () => {
    const f = fakeAuth({ email: 'user@example.com', customClaims: { admin: 'yes' } });
    expect(await syncAdminClaim(f.auth, 'u1', LIST)).toEqual({ admin: false, changed: true });
    expect(f.setCustomUserClaims).toHaveBeenCalledWith('u1', {});
    expect(f.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('Google 계정이 연결되지 않았으면 목록에 있어도 관리자가 아니다', async () => {
    const f = fakeAuth({
      email: 'admin@example.com',
      providerData: [{ providerId: 'password' }] as UserRecord['providerData'],
    });
    expect((await syncAdminClaim(f.auth, 'u1', LIST)).admin).toBe(false);
  });

  it('이메일이 확인되지 않았으면 관리자가 아니다', async () => {
    const f = fakeAuth({ email: 'admin@example.com', emailVerified: false });
    expect((await syncAdminClaim(f.auth, 'u1', LIST)).admin).toBe(false);
  });
});
