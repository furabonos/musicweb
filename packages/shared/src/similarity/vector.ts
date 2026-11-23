import { SYNONYMS, VOCAB, VOCAB_VERSION } from './vocab.js';

/**
 * 곡 숫자 묶음 (SPEC 4.3, T28, D-045).
 * - 입력은 음악 데이터의 장르·태그(MusicTag: source가 musicbrainz·wikidata)와 발매 연도뿐이다.
 *   YouTube 응답 같은 다른 출처는 타입으로 받지 않는다(D-041).
 * - tags: 낱말 목록 길이의 숫자 묶음(L2 정규화). 모르는 태그는 버린다.
 * - 연도는 따로 둔다(연도대). 가까움은 태그 자리끼리의 코사인 유사도(0~1), 연도 가까움은 따로 계산한다.
 */
export interface MusicTag {
  name: string;
  /** MusicBrainz 투표 수. 없으면 1 */
  count?: number;
  source: 'musicbrainz' | 'wikidata';
}

export interface SongVector {
  vocabVersion: number;
  /** 낱말 목록 순서의 가중치(L2 정규화, 소수 넷째 자리). 태그가 없으면 모두 0 */
  tags: number[];
  /** 발매 연도대(1990이면 1990). 모르면 null */
  decade: number | null;
}

const INDEX = new Map<string, number>(VOCAB.map((w, i) => [w, i]));
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * 태그 정규화: 소문자, 하이픈(–—-)·밑줄은 공백, 'n'은 n으로, 공백 정리, 끝의 " music" 떼기,
 * 동의어 → 낱말 목록의 낱말
 */
export function normalizeTag(raw: string): string {
  const s = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_‐‑‒–—―]+/g, ' ')
    .replace(/\s*'n'\s*/g, ' n ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SYNONYMS[s] || INDEX.has(s)) return SYNONYMS[s] ?? s;
  const t = s.replace(/ music$/, '');
  return SYNONYMS[t] ?? t;
}

/** 낱말 목록의 자리들. "hip hop/rap"처럼 슬래시로 묶인 태그는 나눠서 본다. 모르는 태그는 빈 배열 */
export function vocabIndexes(raw: string): number[] {
  const whole = INDEX.get(normalizeTag(raw));
  if (whole !== undefined) return [whole];
  const out = new Set<number>();
  for (const part of raw.split('/')) {
    const i = INDEX.get(normalizeTag(part));
    if (i !== undefined) out.add(i);
  }
  return [...out];
}

/** 낱말 목록의 자리. 모르는 태그는 -1 (슬래시 태그는 첫 자리) */
export function vocabIndex(raw: string): number {
  return vocabIndexes(raw)[0] ?? -1;
}

/** 낱말 목록에 있는 태그만 낱말 목록 표기로 (공개 곡 문서에 자유 글을 저장하지 않기 위해, D-045) */
export function knownTagWords(tags: readonly { name: string }[]): string[] {
  const out = new Set<string>();
  for (const t of tags) for (const i of vocabIndexes(t.name)) out.add(VOCAB[i] as string);
  return [...out];
}

export function toVector(tags: readonly MusicTag[], year: number | null): SongVector {
  const v = new Array<number>(VOCAB.length).fill(0);
  for (const t of tags) {
    // 투표 수 많은 태그가 더 무겁다(Wikidata 장르는 투표 수가 없어 1). 로그로 눌러 한두 태그가 다 덮지 않게.
    // 같은 자리가 두 번 오면(동의어) 더하지 않고 큰 쪽(mergeTags와 같은 규칙)
    const w = 1 + Math.log2(Math.max(1, t.count ?? 1));
    for (const i of vocabIndexes(t.name)) v[i] = Math.max(v[i] ?? 0, w);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return {
    vocabVersion: VOCAB_VERSION,
    tags: norm ? v.map((x) => r4(x / norm)) : v,
    decade: year && year > 1800 ? Math.floor(year / 10) * 10 : null,
  };
}

/** 태그 가까움 0~1 (코사인). 낱말 목록 버전이 다르면 비교하지 않는다(0) */
export function closeness(a: SongVector, b: SongVector): number {
  if (a.vocabVersion !== b.vocabVersion) return 0;
  let dot = 0;
  for (let i = 0; i < a.tags.length; i++) dot += (a.tags[i] ?? 0) * (b.tags[i] ?? 0);
  return Math.max(0, Math.min(1, Math.round(dot * 10_000) / 10_000));
}

/** 연도 가까움: 같은 연도대 1, 이웃 0.5, 그 밖 0, 모르면 0 */
export function yearCloseness(a: SongVector, b: SongVector): number {
  if (a.decade === null || b.decade === null) return 0;
  const d = Math.abs(a.decade - b.decade);
  return d === 0 ? 1 : d === 10 ? 0.5 : 0;
}

/** 두 숫자 묶음에 함께 있는 낱말(가중치 곱이 큰 순). 이유 문장(T30)에 쓴다 */
export function sharedTags(a: SongVector, b: SongVector, max = 2): string[] {
  if (a.vocabVersion !== b.vocabVersion) return [];
  return VOCAB.map((w, i) => [w, (a.tags[i] ?? 0) * (b.tags[i] ?? 0)] as const)
    .filter(([, s]) => s > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** 저장용 희소 모양: 0이 아닌 자리만 {자리: 값} (Firestore 문서 크기 절약, D-045) */
export function toSparse(tags: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  tags.forEach((w, i) => {
    if (w) out[String(i)] = w;
  });
  return out;
}

/** 희소 모양 → 숫자 묶음 */
export function fromSparse(
  w: Record<string, number>,
  vocabVersion: number,
  decade: number | null,
): SongVector {
  const tags = new Array<number>(VOCAB.length).fill(0);
  for (const [k, x] of Object.entries(w)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < tags.length) tags[i] = x;
  }
  return { vocabVersion, tags, decade };
}
