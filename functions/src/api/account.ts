import { getAuth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from './callable.js';
import { ADMIN_EMAILS } from '../config/secrets.js';
import { syncAdminClaim } from '../core/auth.js';
import { handle } from './errors.js';

/**
 * 로그인 직후 화면이 부른다: 관리자 목록과 admin 클레임을 맞춘다 (T06, D-022).
 * 바뀌었으면(changed) 화면은 getIdToken(true)로 토큰을 새로 받는다.
 */
export const account = {
  syncClaims: onCall((req) =>
    handle(async () => {
      if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'sign in required');
      return syncAdminClaim(getAuth(), req.auth.uid, ADMIN_EMAILS.value());
    }),
  ),
};
