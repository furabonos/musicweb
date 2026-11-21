import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach } from 'vitest';

// firebase emulators:exec 가 FIRESTORE_EMULATOR_HOST 등을 넣어 준다 (pnpm test:rules).
export const DAY = '2026-11-21';
let env: RulesTestEnvironment | undefined;

export function testEnv(): RulesTestEnvironment {
  if (!env)
    throw new Error(
      '규칙 테스트 환경이 준비되지 않았습니다. useRulesTestEnv()를 describe 밖에서 호출하세요.',
    );
  return env;
}

export const as = {
  alice: () => testEnv().authenticatedContext('alice', { email: 'alice@example.com' }),
  bob: () => testEnv().authenticatedContext('bob', { email: 'bob@example.com' }),
  admin: () =>
    testEnv().authenticatedContext('admin1', { email: 'admin@example.com', admin: true }),
  fakeAdmin: () =>
    testEnv().authenticatedContext('mallory', { email: 'mallory@example.com', admin: 'true' }),
  anon: () => testEnv().unauthenticatedContext(),
};

export const db = (ctx: RulesTestContext) => ctx.firestore();

/** 규칙을 끈 상태로 시험 데이터를 넣는다 (서버가 쓴 것과 같은 상태). */
async function seed() {
  await testEnv().withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const put = (path: string, data: Record<string, unknown>) => setDoc(doc(f, path), data);
    await Promise.all([
      put('users/alice', { createdAt: 1, blocked: false }),
      put('users/bob', { createdAt: 1, blocked: false }),
      put(`users/alice/usage/${DAY}`, { playlists: 1 }),
      put(`users/bob/usage/${DAY}`, { playlists: 2 }),
      put('playlists/pa-draft', { ownerUid: 'alice', state: 'draft', title: 'a' }),
      put('playlists/pa-saved', { ownerUid: 'alice', state: 'saved', title: 'a2' }),
      put('playlists/pb-draft', { ownerUid: 'bob', state: 'draft', title: 'b' }),
      put('playlists/pb-saved', { ownerUid: 'bob', state: 'saved', title: 'b2' }),
      put('playlists/pa-draft/private/request', { text: 'alice 검색 문장' }),
      put('playlists/pa-draft/private/other', { text: 'SPEC에 없는 문서' }),
      put('playlists/ghost/private/request', { text: '부모 없는 문서' }),
      put('playlists/pa-saved/private/request', { text: 'alice 검색 문장2' }),
      put('playlists/pb-draft/private/request', { text: 'bob 검색 문장' }),
      put('playlists/pb-saved/private/request', { text: 'bob 검색 문장2' }),
      put('ytExports/ea', { ownerUid: 'alice', youtubePlaylistId: 'PLa' }),
      put('ytExports/eb', { ownerUid: 'bob', youtubePlaylistId: 'PLb' }),
      put('songs/s1', { artist: 'A', title: 'T' }),
      put('songs/s1/links/vActive', { status: 'active', kind: 'official_audio' }),
      put('songs/s1/links/vGone', { status: 'gone', kind: 'official_audio' }),
      put('songs/s1/links/vBlocked', { status: 'blocked', kind: 'official_mv' }),
      put('artists/a1', { name: 'A' }),
      put(`usage/${DAY}`, { ytUnits: 10 }),
      put(`usage/${DAY}/reservations/r1`, { uid: 'alice', settled: false }),
      put('adminAudit/x1', { adminUid: 'admin1', action: 'setKillSwitch' }),
      put('config/runtime', { killSwitches: { create: true } }),
      put('config/internal', { note: 'not public' }),
      put('metrics/current', { value: 1 }),
      put('opsLog/o1', { kind: 'job', message: 'done' }),
      put('secrets_oauth/alice', { sealed: 'v1.x.y.z' }),
      put('events/e1', { type: 'x' }),
      put('lastfmCache/k1', { bytes: 1 }),
      put('issueFingerprints/f1', { issueNumber: 1 }),
      put('misc/x', { a: 1 }),
    ]);
  });
}

/** 테스트 파일마다 한 번 호출한다. */
export function useRulesTestEnv() {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-musicweb',
      firestore: { rules: readFileSync('firestore.rules', 'utf8') },
      storage: { rules: readFileSync('storage.rules', 'utf8') },
    });
  });
  beforeEach(async () => {
    await testEnv().clearFirestore();
    await seed();
  });
  afterAll(async () => {
    await env?.cleanup();
    env = undefined;
  });
}

/** 클라이언트가 직접 쓰기를 시도해 볼 문서 목록 (모든 컬렉션). */
export const WRITE_TARGETS = [
  'users/alice',
  `users/alice/usage/${DAY}`,
  'playlists/pa-draft',
  'playlists/new-one',
  'playlists/pa-draft/private/request',
  'ytExports/ea',
  'ytExports/new-one',
  'secrets_oauth/alice',
  'songs/s1',
  'songs/s1/links/vActive',
  'artists/a1',
  `usage/${DAY}`,
  'config/runtime',
  'events/e1',
  'metrics/current',
  'opsLog/o1',
  'adminAudit/x1',
  'issueFingerprints/f1',
  'lastfmCache/k1',
  'misc/x',
];
