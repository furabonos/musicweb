import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  createSourceClient,
  MBID,
  MusicConfigError,
  text,
  type MusicHttpDeps,
} from './music-http.js';

/**
 * Last.fm (T08, 스킬 music-data-terms) — 보조 재료. **비상업 전용**, Last.fm 표시·링크 의무, 이미지 사용 금지.
 * - 곡 목록에 영구 저장하지 않는다. 응답은 lastfmCache에만, HTTP 캐시 헤더(Cache-Control max-age, Expires)가 정한 기간만 둔다.
 *   헤더가 없거나 no-store/no-cache면 저장하지 않는다.
 * - 캐시 전체는 100MB 상한. 넘으면 오래 저장된 것부터 지운다.
 * - 오류 29(요청 너무 많음)는 429처럼 쉬었다 다시 한다.
 * - API 키는 주소에만 들어간다. 캐시 키·기록·오류 메시지에는 넣지 않는다.
 */

const API = 'https://ws.audioscrobbler.com/2.0/';
export const LASTFM_CACHE_MAX_BYTES = 100 * 1024 * 1024;
/** Firestore 문서 하나 한도(1MiB)보다 작게. 넘는 응답은 저장하지 않는다. */
const MAX_ENTRY_BYTES = 900 * 1024;

export interface SimilarTrack {
  title: string;
  artist: string;
  mbid: string | null;
  artistMbid: string | null;
  /** 0~1 유사도 */
  match: number;
}

export interface CacheEntry {
  body: string;
  bytes: number;
  storedAt: number;
  expiresAt: number;
}

/** 캐시 저장소. 운영은 firestoreLastfmCache, 테스트는 memoryLastfmCache. */
export interface LastfmCacheStore {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  totalBytes(): Promise<number>;
  /** 저장 시각이 오래된 것부터 */
  oldest(limit: number): Promise<{ key: string; bytes: number }[]>;
  /** 보관 기간이 지난 것(expiresAt <= now) */
  expired(now: number, limit: number): Promise<string[]>;
}

/** Last.fm이 HTTP 200으로 보내는 오류 중 "결과 없음"으로 봐도 되는 것. 나머지(키 오류 10, 정지 26 등)는 던진다. */
const LASTFM_NOT_FOUND = 6;

export class LastfmApiError extends Error {
  override name = 'LastfmApiError';
  constructor(readonly code: number) {
    super(`Last.fm 오류 코드 ${code}`);
  }
}

/**
 * 보관 기간이 지난 캐시를 지운다. 매일 정리 작업(T11 purge)이 부른다.
 * 다시 요청되지 않는 항목도 기간이 지나면 남지 않게 하기 위함이다(스킬 music-data-terms).
 * @returns 지운 개수
 */
export async function purgeExpiredCache(store: LastfmCacheStore, now: number, batch = 200) {
  let removed = 0;
  const tried = new Set<string>();
  for (;;) {
    const keys = await store.expired(now, batch);
    // 지운 것이 다시 나오면(삭제가 안 먹힘) 끝없이 돌지 않게 멈춘다.
    if (keys.some((k) => tried.has(k))) {
      console.error('Last.fm 캐시 정리: 지운 항목이 다시 나와 멈춥니다', { removed });
      return removed;
    }
    for (const k of keys) {
      tried.add(k);
      await store.delete(k);
    }
    removed += keys.length;
    if (keys.length < batch) return removed;
  }
}

/**
 * HTTP 캐시 헤더 → 남은 보관 기간(ms). 저장하면 안 되면 0.
 * s-maxage가 max-age보다 우선이고, 중간 캐시에서 이미 지난 시간(Age)을 뺀다.
 */
export function cacheTtlMs(headers: Headers, now: number): number {
  const cc = (headers.get('Cache-Control') ?? '').toLowerCase();
  if (/\b(no-store|no-cache|private)\b/.test(cc)) return 0;
  const age = Math.max(0, Number(headers.get('Age') ?? 0) || 0) * 1000;
  const sMax = /\bs-maxage=(\d+)/.exec(cc)?.[1];
  const max = /\bmax-age=(\d+)/.exec(cc)?.[1];
  const seconds = sMax ?? max;
  if (seconds !== undefined) return Math.max(0, Number(seconds) * 1000 - age);
  const expires = headers.get('Expires');
  if (expires) {
    const at = Date.parse(expires);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return 0;
}

/** 상한을 넘으면 오래된 것부터 지운다. */
export async function enforceCacheCap(store: LastfmCacheStore, maxBytes = LASTFM_CACHE_MAX_BYTES) {
  let total = await store.totalBytes();
  while (total > maxBytes) {
    const batch = await store.oldest(50);
    if (!batch.length) break;
    for (const { key, bytes } of batch) {
      if (total <= maxBytes) break;
      await store.delete(key);
      total -= bytes;
    }
  }
}

export function parseSimilarTracks(json: unknown): SimilarTrack[] {
  const tracks = (json as { similartracks?: { track?: unknown } } | null)?.similartracks?.track;
  const out: SimilarTrack[] = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const a = (r.artist && typeof r.artist === 'object' ? r.artist : {}) as Record<string, unknown>;
    const title = text(r.name);
    const artist = text(a.name);
    const match = typeof r.match === 'number' ? r.match : Number(r.match);
    if (!title || !artist || !Number.isFinite(match)) continue;
    out.push({
      title,
      artist,
      mbid: typeof r.mbid === 'string' && MBID.test(r.mbid) ? r.mbid : null,
      artistMbid: typeof a.mbid === 'string' && MBID.test(a.mbid) ? a.mbid : null,
      match: Math.min(Math.max(match, 0), 1),
    });
  }
  return out.sort((x, y) => y.match - x.match);
}

