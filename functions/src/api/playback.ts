import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { secrets } from '../config/secrets.js';
import { handle } from './errors.js';
import { callableEventSink } from './eventSink.js';

/**
 * 재생 중 생긴 일 기록 (SPEC 4.5, T15, D-032).
 * - 플레이어 오류 101·150(퍼가기 불가)이면 화면이 부른다 → `embed_blocked` 이벤트(연결 상태 갱신 재료).
 * - 공유 재생목록은 로그인 없이 재생하므로 로그인을 요구하지 않는다. 로그인했으면 사용자 해시를 붙인다.
 * - 오류 코드만 받는다(영상 ID·곡 이름 없음). 그래서 이 이벤트는 집계용이고 연결 상태를 바꾸지 않는다
 *   (로그인 없이 받은 영상 ID로 남이 연결을 깨뜨리지 못하게). 연결 상태는 야간 재확인(T11)이 갱신한다.
 * - 남용 방지: 인스턴스 2개·인스턴스당 동시 1건으로 쓰기 속도를 묶고, App Check(T23)를 강제한다.
 */
const input = z.strictObject({ code: z.union([z.literal(101), z.literal(150)]) });

// TODO(T23): App Check 설정 후 enforceAppCheck: true (SPEC 6.1).
export const playback = {
  reportEmbedBlocked: onCall(
    { secrets: [secrets.ACTOR_HASH_KEY], maxInstances: 2, concurrency: 1 },
    (req) =>
      handle(async () => {
        const parsed = input.safeParse(req.data);
        if (!parsed.success)
          throw new HttpsError('invalid-argument', 'invalid input', { reason: 'input' });
        await callableEventSink(getFirestore()).record({
          type: 'embed_blocked',
          attrs: { code: parsed.data.code },
          outcome: 'ok',
          ...(req.auth?.uid ? { actorUid: req.auth.uid } : {}),
        });
        return { ok: true as const };
      }),
  ),
};
