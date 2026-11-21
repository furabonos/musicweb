import { assertMbid, createSourceClient, MBID, text, type MusicHttpDeps } from './music-http.js';

/**
 * ListenBrainz Labs (T08, 스킬 music-data-terms). 비슷한 곡·비슷한 아티스트의 주 재료(D-005).
 * 실험 서비스라 SLA가 없다. 응답이 없으면 SourceUnavailableError → 추천은 Last.fm·AI 후보로 대신한다.
 *
 * 비슷한 곡은 ListenBrainz가 대표로 쓰는 녹음 MBID로만 결과가 나온다(MusicBrainz 검색의 다른 판 MBID는 빈 결과).
 * 그래서 기준 곡은 searchRecording으로 대표 MBID를 먼저 찾는다(D-024).
 */

const LABS = 'https://labs.api.listenbrainz.org';
/** Labs 화면에 나온 알고리즘 이름. 바뀌면 빈 결과가 오므로 녹화 응답을 다시 받아 확인한다. */
export const LB_RECORDING_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000';
export const LB_ARTIST_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

export interface LbRecording {
  mbid: string;
  title: string;
  artist: string;
  releaseName: string | null;
}

export interface SimilarRecording extends LbRecording {
  /** 같이 들은 정도. 클수록 비슷하다(절대값 의미 없음, 순서만 씀). */
  score: number;
}

export interface SimilarArtist {
  mbid: string;
  name: string;
  score: number;
}

type Obj = Record<string, unknown>;
const rows = (json: unknown): Obj[] =>
  (Array.isArray(json) ? json : []).filter((r): r is Obj => !!r && typeof r === 'object');
const isMbid = (v: unknown): v is string => typeof v === 'string' && MBID.test(v);

function parseRecordingRow(r: Obj): LbRecording | null {
  const title = text(r.recording_name);
  const artist = text(r.artist_credit_name);
  if (!isMbid(r.recording_mbid) || !title || !artist) return null;
  return { mbid: r.recording_mbid, title, artist, releaseName: text(r.release_name) };
}

export function parseRecordingSearch(json: unknown): LbRecording[] {
  return rows(json)
    .map(parseRecordingRow)
    .filter((r): r is LbRecording => r !== null);
}

export function parseSimilarRecordings(json: unknown, referenceMbid: string): SimilarRecording[] {
  const out: SimilarRecording[] = [];
  for (const r of rows(json)) {
    const base = parseRecordingRow(r);
    if (!base || base.mbid === referenceMbid) continue;
    if (r.reference_mbid !== undefined && r.reference_mbid !== referenceMbid) continue;
    out.push({ ...base, score: typeof r.score === 'number' ? r.score : 0 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function parseSimilarArtists(json: unknown, referenceMbid: string): SimilarArtist[] {
  const out: SimilarArtist[] = [];
  for (const r of rows(json)) {
    const name = text(r.name);
    if (!isMbid(r.artist_mbid) || !name || r.artist_mbid === referenceMbid) continue;
    out.push({ mbid: r.artist_mbid, name, score: typeof r.score === 'number' ? r.score : 0 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function createListenBrainz(deps: MusicHttpDeps) {
  const client = createSourceClient('listenbrainz', deps);
  return {
    /** "아티스트 제목" 자유 검색 → ListenBrainz 대표 녹음 MBID 후보. */
    async searchRecording(query: string): Promise<LbRecording[]> {
      const q = query.trim().slice(0, 200);
      if (!q) return [];
      const params = new URLSearchParams({ query: q });
      const { body } = await client.get(
        `${LABS}/recording-search/json?${params}`,
        'listenbrainz.recording.search',
      );
      return parseRecordingSearch(body);
    },
    async similarRecordings(mbid: string, limit = 50): Promise<SimilarRecording[]> {
      const params = new URLSearchParams({
        recording_mbids: assertMbid(mbid),
        algorithm: LB_RECORDING_ALGORITHM,
      });
      const { body } = await client.get(
        `${LABS}/similar-recordings/json?${params}`,
        'listenbrainz.similarRecordings',
      );
      return parseSimilarRecordings(body, mbid).slice(0, limit);
    },
    async similarArtists(mbid: string, limit = 30): Promise<SimilarArtist[]> {
      const params = new URLSearchParams({
        artist_mbids: assertMbid(mbid),
        algorithm: LB_ARTIST_ALGORITHM,
      });
      const { body } = await client.get(
        `${LABS}/similar-artists/json?${params}`,
        'listenbrainz.similarArtists',
      );
      return parseSimilarArtists(body, mbid).slice(0, limit);
    },
  };
}
