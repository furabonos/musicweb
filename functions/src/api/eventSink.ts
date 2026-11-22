import type { Firestore } from 'firebase-admin/firestore';
import { fakeExternalEnabled } from '../config/runtimeEnv.js';
import { secrets } from '../config/secrets.js';
import { firestoreEventSink, type EventSink } from '../core/events.js';

// 에뮬레이터 가짜 모드에서 이벤트 해시에 쓰는 고정 키(실제 배포에서는 쓰이지 않음, D-031)
const FAKE_HASH_KEY = 'emulator-only-actor-hash-key-not-a-secret';

/** callable용 이벤트 기록기. 함수 옵션에 secrets.ACTOR_HASH_KEY를 연결해야 한다. */
export function callableEventSink(db: Firestore): EventSink {
  return firestoreEventSink(
    db,
    fakeExternalEnabled() ? FAKE_HASH_KEY : secrets.ACTOR_HASH_KEY.value(),
  );
}
