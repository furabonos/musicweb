import type { Firestore } from 'firebase-admin/firestore';
import { consume } from '../core/budget.js';
import { recordCall, type EventSink, type ExternalOp } from '../core/events.js';
import type { Feature } from '../core/runtimeConfig.js';

/**
 * YouTube 읽기 (T10, 스킬 youtube-policy). 읽기(GET)만 한다 — 쓰기는 youtube-write.ts뿐(lint).
 * - channels.list·playlistItems.list·videos.list는 1단위. search.list는 단위가 아니라 **하루 100회 별도 한도**다
 *   ("100 search.list calls … and 10,000 units per day combined for all other endpoints", RESEARCH 1, D-007).
 *   그래서 검색은 ytUnits를 쓰지 않고 횟수 카운터(사용자 80·작업 20)만 쓴다.
 * - 모든 호출은 보내기 전에 단위를 쓴다(consume). YouTube는 실패한 요청에도 할당량을 쓰므로 정산하지 않는다.
 * - 채널 영상은 search가 아니라 uploads 재생목록(playlistItems)으로 받는다.
 * - API 키는 주소에만 들어간다. 기록·오류 메시지에는 넣지 않는다.
 * - 받은 데이터는 YouTube 데이터라 30일 안에 재확인하거나 지운다(D-004, T11).
 */

const API = 'https://www.googleapis.com/youtube/v3';
const REQUEST_TIMEOUT_MS = 15_000;

export interface YtCost {
  ytUnits: number;
  ytSearchUser?: number;
  ytSearchJob?: number;
}

/** 호출 전에 쓸 양을 기록한다. 상한·긴급 정지면 던진다. */
export interface YtBudget {
  spend(cost: YtCost, user?: { uid: string; searches: number }): Promise<void>;
}

/** 운영용: Firestore 카운터에 쓴다. feature를 주면 긴급 정지도 같이 확인한다. */
export function firestoreYtBudget(db: Firestore, feature?: Feature): YtBudget {
  return {
    spend: (cost, user) =>
      consume(db, {
        service: cost,
        ...(user ? { user: { uid: user.uid, counters: { searches: user.searches } } } : {}),
        ...(feature ? { feature } : {}),
      }),
  };
}

export interface YouTubeReadDeps {
  apiKey: string;
  events: EventSink;
  budget: YtBudget;
  fetch?: typeof fetch;
}

export interface VideoDetail {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  /** 앞부분만(종류 판별의 "Provided to YouTube by" 확인용). 저장하지 않는다. */
  description: string;
  durationSec: number | null;
  publishedAt: string | null;
  embeddable: boolean;
  madeForKids: boolean;
  privacyStatus: string;
}

export interface UploadItem {
  videoId: string;
  publishedAt: string | null;
}

export class YouTubeReadError extends Error {
  override name = 'YouTubeReadError';
  constructor(
    readonly status: number | null,
    readonly reason: string | null,
  ) {
    super(`YouTube 읽기 실패: status=${status ?? 'network'} reason=${reason ?? 'unknown'}`);
  }
}

