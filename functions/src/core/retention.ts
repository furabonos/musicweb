/**
 * YouTube 데이터 보관 기간 (D-004, D-028, 스킬 youtube-policy).
 * - 25일이 지나면 재확인한다(refresh). 재확인하지 못한 연결은 추천에서 뺀다.
 * - 30일이 지나면 무조건 지운다(purge). 재확인이 계속 실패해도 30일을 넘지 않게 하는 안전장치다.
 */

export const REFRESH_AFTER_DAYS = 25;
export const DELETE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** now에서 days일 전 시각 */
export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** 연결 문서에서 YouTube에서 받아 온 필드(영상 ID는 문서 ID라 문서를 지울 때 함께 사라진다). */
export const LINK_YT_FIELDS = [
  'ytTitle',
  'channelId',
  'embeddable',
  'madeForKids',
  'durationSec',
] as const;

/** 아티스트 문서에서 YouTube 데이터로 다루는 필드(D-027). */
export const ARTIST_YT_FIELDS = ['channelId', 'uploadsPlaylistId', 'lastSeenPublishedAt'] as const;
