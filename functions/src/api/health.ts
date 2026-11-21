import { onCall } from 'firebase-functions/v2/https';

export interface HealthResult {
  ok: true;
  service: 'musicweb';
}

/** 배포·에뮬레이터 연결 확인용 함수. 외부 호출·데이터 접근 없음. */
export function healthCheck(): HealthResult {
  return { ok: true, service: 'musicweb' };
}

// TODO(T23): 실제 프로젝트에 App Check를 설정하면 callable 공통 옵션으로 enforceAppCheck: true를 켠다 (SPEC 6.1).
export const health = onCall(() => healthCheck());
