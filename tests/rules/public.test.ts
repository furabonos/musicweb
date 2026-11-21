import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { WRITE_TARGETS, as, db, useRulesTestEnv } from './setup';

useRulesTestEnv();

describe('로그인 안 한 사람이 읽을 수 있는 것', () => {
  it.each([
    'songs/s1',
    'songs/s1/links/vActive',
    'playlists/pa-saved',
    'config/runtime',
    'metrics/current',
    'opsLog/o1',
  ])('읽는다: %s', async (path) => {
    await assertSucceeds(getDoc(doc(db(as.anon()), path)));
  });

  it.each([
    'songs/s1/links/vGone',
    'songs/s1/links/vBlocked',
    'playlists/pa-draft',
    'playlists/pa-saved/private/request',
    'users/alice',
    'ytExports/ea',
    'config/internal',
    'misc/x',
  ])('못 읽는다: %s', async (path) => {
    await assertFails(getDoc(doc(db(as.anon()), path)));
  });

  it('연결은 active만 거르는 쿼리로만 목록을 읽는다', async () => {
    const f = db(as.anon());
    await assertSucceeds(
      getDocs(query(collection(f, 'songs/s1/links'), where('status', '==', 'active'))),
    );
    await assertFails(getDocs(collection(f, 'songs/s1/links')));
  });

  it('공유된 재생목록도 목록으로 긁어 가지 못한다 (한 건 읽기만, D-019)', async () => {
    const f = db(as.anon());
    await assertFails(getDocs(query(collection(f, 'playlists'), where('state', '==', 'saved'))));
    await assertFails(getDocs(query(collection(f, 'playlists'), where('ownerUid', '==', 'alice'))));
    await assertFails(getDocs(collection(f, 'playlists')));
  });

  it('로그인한 다른 사용자도 남의 공유 재생목록 목록을 못 만든다', async () => {
    const f = db(as.bob());
    await assertFails(getDocs(query(collection(f, 'playlists'), where('ownerUid', '==', 'alice'))));
    await assertFails(getDocs(query(collection(f, 'playlists'), where('state', '==', 'saved'))));
    await assertSucceeds(getDoc(doc(f, 'playlists/pa-saved'))); // 공유 주소로 한 건은 된다
  });

  it.each(WRITE_TARGETS)('쓰지 못한다: %s', async (path) => {
    await assertFails(setDoc(doc(db(as.anon()), path), { a: 1 }));
  });
});
