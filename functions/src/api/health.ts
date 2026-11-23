import { onCall } from './callable.js';

export interface HealthResult {
  ok: true;
  service: 'musicweb';
}

/** 배포·에뮬레이터 연결 확인용 함수. 외부 호출·데이터 접근 없음. */
export function healthCheck(): HealthResult {
  return { ok: true, service: 'musicweb' };
}

export const health = onCall(() => healthCheck());