export interface LastfmDeps extends MusicHttpDeps {
  apiKey: string;
  cache: LastfmCacheStore;
  maxCacheBytes?: number;
}

export function createLastfm(deps: LastfmDeps) {
  if (!deps.apiKey || /\s/.test(deps.apiKey))
    throw new MusicConfigError('LASTFM_API_KEY가 없습니다.');
  const client = createSourceClient('lastfm', deps);
  const now = deps.now ?? Date.now;
  return {
    async similarTracks(artist: string, track: string, limit = 30): Promise<SimilarTrack[]> {
      const a = artist.trim().slice(0, 200);
      const t = track.trim().slice(0, 200);
      if (!a || !t) return [];
      const lim = String(Math.min(Math.max(limit, 1), 100));
      const key = createHash('sha256')
        .update(['track.getsimilar', a.toLowerCase(), t.toLowerCase(), lim].join('\u0000'))
        .digest('hex');

      const hit = await deps.cache.get(key);
      if (hit && hit.expiresAt > now()) {
        const cached = safeParse(hit.body);
        if (cached !== undefined) return parseSimilarTracks(cached);
      }
      if (hit) await deps.cache.delete(key); // 기간이 지났거나 깨진 것은 지우고 다시 받는다

      const params = new URLSearchParams({
        method: 'track.getsimilar',
        artist: a,
        track: t,
        autocorrect: '1',
        limit: lim,
        api_key: deps.apiKey,
        format: 'json',
      });
      const { body, headers } = await client.get(`${API}?${params}`, 'lastfm.track.getSimilar', {
        isThrottled: (_status, b) => (b as { error?: unknown } | null)?.error === 29,
      });
      const code = (body as { error?: unknown } | null)?.error;
      if (code !== undefined) {
        if (code === LASTFM_NOT_FOUND) return [];
        throw new LastfmApiError(typeof code === 'number' ? code : -1);
      }

      const ttl = cacheTtlMs(headers, now());
      const raw = JSON.stringify(body);
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (ttl > 0 && bytes <= MAX_ENTRY_BYTES) {
        await deps.cache.put(key, { body: raw, bytes, storedAt: now(), expiresAt: now() + ttl });
        await enforceCacheCap(deps.cache, deps.maxCacheBytes);
      }
      return parseSimilarTracks(body);
    },
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 테스트·로컬용 메모리 캐시. */
export function memoryLastfmCache(): LastfmCacheStore & { keys(): string[] } {
  const m = new Map<string, CacheEntry>();
  return {
    keys: () => [...m.keys()],
    get: async (k) => m.get(k) ?? null,
    put: async (k, e) => void m.set(k, e),
    delete: async (k) => void m.delete(k),
    totalBytes: async () => [...m.values()].reduce((s, e) => s + e.bytes, 0),
    oldest: async (limit) =>
      [...m.entries()]
        .sort((a, b) => a[1].storedAt - b[1].storedAt)
        .slice(0, limit)
        .map(([key, e]) => ({ key, bytes: e.bytes })),
    expired: async (now, limit) =>
      [...m.entries()]
        .filter(([, e]) => e.expiresAt <= now)
        .slice(0, limit)
        .map(([k]) => k),
  };
}

/**
 * 운영용 Firestore 캐시: lastfmCache/{sha256}. 보안 규칙에 match가 없어 서버 전용.
 * 전체 크기는 lastfmCache/_meta.totalBytes에 트랜잭션으로 더하고 뺀다.
 */
export function firestoreLastfmCache(db: Firestore): LastfmCacheStore {
  const col = db.collection('lastfmCache');
  const meta = col.doc('_meta');
  return {
    async get(key) {
      const snap = await col.doc(key).get();
      if (!snap.exists) return null;
      const d = snap.data() as Partial<CacheEntry>;
      if (typeof d.body !== 'string' || typeof d.bytes !== 'number') return null;
      return {
        body: d.body,
        bytes: d.bytes,
        storedAt: Number(d.storedAt),
        expiresAt: Number(d.expiresAt),
      };
    },
    async put(key, entry) {
      await db.runTransaction(async (tx) => {
        const ref = col.doc(key);
        const old = await tx.get(ref);
        const oldBytes = old.exists ? Number(old.get('bytes') ?? 0) : 0;
        tx.set(ref, entry);
        tx.set(meta, { totalBytes: FieldValue.increment(entry.bytes - oldBytes) }, { merge: true });
      });
    },
    async delete(key) {
      await db.runTransaction(async (tx) => {
        const ref = col.doc(key);
        const old = await tx.get(ref);
        if (!old.exists) return;
        tx.delete(ref);
        tx.set(
          meta,
          { totalBytes: FieldValue.increment(-Number(old.get('bytes') ?? 0)) },
          { merge: true },
        );
      });
    },
    async totalBytes() {
      const v: unknown = (await meta.get()).get('totalBytes');
      return typeof v === 'number' && v > 0 ? v : 0;
    },
    async oldest(limit) {
      // _meta에는 storedAt이 없어서 이 정렬 결과에 들어오지 않는다(테스트로 확인).
      const snap = await col.orderBy('storedAt').limit(limit).select('bytes').get();
      return snap.docs.map((d) => ({ key: d.id, bytes: Number(d.get('bytes') ?? 0) }));
    },
    async expired(now, limit) {
      const snap = await col.where('expiresAt', '<=', now).limit(limit).select().get();
      return snap.docs.map((d) => d.id);
    },
  };
}
