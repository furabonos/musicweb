import { SourceUnavailableError } from '../adapters/music-http.js';
import { YouTubeReadError } from '../adapters/youtube-read.js';

/** 예약 작업(수집·재확인·정리)이 같이 쓰는 오류 분류 (T10, T11). */

const YT_OUTAGE_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

/**
 * 아티스트 탓이 아니라 서비스 전체 문제인가: YouTube 할당량 소진·연결 실패·5xx, 음악 데이터 출처 장애.
 * 이런 오류로 아티스트 실패 횟수를 올리면 장애 며칠 만에 전원이 failed가 된다 → 작업을 멈추고 다음 밤에 다시 한다.
 */
export function isOutage(err: unknown): boolean {
  if (err instanceof SourceUnavailableError) return true;
  if (err instanceof YouTubeReadError) {
    return (
      err.status === null ||
      err.status >= 500 ||
      (err.reason !== null && YT_OUTAGE_REASONS.has(err.reason))
    );
  }
  return false;
}

/**
 * 이벤트용 오류 코드: 오류 이름을 snake_case로(SourceUnavailableError → source_unavailable_error).
 * 이벤트 검사가 구분자 없는 긴 영숫자(uid·토큰 모양)를 거부하므로 그대로 쓰면 기록이 실패한다.
 */
export const errName = (err: unknown) =>
  (err instanceof Error ? err.name : 'unknown')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '')
    .slice(0, 64) || 'unknown';
