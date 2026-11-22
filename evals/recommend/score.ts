/**
 * 추천 시험 (T17, SPEC 4.9). 기준 곡마다 "어울리는 곡"과 "미끼"를 섞은 후보를 곡 목록·비슷한 곡 출처로 주고,
 * 실제 추천 파이프라인(recommend)을 돌려 AI가 고른 곡 중 어울리는 곡 비율을 잰다.
 * - 음악 데이터·YouTube는 가짜(손으로 만든 후보). AI만 진짜(호출하는 쪽이 넘김).
 * - 비슷한 곡 출처 순서는 미끼가 먼저라, AI가 고르지 못하고 점수 순으로 채우면 점수가 절반쯤에 머문다.
 */
import type { Llm } from '../../functions/src/adapters/llm.js';
import { songKey, type SongDoc } from '../../functions/src/core/catalog.js';
import { recommend, type RecommendPorts } from '../../functions/src/core/recommend.js';
import { memoryEvents } from '../../functions/src/testing/music.js';
import { round2 } from '../matching/score.js';

export interface RecommendCase {
  id: string;
  genre: string;
  seed: { artist: string; title: string };
  count: number;
  pool: { artist: string; title: string; fits: boolean }[];
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
