import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { DAY, as, db, useRulesTestEnv } from './setup';

useRulesTestEnv();

const ADMIN_ONLY = ['artists/a1', `usage/${DAY}`, 'adminAudit/x1'];

describe('관리자 전용 읽기', () => {
  it.each(ADMIN_ONLY)('admin 클레임 없는 계정은 %s를 못 읽는다', async (path) => {
    await assertFails(getDoc(doc(db(as.alice()), path)));
    await assertFails(getDoc(doc(db(as.anon()), path)));
  });

  it.each(ADMIN_ONLY)(
    'admin 값이 true(불리언)가 아니면("true" 문자열 등) 못 읽는다: %s',
    async (path) => {
      await assertFails(getDoc(doc(db(as.fakeAdmin()), path)));
    },
  );

  it.each(ADMIN_ONLY)('관리자는 %s를 읽는다', async (path) => {
    await assertSucceeds(getDoc(doc(db(as.admin()), path)));
  });

  it.each(['artists', 'usage', 'adminAudit'])(
    '관리자 컬렉션 %s 목록 조회도 관리자만',
    async (name) => {
      await assertSucceeds(getDocs(collection(db(as.admin()), name)));
      await assertFails(getDocs(collection(db(as.alice()), name)));
      await assertFails(getDocs(collection(db(as.anon()), name)));
    },
  );

  it.each(ADMIN_ONLY)(
    '관리자라도 클라이언트에서 직접 쓰지 못한다(관리자 함수만): %s',
    async (path) => {
      await assertFails(setDoc(doc(db(as.admin()), path), { a: 1 }));
    },
  );

  it('관리자도 남의 비공개 문서는 못 읽는다(검색 문장 기본 비공개)', async () => {
    await assertFails(getDoc(doc(db(as.admin()), 'playlists/pa-draft/private/request')));
    await assertFails(getDoc(doc(db(as.admin()), 'users/alice')));
    await assertFails(getDoc(doc(db(as.admin()), 'playlists/pa-draft')));
    await assertFails(getDoc(doc(db(as.admin()), 'ytExports/ea')));
    await assertFails(getDocs(collection(db(as.admin()), 'playlists')));
  });
});
