/**
 * 추천 시험 (T17, SPEC 4.9). 기준 곡마다 "어울리는 곡"과 "미끼"를 섞은 후보를 곡 목록·비슷한 곡 출처로 주고,
 * 실제 추천 파이프라인(recommend)을 돌려 AI가 고른 곡 중 어울리는 곡 비율을 잰다.
 * - 음악 데이터·YouTube는 가짜(손으로 만든 후보). AI만 진짜(호출하는 쪽이 넘김).
 * - 비슷한 곡 출처 순서는 미끼가 먼저라, AI가 고르지 못하고 점수 순으로 채우면 점수가 절반쯤에 머문다.
 */
import type { Llm } from '../../functions/src/adapters/llm.js';
import { toSparse, toVector } from '../../packages/shared/src/similarity/index.js';
import { songKey, type SongDoc } from '../../functions/src/core/catalog.js';
import { recommend, type RecommendPorts } from '../../functions/src/core/recommend.js';
import { memoryEvents } from '../../functions/src/testing/music.js';
import { round2 } from '../matching/score.js';

export interface RecommendCase {
  id: string;
  genre: string;
  seed: { artist: string; title: string };
  count: number;
  pool: { artist: string; title: string; fits: boolean; near?: boolean }[];
}

/**
 * 미리 계산한 방식 채점용 장르 태그 (T30, D-047). 곡의 장르는 그 곡을 "어울림"으로 둔 문제의 장르다
 * (미끼도 모두 다른 문제의 어울리는 곡). 가까운 장르끼리는 태그 일부가 겹친다.
 */
export const GENRE_TAGS: Record<string, string[]> = {
  altrock: ['alternative rock', 'rock', 'art rock'],
  britpop: ['britpop', 'rock', 'indie rock'],
  grunge: ['grunge', 'alternative rock', 'rock'],
  ukrap: ['hip hop', 'uk drill', 'grime'],
  '90srap': ['hip hop', 'boom bap', 'gangsta rap'],
  rnb: ['r&b', 'contemporary r&b', 'soul'],
  soul: ['soul', 'motown', 'funk'],
  disco: ['disco', 'funk', 'dance'],
  kpop: ['k pop', 'pop', 'dance pop'],
  jpop: ['j pop', 'pop', 'city pop'],
  synthpop: ['synth pop', 'new wave', 'electronic'],
  edm: ['edm', 'electro house', 'dance'],
  jazz: ['jazz', 'swing', 'smooth jazz'],
  bossa: ['bossa nova', 'jazz', 'mpb'],
  classical: ['classical', 'orchestral', 'piano'],
  country: ['country', 'americana', 'folk'],
  indiefolk: ['folk', 'indie', 'acoustic'],
  metal: ['heavy metal', 'metal', 'hard rock'],
  punk: ['punk', 'pop punk', 'rock'],
  reggaeton: ['reggaeton', 'latin', 'dancehall'],
};

/** 아티스트 → 장르 (모든 문제에서 그 아티스트가 어울리는 곡으로 나온 장르) */
export function artistGenres(cases: RecommendCase[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cases) {
    out.set(c.seed.artist, out.get(c.seed.artist) ?? c.genre);
    for (const p of c.pool) if (p.fits && !out.has(p.artist)) out.set(p.artist, c.genre);
  }
  return out;
}

const mbid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const videoId = (n: number) => `evalVid${String(n).padStart(4, '0')}`;

/** 문제 하나의 가짜 세계: 곡 목록 = 기준 곡 + 후보, 모두 재생할 수 있는 연결 하나씩. */
export function casePorts(c: RecommendCase, llm: Llm, now = new Date()): RecommendPorts {
  const all = [c.seed, ...c.pool];
  const songs: SongDoc[] = all.map((s, i) => ({
    mbid: mbid(i),
    artist: s.artist,
    artistMbid: null,
    title: s.title,
    releaseYear: null,
  }));
  const byId = new Map(songs.map((s) => [s.mbid, s]));
  const byKey = new Map(songs.map((s) => [songKey(s.artist, s.title), s]));
  return {
    songs: {
      byIds: async (ids) =>
        new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id) as SongDoc]] : []))),
      byKeys: async (keys) =>
        new Map(keys.flatMap((k) => (byKey.has(k) ? [[k, byKey.get(k) as SongDoc]] : []))),
      byArtists: async () => [],
    },
    links: async (ids) =>
      new Map(
        ids
          .filter((id) => byId.has(id))
          .map((id) => {
            const n = songs.findIndex((s) => s.mbid === id);
            return [
              id,
              [
                {
                  videoId: videoId(n),
                  kind: 'official_audio',
                  status: 'active',
                  embeddable: true,
                  madeForKids: false,
                  durationSec: 200,
                  verifiedAt: now,
                },
              ],
            ];
          }),
      ),
    music: {
      lbSearch: async () => [],
      mbSearch: async () => [],
      similarRecordings: async (seedMbid) =>
        seedMbid === mbid(0)
          ? c.pool.map((p, i) => ({
              mbid: mbid(i + 1),
              artist: p.artist,
              title: p.title,
              releaseName: null,
              score: c.pool.length - i,
            }))
          : [],
      similarArtists: async () => [],
      getRecording: async () => null,
      works: async () => new Map(),
    },
    yt: { videos: async () => [], search: async () => [] },
    officialChannels: async () => [],
    saveLink: async () => false,
    llm,
    events: memoryEvents().sink,
    now: () => now,
  };
}

