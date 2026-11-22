/**
 * "YouTube에서 열기" 링크 (SPEC 4.6, D-006, T16).
 * - `https://www.youtube.com/watch_videos?video_ids=ID1,ID2,…`는 비공식 링크다. 매일 jobs/linkHealth가 동작을 확인한다.
 * - 링크 하나에 담는 곡 수는 시험으로 확인하기 전까지 50곡. 넘으면 여러 링크로 나눈다.
 * - 깨졌을 때(config/runtime.youtubeOpenLink = 'fallback')는 곡별 링크 목록(watchLink)을 보여 준다.
 */
export const WATCH_VIDEOS_MAX = 50;
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export type OpenLinkMode = 'direct' | 'fallback';

export class YouTubeLinkError extends Error {
  override name = 'YouTubeLinkError';
}

function check(ids: readonly string[]) {
  if (!ids.length) throw new YouTubeLinkError('영상이 하나도 없습니다.');
  for (const id of ids)
    if (!YOUTUBE_VIDEO_ID.test(id)) throw new YouTubeLinkError('영상 ID 형식이 잘못됐습니다.');
}

/** 영상 ID 목록 → watch_videos 링크들(상한마다 하나). 빈 목록·형식이 틀린 ID는 거부. */
export function watchVideosLinks(ids: readonly string[], max = WATCH_VIDEOS_MAX): string[] {
  check(ids);
  if (!Number.isInteger(max) || max < 1) throw new YouTubeLinkError('상한이 잘못됐습니다.');
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += max)
    out.push(`https://www.youtube.com/watch_videos?video_ids=${ids.slice(i, i + max).join(',')}`);
  return out;
}

/** 곡 하나의 YouTube 링크(대체 화면용) */
export function watchLink(id: string): string {
  check([id]);
  return `https://www.youtube.com/watch?v=${id}`;
}
