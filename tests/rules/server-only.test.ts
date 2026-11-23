import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadString } from 'firebase/storage';
import { describe, expect, it } from 'vitest';
import { as, db, testEnv, useRulesTestEnv } from './setup';

useRulesTestEnv();

const SERVER_ONLY = [
  'secrets_oauth/alice',
  'events/e1',
  'issueFingerprints/f1',
  'usage/2026-11-21/reservations/r1',
  'lastfmCache/k1',
  'ingestQueue/q1',
  'ingestQueueDays/2026-11-21',
  'githubStatsState/prs',
  'evalCaseIssues/s1_v1_blocked',
];
const collectionOf = (path: string) => path.split('/').slice(0, -1).join('/');
const WHO = { alice: as.alice, admin: as.admin, anon: as.anon };

describe('서버 전용 컬렉션은 누구도(관리자 포함) 읽거나 쓰지 못한다', () => {
  for (const [who, ctx] of Object.entries(WHO)) {
    it.each(SERVER_ONLY)(`${who}: %s 읽기·목록·쓰기·지우기 거부`, async (path) => {
      const f = db(ctx());
      await assertFails(getDoc(doc(f, path)));
      await assertFails(getDocs(collection(f, collectionOf(path))));
      await assertFails(setDoc(doc(f, path), { a: 1 }));
      await assertFails(deleteDoc(doc(f, path)));
    });
  }
});

describe('Storage는 전부 거부 (음원·영상 파일을 저장하지 않는다)', () => {
  for (const [who, ctx] of Object.entries(WHO)) {
    it(`${who}: 올리기·읽기 거부`, async () => {
      const s = ctx().storage();
      await assertFails(uploadString(ref(s, `uploads/${who}/a.txt`), 'hello'));
      await assertFails(getBytes(ref(s, 'anything.txt')));
    });
  }

  it('에뮬레이터 연결 확인: 규칙을 끄면 올리기·읽기가 되고, 켜면 같은 파일도 못 읽는다', async () => {
    await testEnv().withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(uploadString(ref(ctx.storage(), 'probe/a.txt'), 'hello'));
      const bytes = await assertSucceeds(getBytes(ref(ctx.storage(), 'probe/a.txt')));
      expect(new TextDecoder().decode(bytes)).toBe('hello');
    });
    await assertFails(getBytes(ref(as.alice().storage(), 'probe/a.txt')));
  });
});
