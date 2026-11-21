import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { assertEnabled } from '../core/runtimeConfig.js';
import { handle } from './errors.js';

/**
 * 재생목록 만들기 — 스텁 (T06). 긴급 정지 확인만 한다. 실제 내용은 T14가 채운다
 * (로그인·D-015 관리자 제한·budget·추천).
 */
// TODO(T23): App Check 설정 후 enforceAppCheck: true (SPEC 6.1).
export const playlists = {
  create: onCall((req) =>
    handle(async () => {
      if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'sign in required');
      await assertEnabled(getFirestore(), 'create');
      return { stub: true as const };
    }),
  ),
};
