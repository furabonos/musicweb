import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME } from '../core/runtimeConfig.js';

// pnpm test:int: 에뮬레이터(auth, functions, firestore) 안에서 실제 callable을 HTTP로 부른다.
// 관리자 목록은 tools/emulator-env.sh가 에뮬레이터에 넣는 ADMIN_EMAILS (admin@example.com).
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const auth = getAuth();

const ADMIN = 'admin@example.com';

async function clearEmulators() {
  if (!authHost || !firestoreHost) throw new Error('pnpm test:int로 실행하세요.');
  const urls = [
    `http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    `http://${authHost}/emulator/v1/projects/${projectId}/accounts`,
  ];
  for (const url of urls) expect((await fetch(url, { method: 'DELETE' })).ok).toBe(true);
}

/** Auth 에뮬레이터에서 Google 로그인을 흉내 내 ID 토큰을 받는다. 다시 부르면 최신 클레임이 담긴 토큰. */
async function googleSignIn(email: string, emailVerified = true) {
  const idToken = JSON.stringify({ sub: `google-${email}`, email, email_verified: emailVerified });
  const res = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnSecureToken: true,
      }),
    },
  );
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { token: body.idToken, uid: body.localId };
}

/** 이메일·비밀번호 계정 (Google 아님). */
async function passwordSignUp(email: string) {
  const res = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'not-a-secret-123', returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as { idToken: string; localId: string };
  return { token: body.idToken, uid: body.localId };
}

interface CallResult {
  status: number;
  result?: unknown;
  error?: { status: string; details?: Record<string, unknown> };
}

