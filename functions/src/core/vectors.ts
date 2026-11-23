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
  /** 이 곡을 계산한 시각(ms). 30일 안이면 다시 묻지 않는다 */
  at?: number;
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

export interface VectorRunOptions {
  /** 이번 실행에서 MusicBrainz에 새로 물을 곡 수 상한 */
  maxSongs?: number;
  /** 마감 시간이 지났나(곡마다 확인). 지나면 그때까지 만든 것만 저장하고 완료로 표시하지 않는다 */
  pastDeadline?: () => boolean;
  /** 곡 단위 재사용 기간 (ms). 이 안에 계산한 곡은 다시 묻지 않는다 */
  reuseMs?: number;
  now?: Date;
}

/**
 * 계산 결과. complete면 artistVectors.computedAt을 쓴다(신선도 판정용).
 * 곡 수 상한·마감 시간으로 끊기면 complete가 아니고, 다음 실행이 이어서 계산한다(이미 한 곡은 재사용).
 */
export async function computeArtistVectors(
  deps: { db: Firestore; mb: VectorPorts },
  artistMbid: string,
  opts: VectorRunOptions = {},
): Promise<{ songs: number; kept: number; calls: number; complete: boolean }> {
  const { db } = deps;
  const max = opts.maxSongs ?? MAX_SONGS_PER_ARTIST;
  const now = (opts.now ?? new Date()).getTime();
  const reuseMs = opts.reuseMs ?? 30 * 24 * 60 * 60 * 1000;
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
  // 정보가 적은 곡(mbid 없음)은 MusicBrainz에 물을 수 없다. 최근 조회된 곡부터, 문서 크기 상한까지
  const docs = snap.docs
    .filter((d) => MBID.test(d.id) && d.get('mbid') !== null)
    .sort((a, b) => millis(b.get('lastRequestedAt')) - millis(a.get('lastRequestedAt')))
    .slice(0, MAX_SONGS_PER_ARTIST);

  const out: StoredSongVector[] = [];
  let kept = 0;
  let calls = 0;
  let complete = true;
  const keep = (id: string) => {
    const old = prev.get(id);
    if (old) {
      out.push(old);
      kept++;
    }
  };
  for (const doc of docs) {
    const old = prev.get(doc.id);
    if (old?.at && now - old.at < reuseMs) {
      out.push(old);
      kept++;
      continue;
    }
    if (calls >= max || opts.pastDeadline?.()) {
      // 이번에는 여기까지. 계산하지 못한 곡은 이전 값을 지키고 다음 실행이 이어 한다
      complete = false;
      keep(doc.id);
      continue;
    }
    calls++;
    const rec = await deps.mb.getRecording(doc.id);
    if (!rec) {
      keep(doc.id);
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
    out.push({ songId: doc.id, w: toSparse(v.tags), decade: v.decade, at: now });
  }
  await ref.set(
    {
      vocabVersion: VOCAB_VERSION,
      songs: out,
      updatedAt: FieldValue.serverTimestamp(),
      // 신선도 판정(isFresh)이 같은 시계(now)로 비교하도록 계산 시각도 now로 쓴다
      ...(complete ? { computedAt: Timestamp.fromMillis(now) } : {}),
    },
    { merge: true },
  );
  return { songs: out.length, kept, calls, complete };
}
