import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { actorHash, firestoreEventSink } from './events.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const KEY = 'int-test-actor-hash-key-0123456789ab';

beforeEach(async () => {
  if (!firestoreHost) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  expect(res.ok).toBe(true);
});

/** 보안 규칙이 적용되는 클라이언트 REST 읽기 (Authorization이 있으면 그 사용자, 없으면 로그인 안 한 상태). */
async function clientGet(path: string, idToken?: string) {
  return fetch(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    {
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
    },
  );
}

async function signIn(email: string) {
  const idToken = JSON.stringify({ sub: `google-${email}`, email, email_verified: true });
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
  return (await res.json()) as { idToken: string; localId: string };
}

describe('events (에뮬레이터)', () => {
  it('기록이 events에 쌓이고, uid 원문 대신 해시와 서버 시각이 저장된다', async () => {
    const sink = firestoreEventSink(db, KEY);
    await sink.record({
      type: 'song_removed',
      attrs: { position: 3 },
      outcome: 'ok',
      actorUid: 'alice-uid',
    });
    await sink.record({
      type: 'limit_reached',
      attrs: { scope: 'user', counter: 'playlists' },
      outcome: 'rejected',
      actorUid: 'alice-uid',
    });
    const docs = (await db.collection('events').get()).docs.map((d) => d.data());
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.actorHash).toBe(actorHash('alice-uid', KEY));
      expect(d.at.toDate()).toBeInstanceOf(Date);
      expect(JSON.stringify(d)).not.toContain('alice-uid');
    }
  });

  it('클라이언트로는 읽을 수 없다 (로그인 안 함·로그인한 본인 모두)', async () => {
    const user = await signIn('alice@example.com');
    const sink = firestoreEventSink(db, KEY);
    await sink.record({
      type: 'song_removed',
      attrs: { position: 1 },
      outcome: 'ok',
      actorUid: user.localId,
    });
    const [doc] = (await db.collection('events').get()).docs;
    expect(doc).toBeDefined();
    expect((await clientGet(`events/${doc?.id}`)).status).toBe(403);
    expect((await clientGet(`events/${doc?.id}`, user.idToken)).status).toBe(403);
  });

  it('스키마 위반은 저장하지 않고 오류를 낸다', async () => {
    const sink = firestoreEventSink(db, KEY);
    await expect(
      sink.record({
        type: 'error',
        attrs: { code: 'x', where: 'user typed: rainy day jazz' },
        outcome: 'error',
      }),
    ).rejects.toThrow();
    expect((await db.collection('events').get()).size).toBe(0);
  });
});
