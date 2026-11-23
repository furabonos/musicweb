import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  knownTagWords,
  normalizeTag,
  toSparse,
  toVector,
  VOCAB_VERSION,
  type MusicTag,
} from '@musicweb/shared/similarity';
import type { Genre, RecordingDetail } from '../adapters/musicbrainz.js';

/**
 * 아티스트별 곡 숫자 묶음 (SPEC 4.3, T28, D-045).
 * - 곡 목록에서 그 아티스트의 곡을 읽고, 곡마다 MusicBrainz 녹음의 장르·태그를 받아 숫자 묶음을 만든다.
 * - artistVectors/{artistMbid} = {vocabVersion, songs[{songId, w(0이 아닌 자리만), decade}], updatedAt}(서버 전용).
 *   희소 모양이라 곡 하나가 수십 바이트다. 아티스트당 곡은 MAX_SONGS_PER_ARTIST까지(최근 조회 순) — 문서 1MB 한도 안.
 * - songs/{id}(누구나 읽음)에는 낱말 목록에 있는 태그만 낱말 목록 표기로 저장한다. 개인 태그·자유 글은 저장하지 않는다.
 * - 녹음을 못 받으면(없어짐·해석 실패) 곡 문서는 건드리지 않고 그 곡의 이전 숫자 묶음을 유지한다.
 * - 재료는 음악 데이터뿐이다(D-041). 태그가 없는 곡은 연도대만 있는 숫자 묶음이 된다.
 * - MusicBrainz 호출은 곡마다 1번(초당 1회 줄은 어댑터가 지킨다). 대상·시점은 밤 작업(T29)이 정한다.
 */
export interface VectorPorts {
  getRecording(mbid: string): Promise<RecordingDetail | null>;
}

/** 곡에 저장할 장르 이름 수 상한 */
const MAX_NAMES = 20;
/** 아티스트 하나의 숫자 묶음에 넣는 곡 수 상한 (곡 하나 약 100바이트 × 1500 ≈ 150KB) */
export const MAX_SONGS_PER_ARTIST = 1500;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredSongVector {
  songId: string;
  w: Record<string, number>;
  decade: number | null;
}

/** 장르와 태그를 합친다: 같은 낱말(정규화)이면 투표 수가 큰 쪽 */
export function mergeTags(...lists: readonly Genre[][]): MusicTag[] {
  const best = new Map<string, MusicTag>();
  for (const g of lists.flat()) {
    const key = normalizeTag(g.name);
    const cur = best.get(key);
    if (!cur || (g.count ?? 1) > (cur.count ?? 1)) {
      best.set(key, { name: g.name, source: g.source, ...(g.count ? { count: g.count } : {}) });
    }
  }
  return [...best.values()].sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
}

export async function computeArtistVectors(
  deps: { db: Firestore; mb: VectorPorts },
  artistMbid: string,
  opts: { maxSongs?: number } = {},
): Promise<{ songs: number; kept: number }> {
  const { db } = deps;
  const max = opts.maxSongs ?? MAX_SONGS_PER_ARTIST;
  const ref = db.doc(`artistVectors/${artistMbid}`);
  const [snap, prevDoc] = await Promise.all([
    db.collection('songs').where('artistMbid', '==', artistMbid).get(),
    ref.get(),
  ]);
  const prev = new Map<string, StoredSongVector>();
  if (prevDoc.get('vocabVersion') === VOCAB_VERSION) {
    for (const s of (prevDoc.get('songs') ?? []) as StoredSongVector[]) prev.set(s.songId, s);
  }
  const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0);
  // 정보가 적은 곡(mbid 없음)은 MusicBrainz에 물을 수 없다. 최근 조회된 곡부터 상한까지
  const docs = snap.docs
    .filter((d) => MBID.test(d.id) && d.get('mbid') !== null)
    .sort((a, b) => millis(b.get('lastRequestedAt')) - millis(a.get('lastRequestedAt')))
    .slice(0, max);

  const out: StoredSongVector[] = [];
  let kept = 0;
  for (const doc of docs) {
    const rec = await deps.mb.getRecording(doc.id);
    if (!rec) {
      const old = prev.get(doc.id);
      if (old) {
        out.push(old);
        kept++;
      }
      continue;
    }
    const tags = mergeTags(rec.genres, rec.tags);
    const year =
      (doc.get('releaseYear') as number | null | undefined) ?? rec.firstReleaseYear ?? null;
    const v = toVector(tags, year);
    await doc.ref.set(
      {
        genres: knownTagWords(rec.genres).slice(0, MAX_NAMES),
        tags: knownTagWords(tags).slice(0, MAX_NAMES),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    out.push({ songId: doc.id, w: toSparse(v.tags), decade: v.decade });
  }
  await ref.set(
    { vocabVersion: VOCAB_VERSION, songs: out, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { songs: out.length, kept };
}
