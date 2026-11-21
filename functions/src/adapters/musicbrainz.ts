import {
  assertMbid,
  createSourceClient,
  MBID,
  isYoutubeVideoId,
  text,
  yearOf,
  youtubeChannelId,
  youtubeVideoId,
  type MusicHttpDeps,
} from './music-http.js';

/**
 * MusicBrainz (T08, 스킬 music-data-terms). 핵심 데이터 CC0, 장르·태그는 CC BY-NC-SA(출처 표시).
 * 곡 정보(아티스트·제목·연도·장르)의 원천이다. YouTube 영상 ID는 녹음의 URL 관계에서, 공식 채널은 아티스트의 URL 관계에서 얻는다.
 */

const API = 'https://musicbrainz.org/ws/2';

export interface RecordingCandidate {
  mbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  firstReleaseYear: number | null;
  /** MusicBrainz 검색 점수 0~100 */
  score: number;
  /** "live, 2003-…" 같은 구분 설명. 라이브 판별(song-matching)에 쓴다. */
  disambiguation: string | null;
  lengthMs: number | null;
}

export interface Genre {
  name: string;
  source: 'musicbrainz' | 'wikidata';
}

export interface RecordingDetail {
  mbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  firstReleaseYear: number | null;
  /** URL 관계(free streaming 등)에 있는 YouTube 영상 ID */
  youtubeVideoIds: string[];
  /** 이 녹음이 연주한 작품. Wikidata P435로 영상 ID·장르를 더 찾는다. */
  workMbids: string[];
  genres: Genre[];
}

export interface ArtistDetail {
  mbid: string;
  name: string;
  /** URL 관계 'youtube' (공식 채널) */
  youtubeChannelIds: string[];
  /** URL 관계 'youtube music' (YouTube Music 채널) */
  youtubeMusicChannelIds: string[];
  wikidataId: string | null;
  genres: Genre[];
}

/** Lucene 특수 문자를 이스케이프하고 따옴표로 감싼다. 검색어 안의 연산자가 질의를 바꾸지 못한다. */
export function luceneQuote(value: string): string {
  const v = value.trim().slice(0, 200);
  return `"${v.replace(/[\\"]/g, '\\$&')}"`;
}