export interface RecommendOutcome {
  id: string;
  /** 고른 곡 중 어울리는 곡 비율(0~1) */
  score: number;
  picked: number;
  withReason: number;
}

export function scorePicks(
  c: RecommendCase,
  picked: { artist: string; title: string; reason: string | null }[],
): RecommendOutcome {
  const fits = new Set(c.pool.filter((p) => p.fits).map((p) => songKey(p.artist, p.title)));
  const top = picked.slice(0, c.count);
  const good = top.filter((p) => fits.has(songKey(p.artist, p.title))).length;
  return {
    id: c.id,
    score: round2(good / c.count),
    picked: top.length,
    withReason: top.filter((p) => p.reason).length,
  };
}

/**
 * 미리 계산한 방식의 세계: 아티스트마다 MBID와 장르 태그 숫자 묶음, 기준 아티스트의 비슷한 아티스트는
 * 같은·가까운 장르 60점, 먼 장르 30점(실제 ListenBrainz처럼 가까운 장르도 비슷한 아티스트로 나온다).
 */
export function precomputedPorts(
  c: RecommendCase,
  genres: Map<string, string>,
  now = new Date(),
): RecommendPorts {
  const base = casePorts(c, NO_AI, now);
  const artists = [...new Set([c.seed.artist, ...c.pool.map((p) => p.artist)])];
  const artistId = (name: string) =>
    `00000000-0000-4000-b000-${String(artists.indexOf(name)).padStart(12, '0')}`;
  const all = [c.seed, ...c.pool];
  const songIdOf = (i: number) => `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`;
  const vecOf = (artist: string) => {
    const v = toVector(
      (GENRE_TAGS[genres.get(artist) ?? ''] ?? []).map((name) => ({
        name,
        source: 'musicbrainz' as const,
      })),
      null,
    );
    return { w: toSparse(v.tags), decade: v.decade };
  };
  const near = new Set(c.pool.filter((p) => p.near).map((p) => p.artist));
  const fit = new Set(c.pool.filter((p) => p.fits).map((p) => p.artist));
  const songsDocs = new Map<string, SongDoc>(
    all.map((s, i) => [
      songIdOf(i),
      {
        mbid: songIdOf(i),
        artist: s.artist,
        artistMbid: artistId(s.artist),
        title: s.title,
        releaseYear: null,
      },
    ]),
  );
  return {
    ...base,
    songs: {
      ...base.songs,
      byIds: async (ids) =>
        new Map(
          ids.flatMap((id) => (songsDocs.has(id) ? [[id, songsDocs.get(id) as SongDoc]] : [])),
        ),
      byKeys: async (keys) =>
        new Map(
          [...songsDocs.values()].flatMap((s) => {
            const k = songKey(s.artist, s.title);
            return keys.includes(k) ? [[k, s]] : [];
          }),
        ),
    },
    precomputed: {
      similar: async (a) =>
        a === artistId(c.seed.artist)
          ? artists
              .filter((x) => x !== c.seed.artist)
              .map((x) => ({ artistMbid: artistId(x), score: fit.has(x) || near.has(x) ? 60 : 30 }))
          : null,
      vectors: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            all.flatMap((s, i) =>
              artistId(s.artist) === id ? [{ songId: songIdOf(i), ...vecOf(s.artist) }] : [],
            ),
          ]),
        ),
    },
  };
}

/** 미리 계산한 방식은 AI를 부르지 않는다(부르면 시험이 실패하도록) */
const NO_AI: Llm = {
  structured: async () => {
    throw new Error('미리 계산한 방식에서 AI를 불렀습니다');
  },
};

export async function runPrecomputedCase(
  c: RecommendCase,
  genres: Map<string, string>,
): Promise<RecommendOutcome> {
  const r = await recommend(
    precomputedPorts(c, genres),
    {
      seed: c.seed,
      count: c.count,
      include: { live: false, cover: false, remix: false },
      locale: 'en',
      unsupported: [],
    },
    { uid: 'eval' },
    { mode: 'precomputed' },
  );
  if (!r.ok) return { id: c.id, score: 0, picked: 0, withReason: 0 };
  return scorePicks(c, r.items);
}

export async function runRecommendCase(c: RecommendCase, llm: Llm): Promise<RecommendOutcome> {
  const r = await recommend(
    casePorts(c, llm),
    {
      seed: c.seed,
      count: c.count,
      include: { live: false, cover: false, remix: false },
      locale: 'en',
      unsupported: [],
    },
    { uid: 'eval' },
  );
  if (!r.ok) return { id: c.id, score: 0, picked: 0, withReason: 0 };
  return scorePicks(c, r.items);
}

export function summarizeRecommend(results: RecommendOutcome[]) {
  const total = results.reduce((a, r) => a + r.score, 0);
  return {
    cases: results.length,
    score: results.length ? round2(total / results.length) : 0,
    aiPicked: results.reduce((a, r) => a + r.withReason, 0),
    failedIds: results.filter((r) => r.score < 1).map((r) => r.id),
  };
}
