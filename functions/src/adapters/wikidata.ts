import {
  assertMbid,
  createSourceClient,
  isYoutubeChannelId,
  isYoutubeVideoId,
  MusicConfigError,
  text,
  yearOf,
  type MusicHttpDeps,
} from './music-http.js';

/**
 * Wikidata SPARQL (T08, 스킬 music-data-terms, CC0).
 * - 작품(MusicBrainz work ID, P435) → YouTube 영상 ID(P1651), 장르(P136), 발표일(P577)
 * - 아티스트(MusicBrainz artist ID, P434) → YouTube 채널(P2397)
 * 질의에 넣는 값은 MBID 형식 검사를 통과한 것만 쓴다(질의 주입 방지).
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';
const ACCEPT = 'application/sparql-results+json';
const MAX_IDS = 50;

export interface WorkInfo {
  workMbid: string;
  wikidataId: string | null;
  youtubeVideoIds: string[];
  genres: { name: string; source: 'wikidata' }[];
  publicationYear: number | null;
}

export interface ArtistChannels {
  artistMbid: string;
  wikidataId: string | null;
  youtubeChannelIds: string[];
}

type Binding = Record<string, { value?: unknown } | undefined>;

function bindings(json: unknown): Binding[] {
  const b = (json as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  return Array.isArray(b) ? (b.filter((x) => x && typeof x === 'object') as Binding[]) : [];
}
const val = (b: Binding, k: string) => b[k]?.value;
const qid = (v: unknown) => {
  const m = typeof v === 'string' ? /\/entity\/(Q\d+)$/.exec(v) : null;
  return m?.[1] ?? null;
};

function chunks(ids: string[]): string[][] {
  const unique = [...new Set(ids.map(assertMbid))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += MAX_IDS) out.push(unique.slice(i, i + MAX_IDS));
  return out;
}

function values(ids: string[]): string {
  const unique = [...new Set(ids.map(assertMbid))];
  if (unique.length > MAX_IDS) {
    throw new MusicConfigError(`한 질의에 MBID는 ${MAX_IDS}개까지입니다.`);
  }
  return unique.map((id) => `"${id}"`).join(' ');
}

export function worksQuery(workMbids: string[]): string {
  return `SELECT ?item ?work ?yt ?genreLabel ?date WHERE { VALUES ?work { ${values(workMbids)} } ?item wdt:P435 ?work . OPTIONAL { ?item wdt:P1651 ?yt } OPTIONAL { ?item wdt:P136 ?genre } OPTIONAL { ?item wdt:P577 ?date } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
}

export function artistsQuery(artistMbids: string[]): string {
  return `SELECT ?item ?artist ?channel WHERE { VALUES ?artist { ${values(artistMbids)} } ?item wdt:P434 ?artist . OPTIONAL { ?item wdt:P2397 ?channel } }`;
}

export function parseWorks(json: unknown): Map<string, WorkInfo> {
  const out = new Map<string, WorkInfo>();
  const genreSets = new Map<string, Set<string>>();
  for (const b of bindings(json)) {
    const work = val(b, 'work');
    if (typeof work !== 'string') continue;
    let info = out.get(work);
    if (!info) {
      info = {
        workMbid: work,
        wikidataId: qid(val(b, 'item')),
        youtubeVideoIds: [],
        genres: [],
        publicationYear: null,
      };
      out.set(work, info);
      genreSets.set(work, new Set());
    }
    const yt = val(b, 'yt');
    if (isYoutubeVideoId(yt) && !info.youtubeVideoIds.includes(yt)) info.youtubeVideoIds.push(yt);
    const genre = text(val(b, 'genreLabel'), 60);
    // 라벨이 없으면 Q번호가 그대로 온다 → 장르로 쓰지 않는다.
    if (genre && !/^Q\d+$/.test(genre)) genreSets.get(work)?.add(genre);
    const year = yearOf(val(b, 'date'));
    if (year !== null && (info.publicationYear === null || year < info.publicationYear))
      info.publicationYear = year;
  }
  for (const [work, info] of out) {
    info.genres = [...(genreSets.get(work) ?? [])].map((name) => ({
      name,
      source: 'wikidata' as const,
    }));
  }
  return out;
}

export function parseArtists(json: unknown): Map<string, ArtistChannels> {
  const out = new Map<string, ArtistChannels>();
  for (const b of bindings(json)) {
    const artist = val(b, 'artist');
    if (typeof artist !== 'string') continue;
    let info = out.get(artist);
    if (!info) {
      info = { artistMbid: artist, wikidataId: qid(val(b, 'item')), youtubeChannelIds: [] };
      out.set(artist, info);
    }
    const ch = val(b, 'channel');
    if (isYoutubeChannelId(ch) && !info.youtubeChannelIds.includes(ch))
      info.youtubeChannelIds.push(ch);
  }
  return out;
}

export function createWikidata(deps: MusicHttpDeps) {
  const client = createSourceClient('wikidata', deps);
  const run = async (query: string) => {
    const { body } = await client.get(
      `${ENDPOINT}?${new URLSearchParams({ query })}`,
      'wikidata.sparql',
      {
        accept: ACCEPT,
      },
    );
    return body;
  };
  return {
    /** 50개씩 나눠 요청한다(조용히 버리지 않음). */
    async works(workMbids: string[]): Promise<Map<string, WorkInfo>> {
      const out = new Map<string, WorkInfo>();
      for (const part of chunks(workMbids)) {
        for (const [k, v] of parseWorks(await run(worksQuery(part)))) out.set(k, v);
      }
      return out;
    },
    async artistChannels(artistMbids: string[]): Promise<Map<string, ArtistChannels>> {
      const out = new Map<string, ArtistChannels>();
      for (const part of chunks(artistMbids)) {
        for (const [k, v] of parseArtists(await run(artistsQuery(part)))) out.set(k, v);
      }
      return out;
    },
  };
}