export class YouTubeConfigError extends Error {
  override name = 'YouTubeConfigError';
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/** ISO 8601 기간(PT4M25S, PT1H2M3S, P1DT2H) → 초. 라이브 중(P0D)이나 형식 오류는 null. */
export function parseDuration(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  const total = (d ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (s ?? 0);
  return total > 0 ? total : null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const items = (json: unknown): Obj[] =>
  (Array.isArray(obj(json).items) ? (obj(json).items as unknown[]) : []).map(obj);

export function parseUploadsPlaylist(json: unknown): string | null {
  const id = obj(obj(obj(items(json)[0]).contentDetails).relatedPlaylists).uploads;
  return typeof id === 'string' && PLAYLIST_ID.test(id) ? id : null;
}

export function parsePlaylistItems(json: unknown): {
  items: UploadItem[];
  nextPageToken: string | null;
} {
  const out: UploadItem[] = [];
  for (const it of items(json)) {
    const cd = obj(it.contentDetails);
    const id = cd.videoId;
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) continue;
    out.push({ videoId: id, publishedAt: str(cd.videoPublishedAt, 40) || null });
  }
  const next = obj(json).nextPageToken;
  return {
    items: out,
    nextPageToken: typeof next === 'string' && next ? next.slice(0, 200) : null,
  };
}

export function parseVideos(json: unknown): VideoDetail[] {
  const out: VideoDetail[] = [];
  for (const it of items(json)) {
    const id = it.id;
    const sn = obj(it.snippet);
    const st = obj(it.status);
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) continue;
    const channelId = str(sn.channelId, 40);
    if (!CHANNEL_ID.test(channelId)) continue;
    out.push({
      videoId: id,
      title: str(sn.title, 200),
      channelId,
      channelTitle: str(sn.channelTitle, 200),
      description: str(sn.description, 300),
      durationSec: parseDuration(obj(it.contentDetails).duration),
      publishedAt: str(sn.publishedAt, 40) || null,
      embeddable: st.embeddable === true,
      madeForKids: st.madeForKids === true,
      privacyStatus: str(st.privacyStatus, 20),
    });
  }
  return out;
}

export function parseSearch(json: unknown): string[] {
  return items(json)
    .map((it) => obj(it.id).videoId)
    .filter((id): id is string => typeof id === 'string' && VIDEO_ID.test(id));
}

export function createYouTubeRead(deps: YouTubeReadDeps) {
  if (!deps.apiKey || /\s/.test(deps.apiKey))
    throw new YouTubeConfigError('YOUTUBE_API_KEY가 없습니다.');
  const doFetch = deps.fetch ?? fetch;

  async function get(
    resource: 'channels' | 'playlistItems' | 'videos' | 'search',
    params: Record<string, string>,
    cost: YtCost,
    op: ExternalOp,
    user?: { uid: string; searches: number },
  ): Promise<unknown> {
    await deps.budget.spend(cost, user);
    const url = `${API}/${resource}?${new URLSearchParams({ ...params, key: deps.apiKey })}`;
    return recordCall(
      deps.events,
      { target: 'youtube_read', op, ...(user ? { actorUid: user.uid } : {}) },
      async () => {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {
          throw new YouTubeReadError(null, 'network');
        }
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const errs = obj(obj(body).error).errors;
          const r = Array.isArray(errs) ? obj(errs[0]).reason : null;
          throw new YouTubeReadError(res.status, typeof r === 'string' ? r.slice(0, 64) : null);
        }
        return { result: body, units: cost.ytUnits, status: res.status };
      },
      (err) => ({
        units: cost.ytUnits,
        ...(err instanceof YouTubeReadError && err.status !== null ? { status: err.status } : {}),
      }),
    );
  }

  return {
    /** 채널의 업로드 재생목록 ID (1단위) */
    async uploadsPlaylist(channelId: string): Promise<string | null> {
      if (!CHANNEL_ID.test(channelId)) throw new YouTubeConfigError('채널 ID 형식이 잘못됐습니다.');
      const body = await get(
        'channels',
        { part: 'contentDetails', id: channelId },
        { ytUnits: 1 },
        'channels.list',
      );
      return parseUploadsPlaylist(body);
    },
    /** 업로드 목록 한 쪽(최대 50개, 1단위). 최신 것부터 온다. */
    async uploadsPage(playlistId: string, pageToken?: string) {
      if (!PLAYLIST_ID.test(playlistId))
        throw new YouTubeConfigError('재생목록 ID 형식이 잘못됐습니다.');
      const body = await get(
        'playlistItems',
        {
          part: 'contentDetails',
          playlistId,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        },
        { ytUnits: 1 },
        'playlistItems.list',
      );
      return parsePlaylistItems(body);
    },
    /** 영상 상세. 50개씩 나눠 요청한다(요청당 1단위). */
    async videos(ids: string[]): Promise<VideoDetail[]> {
      const valid = [...new Set(ids.filter((id) => VIDEO_ID.test(id)))];
      const out: VideoDetail[] = [];
      for (let i = 0; i < valid.length; i += 50) {
        const part = valid.slice(i, i + 50);
        const body = await get(
          'videos',
          { part: 'snippet,contentDetails,status', id: part.join(','), maxResults: '50' },
          { ytUnits: 1 },
          'videos.list',
        );
        out.push(...parseVideos(body));
      }
      return out;
    },
    /** 검색 (마지막 수단, 하루 100회 별도 한도 — 단위는 안 씀). who: 사용자 요청이면 user, 야간 작업이면 job. */
    async search(
      query: string,
      who: { kind: 'job' } | { kind: 'user'; uid: string },
      maxResults = 10,
    ): Promise<string[]> {
      const q = query.trim().slice(0, 200);
      if (!q) return [];
      // 검색은 단위가 아니라 횟수 한도(D-007)
      const cost: YtCost =
        who.kind === 'job' ? { ytUnits: 0, ytSearchJob: 1 } : { ytUnits: 0, ytSearchUser: 1 };
      const body = await get(
        'search',
        {
          part: 'id',
          type: 'video',
          q,
          maxResults: String(Math.min(Math.max(maxResults, 1), 25)),
          videoEmbeddable: 'true',
        },
        cost,
        'search.list',
        who.kind === 'user' ? { uid: who.uid, searches: 1 } : undefined,
      );
      return parseSearch(body);
    },
  };
}

export type YouTubeRead = ReturnType<typeof createYouTubeRead>;