async function call(name: string, data: unknown, token?: string): Promise<CallResult> {
  const res = await fetch(`http://${functionsHost}/${projectId}/us-central1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, ...((await res.json()) as object) };
}

const runtime = async () => (await db.doc('config/runtime').get()).data();
const audits = async () => (await db.collection('adminAudit').get()).docs.map((d) => d.data());
const opsLogs = async () => (await db.collection('opsLog').get()).docs.map((d) => d.data());

beforeEach(clearEmulators);

describe('관리자 callable: 권한', () => {
  const CALLS: [string, unknown][] = [
    ['admin-setKillSwitch', { feature: 'create', enabled: false }],
    ['admin-setLimits', { user: { playlists: 1 } }],
  ];

  it.each(CALLS)('로그인 안 한 호출은 permission-denied: %s', async (name, data) => {
    const r = await call(name, data);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    expect(await runtime()).toBeUndefined();
    expect(await audits()).toHaveLength(0);
  });

  it.each(CALLS)('관리자가 아닌 Google 계정은 permission-denied: %s', async (name, data) => {
    const { token } = await googleSignIn('someone@example.com');
    const r = await call(name, data, token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    expect(await runtime()).toBeUndefined();
    expect(await audits()).toHaveLength(0);
    expect(await opsLogs()).toHaveLength(0);
  });

  it('관리자 이메일이어도 Google 로그인이 아니면 거부', async () => {
    const { token } = await passwordSignUp(ADMIN);
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
  });

  it('관리자 이메일이어도 Google이 확인하지 않은 이메일이면 거부', async () => {
    const { token } = await googleSignIn(ADMIN, false);
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
  });

  it('클레임만 admin=true로 붙어 있고 목록에 없는 계정은 거부 (판단 기준은 목록)', async () => {
    const first = await googleSignIn('former-admin@example.com');
    await auth.setCustomUserClaims(first.uid, { admin: true });
    const { token } = await googleSignIn('former-admin@example.com');
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
  });
});

describe('관리자 callable: 성공과 기록', () => {
  it('긴급 정지를 바꾸면 설정·adminAudit(누가·언제·전후 값)·운영 일지가 남는다', async () => {
    const { token, uid } = await googleSignIn('Admin@Example.com ');
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      before: { create: true, ingest: true, autoIssue: true },
      after: { create: false, ingest: true, autoIssue: true },
    });
    // 바뀐 값만 저장된다(나머지는 기본값으로 읽힘)
    expect(await runtime()).toEqual({ killSwitches: { create: false } });

    const [audit, ...rest] = await audits();
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({
      adminUid: uid,
      action: 'setKillSwitch',
      before: { create: true },
      after: { create: false },
    });
    expect(audit?.at?.toDate()).toBeInstanceOf(Date);

    const [log] = await opsLogs();
    expect(log).toMatchObject({ kind: 'admin_change', links: [] });
    expect(log?.message).toContain("'create'");
    // 운영 일지는 누구나 읽는다: uid·이메일이 없어야 한다
    expect(JSON.stringify(log)).not.toContain(uid);
    expect(JSON.stringify(log).toLowerCase()).not.toContain('admin@example.com');
  });

  it('한도를 바꾸면 나머지 값은 그대로이고 전후 값이 기록된다', async () => {
    const { token } = await googleSignIn(ADMIN);
    const r = await call(
      'admin-setLimits',
      { service: { ytUnits: 5000 }, user: { playlists: 3 } },
      token,
    );
    expect(r.error).toBeUndefined();
    const cfg = await runtime();
    expect(cfg).toEqual({ limits: { service: { ytUnits: 5000 }, user: { playlists: 3 } } });
    expect(r.result).toMatchObject({
      after: {
        service: { ...DEFAULT_RUNTIME.limits.service, ytUnits: 5000 },
        user: { ...DEFAULT_RUNTIME.limits.user, playlists: 3 },
      },
    });
    const [audit] = await audits();
    expect(audit).toMatchObject({
      action: 'setLimits',
      before: { service: { ytUnits: 9000 }, user: { playlists: 10 } },
      after: { service: { ytUnits: 5000 }, user: { playlists: 3 } },
    });
  });

  it.each([
    ['YouTube 할당을 넘는 한도', { service: { ytUnits: 20_000 } }],
    ['검색 합계 100 초과', { service: { ytSearchUser: 90 } }],
    ['모르는 카운터', { service: { unknown: 1 } }],
    ['음수', { user: { playlists: -1 } }],
    ['빈 입력', {}],
  ])('잘못된 한도는 invalid-argument이고 아무것도 안 바뀐다: %s', async (_name, data) => {
    const { token } = await googleSignIn(ADMIN);
    const r = await call('admin-setLimits', data, token);
    expect(r.error?.status).toBe('INVALID_ARGUMENT');
    expect(await runtime()).toBeUndefined();
    expect(await audits()).toHaveLength(0);
    expect(await opsLogs()).toHaveLength(0);
  });

  it('잘못된 긴급 정지 입력은 invalid-argument', async () => {
    const { token } = await googleSignIn(ADMIN);
    for (const data of [{ feature: 'everything', enabled: false }, { feature: 'create' }]) {
      expect((await call('admin-setKillSwitch', data, token)).error?.status).toBe(
        'INVALID_ARGUMENT',
      );
    }
  });

  it('관리자 함수를 부르면 규칙용 admin 클레임이 붙는다', async () => {
    const { token, uid } = await googleSignIn(ADMIN);
    await call('admin-setKillSwitch', { feature: 'ingest', enabled: true }, token);
    expect((await auth.getUser(uid)).customClaims?.admin).toBe(true);
  });
});

describe('긴급 정지가 바로 적용된다', () => {
  it('create를 끈 직후 재생목록 만들기(스텁)가 거부되고, 다시 켜면 된다', async () => {
    const admin = await googleSignIn(ADMIN);
    const user = await googleSignIn('user@example.com');
    expect((await call('playlists-create', {}, user.token)).result).toEqual({ stub: true });

    const off = await call(
      'admin-setKillSwitch',
      { feature: 'create', enabled: false },
      admin.token,
    );
    expect(off.error).toBeUndefined();
    const blocked = await call('playlists-create', {}, user.token);
    expect(blocked.error?.status).toBe('UNAVAILABLE');
    expect(blocked.error?.details).toEqual({ reason: 'killSwitch', feature: 'create' });

    const on = await call('admin-setKillSwitch', { feature: 'create', enabled: true }, admin.token);
    expect(on.error).toBeUndefined();
    expect((await call('playlists-create', {}, user.token)).result).toEqual({ stub: true });
  });
});

describe('account-syncClaims: 로그인 직후 클레임 동기화', () => {
  it('목록에 있는 Google 계정은 admin 클레임을 받고, 새 토큰에 담긴다', async () => {
    const first = await googleSignIn(ADMIN);
    const r = await call('account-syncClaims', {}, first.token);
    expect(r.result).toEqual({ admin: true, changed: true });
    const again = await call('account-syncClaims', {}, (await googleSignIn(ADMIN)).token);
    expect(again.result).toEqual({ admin: true, changed: false });
  });

  it('목록에 없는데 admin 클레임이 남은 계정은 클레임을 지우고 다른 클레임은 그대로 둔다', async () => {
    const { uid, token } = await googleSignIn('former-admin@example.com');
    await auth.setCustomUserClaims(uid, { admin: true, exportTester: true });
    // 한 번도 끊은 적이 없으면 값이 없다(0으로 본다)
    const before = Date.parse(
      (await auth.getUser(uid)).tokensValidAfterTime ?? '1970-01-01T00:00:00Z',
    );
    // 토큰 끊기 시각은 초 단위라, 끊겼는지 구분하려면 1초 넘게 지나야 한다.
    await new Promise((r) => setTimeout(r, 1_100));
    const r = await call('account-syncClaims', {}, token);
    expect(r.result).toEqual({ admin: false, changed: true });
    const user = await auth.getUser(uid);
    expect(user.customClaims).toEqual({ exportTester: true });
    expect(Date.parse(user.tokensValidAfterTime ?? '')).toBeGreaterThan(before);
    // 예전 토큰은 끊긴 것으로 판정된다
    await expect(auth.verifyIdToken(token, true)).rejects.toMatchObject({
      code: 'auth/id-token-revoked',
    });
  });

  it('로그인 안 한 호출은 unauthenticated', async () => {
    expect((await call('account-syncClaims', {})).error?.status).toBe('UNAUTHENTICATED');
  });
});

describe('리뷰 반영: 설정 저장 방식·끊긴 계정·클레임 정리', () => {
  it('스위치 하나를 바꾸면 그 값만 저장되고 기본 한도는 문서에 굳지 않는다', async () => {
    await db.doc('config/runtime').set({ limits: { user: { playlists: 4 } } });
    const { token } = await googleSignIn(ADMIN);
    expect(
      (await call('admin-setKillSwitch', { feature: 'ingest', enabled: false }, token)).error,
    ).toBeUndefined();
    expect(await runtime()).toEqual({
      killSwitches: { ingest: false },
      limits: { user: { playlists: 4 } },
    });
    await call('admin-setLimits', { service: { ytUnits: 7000 } }, token);
    expect(await runtime()).toEqual({
      killSwitches: { ingest: false },
      limits: { user: { playlists: 4 }, service: { ytUnits: 7000 } },
    });
  });

  it('설정 문서가 이미 깨져 있으면 failed-precondition이고 아무것도 안 쓴다', async () => {
    await db.doc('config/runtime').set({ killSwitches: { create: 'no' } });
    const { token } = await googleSignIn(ADMIN);
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error?.status).toBe('FAILED_PRECONDITION');
    expect(await runtime()).toEqual({ killSwitches: { create: 'no' } });
    expect(await audits()).toHaveLength(0);
    expect(await opsLogs()).toHaveLength(0);
  });

  it('사용 중지된 관리자 계정은 이미 받은 토큰으로도 거부된다', async () => {
    const { uid, token } = await googleSignIn(ADMIN);
    await auth.updateUser(uid, { disabled: true });
    const r = await call('admin-setKillSwitch', { feature: 'create', enabled: false }, token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    expect(await runtime()).toBeUndefined();
  });

  it('관리자는 목록에서 빠진 계정의 클레임을 지울 수 있고 기록이 남는다', async () => {
    const former = await googleSignIn('former-admin@example.com');
    await auth.setCustomUserClaims(former.uid, { admin: true });
    const { token, uid: adminUid } = await googleSignIn(ADMIN);
    const r = await call('admin-syncUserClaims', { uid: former.uid }, token);
    expect(r.result).toEqual({ admin: false, changed: true });
    expect((await auth.getUser(former.uid)).customClaims ?? {}).toEqual({});
    const [audit] = await audits();
    expect(audit).toMatchObject({
      adminUid,
      action: 'syncUserClaims',
      targetUid: former.uid,
      before: { admin: true },
      after: { admin: false },
    });
    const [log] = await opsLogs();
    expect(JSON.stringify(log)).not.toContain(former.uid);
  });

  it('admin-syncUserClaims: 관리자가 아니면 거부, 없는 계정은 not-found', async () => {
    const victim = await googleSignIn('admin2@example.com');
    const user = await googleSignIn('user@example.com');
    expect(
      (await call('admin-syncUserClaims', { uid: victim.uid }, user.token)).error?.status,
    ).toBe('PERMISSION_DENIED');
    const { token } = await googleSignIn(ADMIN);
    expect((await call('admin-syncUserClaims', { uid: 'no-such-user' }, token)).error?.status).toBe(
      'NOT_FOUND',
    );
    expect((await call('admin-syncUserClaims', { uid: 'a/b' }, token)).error?.status).toBe(
      'INVALID_ARGUMENT',
    );
  });
});
