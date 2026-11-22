import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { compareKey, type LinkKind } from '@musicweb/shared';
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

/** 곡의 연결들 중 추천에 쓸 하나(우선순위 순). 없으면 null. */
export function pickLink(
  songId: string,
  links: Record<string, unknown>[],
  now: Date,
  include: KindFilter = {},
): PlayableLink | null {
  const best = links
    .filter((l) => isRecommendable(l, now, include))
    .sort((a, b) => PRIORITY[a.kind as LinkKind] - PRIORITY[b.kind as LinkKind])[0];
  if (!best) return null;
  return {
    songId,
    videoId: best.videoId as string,
    kind: best.kind as LinkKind,
    embeddable: true,
    madeForKids: best.madeForKids === true,
    durationSec: typeof best.durationSec === 'number' ? best.durationSec : null,
  };
}

/** 곡마다 추천에 쓸 연결 하나(없으면 빠짐). */
export async function recommendableLinks(
  db: Firestore,
  songIds: string[],
  now: Date,
  include: KindFilter = {},
): Promise<Map<string, PlayableLink>> {
  const out = new Map<string, PlayableLink>();
  const fresh = await freshLinks(db, songIds, now);
  for (const [songId, links] of fresh) {
    const best = pickLink(songId, links, now, include);
    if (best) out.set(songId, best);
  }
  return out;
}

/** 곡마다 active이고 25일 안에 확인된 연결 문서들(종류는 거르지 않음). */
export async function freshLinks(
  db: Firestore,
  songIds: string[],
  now: Date,
): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  const fresh = Timestamp.fromDate(daysBefore(now, REFRESH_AFTER_DAYS));
  for (const songId of new Set(songIds)) {
    const snap = await db
      .collection(`songs/${songId}/links`)
      .where('status', '==', 'active')
      .where('verifiedAt', '>', fresh)
      .get();
    if (!snap.empty)
      out.set(
        songId,
        snap.docs.map((d) => d.data()),
      );
  }
  return out;
}

/** 이름 비교 키: 아티스트|제목을 정규화(T09 compareKey). 곡 문서의 `key` 필드로 저장해 이름으로 찾는다(T13). */
export const songKey = (artist: string, title: string) =>
  `${compareKey(artist)}|${compareKey(title)}`;

/** 곡 문서(음악 데이터 출처) */
export interface SongDoc {
  mbid: string;
  artist: string;
  artistMbid: string | null;
  title: string;
  releaseYear: number | null;
}

const toSong = (d: FirebaseFirestore.DocumentSnapshot): SongDoc | null => {
  const v = d.data();
  if (!v || typeof v.title !== 'string' || typeof v.artist !== 'string') return null;
  return {
    mbid: d.id,
    artist: v.artist,
    artistMbid: typeof v.artistMbid === 'string' ? v.artistMbid : null,
    title: v.title,
    releaseYear: typeof v.releaseYear === 'number' ? v.releaseYear : null,
  };
};

const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** 곡 목록 조회(추천용). Firestore `in`은 한 번에 30개까지라 나눠 묻는다. */
export function firestoreSongs(db: Firestore) {
  const col = db.collection('songs');
  return {
    async byIds(ids: string[]): Promise<Map<string, SongDoc>> {
      const out = new Map<string, SongDoc>();
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return out;
      const snaps = await db.getAll(...unique.map((id) => col.doc(id)));
      for (const s of snaps) {
        const song = s.exists ? toSong(s) : null;
        if (song) out.set(song.mbid, song);
      }
      return out;
    },
    async byKeys(keys: string[]): Promise<Map<string, SongDoc>> {
      const out = new Map<string, SongDoc>();
      for (const part of chunks([...new Set(keys)], 30)) {
        const snap = await col.where('key', 'in', part).get();
        for (const d of snap.docs) {
          const song = toSong(d);
          const key = d.get('key') as string;
          if (song && !out.has(key)) out.set(key, song);
        }
      }
      return out;
    },
    /** 아티스트들의 곡(아티스트당 최대 perArtist곡) */
    async byArtists(artistMbids: string[], perArtist: number): Promise<SongDoc[]> {
      const out: SongDoc[] = [];
      for (const a of [...new Set(artistMbids)]) {
        const snap = await col.where('artistMbid', '==', a).limit(perArtist).get();
        for (const d of snap.docs) {
          const song = toSong(d);
          if (song) out.push(song);
        }
      }
      return out;
    },
  };
}
