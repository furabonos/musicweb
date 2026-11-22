import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/** 통합 테스트 도우미 (배포 빌드에서 빠짐): 에뮬레이터 Firestore와 전체 지우기. */
export const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';

export function emulatorDb() {
  if (!getApps().length) initializeApp({ projectId });
  return getFirestore();
}

export async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`에뮬레이터 지우기 실패: ${res.status}`);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Auth 에뮬레이터에서 Google 로그인을 흉내 내 ID 토큰을 받는다(admin.int.test.ts와 같은 방식). */
export async function googleSignIn(email: string): Promise<{ token: string; uid: string }> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const idToken = JSON.stringify({ sub: `google-${email}`, email, email_verified: true });
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`,
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
  if (!res.ok) throw new Error(`로그인 실패: ${res.status}`);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { token: body.idToken, uid: body.localId };
}

export async function clearAuth() {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(`http://${host}/emulator/v1/projects/${projectId}/accounts`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Auth 에뮬레이터 지우기 실패: ${res.status}`);
}

export interface CallResult {
  status: number;
  result?: unknown;
  error?: { status: string; details?: Record<string, unknown> };
}

/** 에뮬레이터의 callable을 HTTP로 부른다. 이름은 배포 이름(예: playlists-create). */
export async function callFunction(
  name: string,
  data: unknown,
  token?: string,
): Promise<CallResult> {
  const host = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
  const res = await fetch(`http://${host}/${projectId}/us-central1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, ...((await res.json()) as object) };
}