/** 녹음 검색 질의. 녹화 도구도 같은 질의를 쓴다(테스트로 확인). */
export function recordingSearchQuery(artist: string, title: string): string {
  return `artist:${luceneQuote(artist)} AND recording:${luceneQuote(title)}`;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function firstArtist(credit: unknown): { name: string; mbid: string | null } | null {
  const parts = arr(credit)
    .map(obj)
    .filter((p): p is Obj => p !== null);
  if (!parts.length) return null;
  // 이름은 artist-credit 전체(예: "A feat. B")를 이어 붙이고, MBID는 첫 아티스트.
  const name = parts
    .map((p) => `${text(p.name) ?? ''}${typeof p.joinphrase === 'string' ? p.joinphrase : ''}`)
    .join('')
    .trim();
  const first = obj(parts[0]?.artist);
  const mbid = typeof first?.id === 'string' && MBID.test(first.id) ? first.id : null;
  const capped = text(name, 300);
  return capped ? { name: capped, mbid } : null;
}

function parseGenres(v: unknown): Genre[] {
  return arr(v)
    .map(obj)
    .map((g) => text(g?.name, 60))
    .filter((n): n is string => n !== null)
    .map((name) => ({ name, source: 'musicbrainz' as const }));
}

export function parseRecordingSearch(json: unknown): RecordingCandidate[] {
  const out: RecordingCandidate[] = [];
  for (const r of arr(obj(json)?.recordings).map(obj)) {
    if (!r || typeof r.id !== 'string' || !MBID.test(r.id)) continue;
    const title = text(r.title);
    const artist = firstArtist(r['artist-credit']);
    if (!title || !artist) continue;
    out.push({
      mbid: r.id,
      title,
      artist: artist.name,
      artistMbid: artist.mbid,
      firstReleaseYear: yearOf(r['first-release-date']),
      score: typeof r.score === 'number' ? r.score : 0,
      disambiguation: text(r.disambiguation),
      lengthMs: typeof r.length === 'number' ? r.length : null,
    });
  }
  return out;
}

export function parseRecording(json: unknown): RecordingDetail | null {
  const r = obj(json);
  if (!r || typeof r.id !== 'string' || !MBID.test(r.id)) return null;
  const title = text(r.title);
  const artist = firstArtist(r['artist-credit']);
  if (!title || !artist) return null;
  const videos = new Set<string>();
  const works = new Set<string>();
  for (const rel of arr(r.relations).map(obj)) {
    const url = text(obj(rel?.url)?.resource, 500);
    if (url) {
      const id = youtubeVideoId(url);
      if (isYoutubeVideoId(id)) videos.add(id);
    }
    const workId = obj(rel?.work)?.id;
    if (rel?.type === 'performance' && typeof workId === 'string' && MBID.test(workId)) {
      works.add(workId);
    }
  }
  return {
    mbid: r.id,
    title,
    artist: artist.name,
    artistMbid: artist.mbid,
    firstReleaseYear: yearOf(r['first-release-date']),
    youtubeVideoIds: [...videos],
    workMbids: [...works],
    genres: parseGenres(r.genres),
  };
}

export function parseArtist(json: unknown): ArtistDetail | null {
  const a = obj(json);
  const name = text(a?.name);
  if (!a || typeof a.id !== 'string' || !MBID.test(a.id) || !name) return null;
  const channels = new Set<string>();
  const musicChannels = new Set<string>();
  let wikidataId: string | null = null;
  for (const rel of arr(a.relations).map(obj)) {
    const url = text(obj(rel?.url)?.resource, 500);
    if (!url) continue;
    if (rel?.type === 'youtube') {
      const id = youtubeChannelId(url);
      if (id) channels.add(id);
    } else if (rel?.type === 'youtube music') {
      const id = youtubeChannelId(url);
      if (id) musicChannels.add(id);
    } else if (rel?.type === 'wikidata') {
      const m = /^https:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/.exec(url);
      if (m?.[1]) wikidataId = m[1];
    }
  }
  return {
    mbid: a.id,
    name,
    youtubeChannelIds: [...channels],
    youtubeMusicChannelIds: [...musicChannels],
    wikidataId,
    genres: parseGenres(a.genres),
  };
}

export function createMusicBrainz(deps: MusicHttpDeps) {
  const client = createSourceClient('musicbrainz', deps);
  return {
    /** 아티스트 이름·곡 제목으로 녹음 후보를 찾는다. */
    async searchRecordings(
      artist: string,
      title: string,
      limit = 5,
    ): Promise<RecordingCandidate[]> {
      const query = recordingSearchQuery(artist, title);
      const params = new URLSearchParams({
        query,
        fmt: 'json',
        limit: String(Math.min(Math.max(limit, 1), 25)),
      });
      const { body } = await client.get(
        `${API}/recording/?${params}`,
        'musicbrainz.recording.search',
      );
      return parseRecordingSearch(body);
    },
    async getRecording(mbid: string): Promise<RecordingDetail | null> {
      const params = new URLSearchParams({
        inc: 'artist-credits+url-rels+genres+work-rels',
        fmt: 'json',
      });
      const { body } = await client.get(
        `${API}/recording/${assertMbid(mbid)}?${params}`,
        'musicbrainz.recording.get',
      );
      return parseRecording(body);
    },
    async getArtist(mbid: string): Promise<ArtistDetail | null> {
      const params = new URLSearchParams({ inc: 'url-rels+genres', fmt: 'json' });
      const { body } = await client.get(
        `${API}/artist/${assertMbid(mbid)}?${params}`,
        'musicbrainz.artist.get',
      );
      return parseArtist(body);
    },
  };
}
