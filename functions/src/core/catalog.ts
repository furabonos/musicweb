import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { LinkKind } from '@musicweb/shared';
import { daysBefore, REFRESH_AFTER_DAYS } from './retention.js';

/**
 * 추천 후보 조회 (SPEC 3.1, 4.3, T11). 추천(T13)은 이 함수로만 곡의 영상을 고른다.
 * - status가 active이고, 마지막 확인(verifiedAt)이 25일 안인 연결만 쓴다.
 *   재확인이 밀린 연결(작업 실패 등)은 30일 정리 전이라도 추천에 쓰지 않는다.
 * - 곡 하나에 여러 개면 official_audio > official_mv > 나머지. 라이브·커버·리믹스는 요청 조건에 있을 때만.
 */

export interface PlayableLink {
  songId: string;
  videoId: string;
  kind: LinkKind;
  embeddable: boolean;
  madeForKids: boolean;
  durationSec: number | null;
}

export interface KindFilter {
  live?: boolean;
  cover?: boolean;
  remix?: boolean;
}

const PRIORITY: Record<LinkKind, number> = {
  official_audio: 0,
  official_mv: 1,
  other: 2,
  live: 3,
  remix: 4,
  cover: 5,
};

const toDate = (v: unknown): Date | null =>
  v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null;

/** 연결 하나가 지금 추천에 쓸 수 있는가 */
export function isRecommendable(
  link: { status?: unknown; verifiedAt?: unknown; kind?: unknown; embeddable?: unknown },
  now: Date,
  include: KindFilter = {},
): boolean {
  if (link.status !== 'active' || link.embeddable !== true) return false;
  const at = toDate(link.verifiedAt);
  if (!at || at.getTime() <= daysBefore(now, REFRESH_AFTER_DAYS).getTime()) return false;
  const kind = link.kind as LinkKind;
  if (!(kind in PRIORITY)) return false;
  if (kind === 'live' && !include.live) return false;
  if (kind === 'cover' && !include.cover) return false;
  if (kind === 'remix' && !include.remix) return false;
  return true;
}

/** 곡마다 추천에 쓸 연결 하나(없으면 빠짐). */
export async function recommendableLinks(
  db: Firestore,
  songIds: string[],
  now: Date,
  include: KindFilter = {},
): Promise<Map<string, PlayableLink>> {
  const out = new Map<string, PlayableLink>();
  const fresh = Timestamp.fromDate(daysBefore(now, REFRESH_AFTER_DAYS));
  for (const songId of new Set(songIds)) {
    const snap = await db
      .collection(`songs/${songId}/links`)
      .where('status', '==', 'active')
      .where('verifiedAt', '>', fresh)
      .get();
    const best = snap.docs
      .map((d) => d.data())
      .filter((l) => isRecommendable(l, now, include))
      .sort((a, b) => PRIORITY[a.kind as LinkKind] - PRIORITY[b.kind as LinkKind])[0];
    if (best) {
      out.set(songId, {
        songId,
        videoId: best.videoId as string,
        kind: best.kind as LinkKind,
        embeddable: true,
        madeForKids: best.madeForKids === true,
        durationSec: typeof best.durationSec === 'number' ? best.durationSec : null,
      });
    }
  }
  return out;
}
