import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { describe, it } from 'vitest';
import { DAY, WRITE_TARGETS, as, db, useRulesTestEnv } from './setup';

useRulesTestEnv();

describe('사용자는 자기 데이터만 읽는다', () => {
  it.each([
    'users/alice',
    `users/alice/usage/${DAY}`,
    'playlists/pa-draft',
    'playlists/pa-draft/private/request',
    'playlists/pa-saved/private/request',
    'ytExports/ea',
  ])('alice는 자기 문서 %s를 읽는다', async (path) => {
    await assertSucceeds(getDoc(doc(db(as.alice()), path)));
  });

  it.each([
    'users/bob',
    `users/bob/usage/${DAY}`,
    'playlists/pb-draft',
    'playlists/pb-draft/private/request',
    'playlists/pb-saved/private/request',
    'ytExports/eb',
  ])('alice는 bob의 문서 %s를 읽지 못한다', async (path) => {
    await assertFails(getDoc(doc(db(as.alice()), path)));
  });

  it('alice는 자기 ytExports만 조회하는 쿼리는 되고, 전체 조회는 안 된다', async () => {
    const f = db(as.alice());
    await assertSucceeds(
      getDocs(query(collection(f, 'ytExports'), where('ownerUid', '==', 'alice'))),
    );
    await assertFails(getDocs(collection(f, 'ytExports')));
    await assertFails(getDocs(query(collection(f, 'ytExports'), where('ownerUid', '==', 'bob'))));
  });

  it('alice는 남의 draft까지 섞일 수 있는 재생목록 전체 조회를 못 한다', async () => {
    const f = db(as.alice());
    await assertFails(getDocs(collection(f, 'playlists')));
    await assertSucceeds(
      getDocs(query(collection(f, 'playlists'), where('ownerUid', '==', 'alice'))),
    );
  });

  it('부모 재생목록이 없는 private 문서는 누구도 못 읽는다 (삭제 중간 실패 대비)', async () => {
    await assertFails(getDoc(doc(db(as.alice()), 'playlists/ghost/private/request')));
  });

  it('SPEC에 없는 private 하위 문서는 소유자도 못 읽는다', async () => {
    await assertFails(getDoc(doc(db(as.alice()), 'playlists/pa-draft/private/other')));
  });

  it('bob은 alice 것을 거르는 재생목록 쿼리를 못 한다', async () => {
    await assertFails(
      getDocs(query(collection(db(as.bob()), 'playlists'), where('ownerUid', '==', 'alice'))),
    );
  });

  it('남의 사용량 하위 컬렉션 목록을 못 읽는다', async () => {
    await assertFails(getDocs(collection(db(as.alice()), 'users/bob/usage')));
    await assertSucceeds(getDocs(collection(db(as.alice()), 'users/alice/usage')));
  });
});

describe('클라이언트는 어떤 문서에도 직접 쓰지 못한다 (쓰기는 Functions만)', () => {
  it.each(WRITE_TARGETS)('alice: %s 만들기·바꾸기·지우기 거부', async (path) => {
    const f = db(as.alice());
    await assertFails(setDoc(doc(f, path), { ownerUid: 'alice', state: 'saved' }));
    await assertFails(updateDoc(doc(f, path), { touched: true }));
    await assertFails(deleteDoc(doc(f, path)));
  });
});
