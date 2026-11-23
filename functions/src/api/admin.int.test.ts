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
const ARTIST = '0c6c4e57-1e2e-4d7a-8d4a-2b2a8f1e9c11';

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
  // 모든 관리자 callable (T22): 하나라도 빠지면 아래 '목록이 모든 함수를 덮는다' 테스트가 실패한다
  const CALLS: [string, unknown][] = [
    ['admin-overview', {}],
    ['admin-setKillSwitch', { feature: 'create', enabled: false }],
    ['admin-setLimits', { user: { playlists: 1 } }],
    ['admin-syncUserClaims', { uid: 'someone' }],
    ['admin-addArtist', { mbid: ARTIST, name: 'Central Cee' }],
    ['admin-setArtistStatus', { id: ARTIST, status: 'paused' }],
    ['admin-setLinkStatus', { songId: 'song1', videoId: 'aaaaaaaaaaa', status: 'blocked' }],
    ['admin-setUserBlocked', { email: 'x@example.com', value: true }],
    ['admin-setExportTester', { email: 'x@example.com', value: true }],
    ['admin-runJob', { job: 'metrics' }],
  ];

  it('목록이 모든 관리자 함수를 덮는다', async () => {
    const { admin } = await import('./admin.js');
    expect(CALLS.map(([n]) => n.replace('admin-', '')).sort()).toEqual(Object.keys(admin).sort());
  });

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
  it('create를 끈 직후 재생목록 만들기가 거부되고, 다시 켜면 된다', async () => {
    // 만들기는 D-015로 관리자만. 곡 목록이 비어 있어 결과는 seed_not_found지만, 거부(오류)가 아니면 통과다.
    const admin = await googleSignIn(ADMIN);
    const input = { text: 'songs like Doja by Central Cee', locale: 'en' };
    const before = await call('playlists-create', input, admin.token);
    expect(before.error).toBeUndefined();
    expect(before.result).toEqual({ ok: false, reason: 'seed_not_found' });

    const off = await call(
      'admin-setKillSwitch',
      { feature: 'create', enabled: false },
      admin.token,
    );
    expect(off.error).toBeUndefined();
    const blocked = await call('playlists-create', input, admin.token);
    expect(blocked.error?.status).toBe('UNAVAILABLE');
    expect(blocked.error?.details).toEqual({ reason: 'killSwitch', feature: 'create' });

    const on = await call('admin-setKillSwitch', { feature: 'create', enabled: true }, admin.token);
    expect(on.error).toBeUndefined();
    expect((await call('playlists-create', input, admin.token)).error).toBeUndefined();
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
      target: { uid: former.uid },
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

describe('관리자 화면 기능 (T22): 바꾸면 adminAudit·운영 일지·admin_change 이벤트', () => {
  const adminEvents = async () =>
    (await db.collection('events').where('type', '==', 'admin_change').get()).docs.map((d) =>
      d.get('attrs.action'),
    );

  it('아티스트 추가(D-028: lastScannedAt null, 채널이면 ytVerifiedAt) → 빼기 → 다시 켜기', async () => {
    const { token } = await googleSignIn(ADMIN);
    const channelId = `UC${'a'.repeat(22)}`;
    const add = await call(
      'admin-addArtist',
      { mbid: ARTIST, name: 'Central Cee', channelId },
      token,
    );
    expect(add.error).toBeUndefined();
    const doc = (await db.doc(`artists/${ARTIST}`).get()).data();
    expect(doc).toMatchObject({ status: 'active', failCount: 0, lastScannedAt: null, channelId });
    expect(doc?.ytVerifiedAt).toBeDefined();
    expect(
      (await call('admin-addArtist', { mbid: ARTIST, name: 'x' }, token)).error?.details,
    ).toEqual({
      reason: 'artistExists',
    });

    expect(
      (await call('admin-setArtistStatus', { id: ARTIST, status: 'paused' }, token)).error,
    ).toBeUndefined();
    expect((await db.doc(`artists/${ARTIST}`).get()).get('status')).toBe('paused');
    await db.doc(`artists/${ARTIST}`).update({ status: 'failed', failCount: 3 });
    await call('admin-setArtistStatus', { id: ARTIST, status: 'active' }, token);
    expect((await db.doc(`artists/${ARTIST}`).get()).data()).toMatchObject({
      status: 'active',
      failCount: 0,
      lastScannedAt: null,
    });

    expect((await audits()).map((a) => a.action).sort()).toEqual([
      'addArtist',
      'setArtistStatus',
      'setArtistStatus',
    ]);
    const log = (await opsLogs()).map((l) => l.message as string);
    expect(log).toHaveLength(3);
    expect(log.join(' ')).not.toContain('Central Cee'); // 일지에 대상 이름을 넣지 않는다
    expect((await adminEvents()).sort()).toEqual([
      'addArtist',
      'setArtistStatus',
      'setArtistStatus',
    ]);
  });

  it('연결 고치기: 막기, 다른 영상으로 바꾸면 기존 active는 막힘, 오래된 연결은 거부', async () => {
    const { token } = await googleSignIn(ADMIN);
    const fresh = new Date();
    await db.doc('songs/song1/links/aaaaaaaaaaa').set({ status: 'active', verifiedAt: fresh });
    await db
      .doc('songs/song1/links/bbbbbbbbbbb')
      .set({ status: 'rejected', verifiedAt: fresh, embeddable: true, linkedBy: 'rule' });
    await db
      .doc('songs/song1/links/ddddddddddd')
      .set({ status: 'rejected', verifiedAt: fresh, embeddable: false });
    await db.doc('songs/song1/links/eeeeeeeeeee').set({ status: 'gone' });
    await db
      .doc('songs/song1/links/ccccccccccc')
      .set({ status: 'rejected', verifiedAt: new Date(Date.now() - 26 * 86400_000) });

    const sw = await call(
      'admin-setLinkStatus',
      { songId: 'song1', videoId: 'bbbbbbbbbbb', status: 'active', suggestEvalCase: true },
      token,
    );
    expect(sw.error).toBeUndefined();
    // 에뮬레이터(가짜 외부)에서는 GitHub 토큰이 없어 이슈는 건너뛴다
    expect(sw.result).toMatchObject({
      after: 'active',
      blockedOthers: 1,
      evalCase: { skipped: 'noToken' },
    });
    const status = async (v: string) =>
      (await db.doc(`songs/song1/links/${v}`).get()).get('status');
    expect(await status('bbbbbbbbbbb')).toBe('active');
    expect(await status('aaaaaaaaaaa')).toBe('blocked');

    const stale = await call(
      'admin-setLinkStatus',
      { songId: 'song1', videoId: 'ccccccccccc', status: 'active' },
      token,
    );
    expect(stale.error?.details).toEqual({ reason: 'linkStale' });
    // 퍼가기가 안 되는 영상으로는 바꾸지 않는다(곡이 조용히 빠지지 않게)
    const notPlayable = await call(
      'admin-setLinkStatus',
      { songId: 'song1', videoId: 'ddddddddddd', status: 'active' },
      token,
    );
    expect(notPlayable.error?.details).toEqual({ reason: 'linkNotPlayable' });
    // 영상이 없어진(gone) 연결은 막기 대상이 아니다
    const gone = await call(
      'admin-setLinkStatus',
      { songId: 'song1', videoId: 'eeeeeeeeeee', status: 'blocked' },
      token,
    );
    expect(gone.error?.details).toEqual({ reason: 'badTransition' });
    // 원래 누가 연결했는지는 감사 기록 before에 남는다
    expect((await audits()).find((a) => a.action === 'setLinkStatus')?.before).toEqual({
      status: 'rejected',
      linkedBy: 'rule',
    });
    expect(
      (
        await call(
          'admin-setLinkStatus',
          { songId: 'song1', videoId: 'zzzzzzzzzzz', status: 'blocked' },
          token,
        )
      ).error?.status,
    ).toBe('NOT_FOUND');
    expect(await adminEvents()).toEqual(['setLinkStatus']);
  });

  it('차단된 계정은 만들기 거부(한도도 쓰지 않음), 풀면 다시 된다', async () => {
    const admin = await googleSignIn(ADMIN);
    const input = { text: 'songs like Doja by Central Cee', locale: 'en' };
    expect(
      (await call('admin-setUserBlocked', { email: ADMIN, value: true }, admin.token)).error,
    ).toBeUndefined();
    expect((await db.doc(`users/${admin.uid}`).get()).get('blocked')).toBe(true);
    const r = await call('playlists-create', input, admin.token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    expect(r.error?.details).toEqual({ reason: 'blocked' });
    expect((await db.collection(`users/${admin.uid}/usage`).get()).size).toBe(0);

    // 차단된 계정은 저장·바꾸기도 못 한다
    expect((await call('playlists-save', { id: 'nope' }, admin.token)).error?.details).toEqual({
      reason: 'blocked',
    });
    await call('admin-setUserBlocked', { email: ADMIN, value: false }, admin.token);
    expect((await call('playlists-create', input, admin.token)).error).toBeUndefined();
    // 감사 기록에는 대상 uid, 운영 일지에는 없음
    expect((await audits()).filter((a) => a.action === 'setUserBlocked')[0]?.target).toEqual({
      uid: admin.uid,
    });
    expect(JSON.stringify(await opsLogs())).not.toContain(admin.uid);
    expect(JSON.stringify(await opsLogs())).not.toContain(ADMIN);
    expect(
      (
        await call(
          'admin-setUserBlocked',
          { email: 'nobody@example.com', value: true },
          admin.token,
        )
      ).error?.details,
    ).toEqual({ reason: 'userNotFound' });
  });

  it('테스트 사용자는 100명까지: 101번째 등록 거부, 이미 등록된 사람은 다시 켜도 됨', async () => {
    const admin = await googleSignIn(ADMIN);
    const batch = db.batch();
    for (let i = 0; i < 99; i++) batch.set(db.doc(`users/tester${i}`), { exportTester: true });
    await batch.commit();
    const t100 = await googleSignIn('tester100@example.com');
    expect(
      (
        await call(
          'admin-setExportTester',
          { email: 'tester100@example.com', value: true },
          admin.token,
        )
      ).error,
    ).toBeUndefined();
    expect((await db.doc(`users/${t100.uid}`).get()).get('exportTester')).toBe(true);

    await googleSignIn('tester101@example.com');
    const over = await call(
      'admin-setExportTester',
      { email: 'tester101@example.com', value: true },
      admin.token,
    );
    expect(over.error?.status).toBe('RESOURCE_EXHAUSTED');
    expect(over.error?.details).toEqual({ reason: 'testersFull' });
    // 이미 테스트 사용자인 100번째는 다시 켜도 거부되지 않는다
    expect(
      (
        await call(
          'admin-setExportTester',
          { email: 'tester100@example.com', value: true },
          admin.token,
        )
      ).error,
    ).toBeUndefined();
  });

  it('한눈에 보기: 설정·오늘 사용량·작업별 마지막 결과·아티스트·테스트 사용자 이메일, 검색 문장 없음', async () => {
    const admin = await googleSignIn(ADMIN);
    const t = await googleSignIn('tester@example.com');
    await db.doc(`users/${t.uid}`).set({ exportTester: true });
    await db.doc(`artists/${ARTIST}`).set({ name: 'Central Cee', status: 'active', failCount: 0 });
    await db.collection('events').add({
      type: 'job_finished',
      attrs: { job: 'ingest', processed: 5, failed: 1 },
      outcome: 'error',
      at: new Date(),
    });
    await db.collection('playlists').doc('p1').set({ ownerUid: 'u' });
    await db.doc('playlists/p1/private/request').set({ text: 'my secret search sentence' });

    const r = await call('admin-overview', {}, admin.token);
    expect(r.error).toBeUndefined();
    const o = r.result as Record<string, unknown>;
    expect(o.killSwitches).toEqual({ create: true, ingest: true, autoIssue: true });
    expect(o.jobs).toEqual([
      expect.objectContaining({ job: 'ingest', outcome: 'error', processed: 5, failed: 1 }),
    ]);
    expect(o.artists).toEqual([expect.objectContaining({ id: ARTIST, name: 'Central Cee' })]);
    expect(o.testers).toEqual([{ uid: t.uid, email: 'tester@example.com' }]);
    expect(JSON.stringify(o)).not.toContain('my secret search sentence');
  });

  it('작업 재실행: 지표 작업은 바로 돌고 기록이 남는다', async () => {
    const { token } = await googleSignIn(ADMIN);
    const r = await call('admin-runJob', { job: 'metrics' }, token);
    expect(r.error).toBeUndefined();
    expect((await db.doc('metrics/current').get()).get('service.parseSuccessRate')).toBeDefined();
    expect(await adminEvents()).toEqual(['runJob']);
    expect((await call('admin-runJob', { job: 'ingest' }, token)).error?.status).toBe(
      'INVALID_ARGUMENT',
    );
  });
});
