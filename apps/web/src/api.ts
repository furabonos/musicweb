import type { Locale } from '@musicweb/shared';

/**
 * 화면이 쓰는 서버 기능. 운영은 firebaseApi.ts(Firebase callable), 화면 테스트는 가짜를 넣는다.
 * 서버 응답 형식은 functions/src/core/playlists.ts와 같다(화면은 서버 코드를 import하지 않으므로 여기 다시 적는다).
 */
export interface PlayableItem {
  songId: string;
  artist: string;
  title: string;
  reason: string | null;
  videoId: string | null;
  kind: string | null;
}

export type UnsupportedCode = 'year' | 'mood' | 'exclude_artist' | 'genre' | 'other';
export type CreateFailReason =
  | 'empty'
  | 'too_long'
  | 'no_output'
  | 'schema_invalid'
  | 'not_understood'
  | 'no_seed'
  | 'seed_not_found';

export type CreateResult =
  | {
      ok: true;
      id: string;
      seed: { artist: string; title: string };
      items: PlayableItem[];
      shortfall: { requested: number; got: number } | null;
      unsupported: UnsupportedCode[];
      locale: Locale;
    }
  | { ok: false; reason: CreateFailReason };

/** 서버 거부. code는 callable 오류 코드, details는 서버가 준 이유(언어 문구는 화면이 고른다). */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: string,
    readonly details: { reason?: string; scope?: string; resetAt?: string } = {},
  ) {
    super(code);
  }
}

export type OpenLinkMode = 'direct' | 'fallback';

/** 공유 재생목록(`/p/:id`). 검색 문장은 없다. */
export interface SharedPlaylist {
  id: string;
  title: string;
  seed: { artist: string; title: string };
  items: PlayableItem[];
  locale: Locale;
  state: 'draft' | 'saved';
  openLink: OpenLinkMode;
}

/** 공개 현황판(`/status`, T21). 서버 `functions/src/api/status.ts`의 응답 모양 */
export interface StatusMetric {
  value: number | null;
  unit: 'rate' | 'count' | 'score' | 'hours';
  /** 계산 방법(서버가 쓴 영어 고정 문장) */
  method: string;
}
export interface StatusRecentFix {
  number: number;
  url: string;
  state: string | null;
  ci: string | null;
  openedAt: string | null;
  reverted: boolean;
  rejectReason: string | null;
}
export interface StatusData {
  updatedAt: string | null;
  service: Record<string, StatusMetric>;
  catalog: Record<string, StatusMetric>;
  github:
    | { unavailable: string }
    | {
        updatedAt: string | null;
        metrics: Record<string, StatusMetric>;
        rejectReasons: { reason: string; count: number }[];
        recent: StatusRecentFix[];
      }
    | null;
  opsLog: { at: string | null; kind: string | null; message: string | null; links: string[] }[];
}

/** 관리자 화면(`/admin`, T22). 서버 `admin-overview` 응답 모양 */
export interface AdminOverview {
  killSwitches: Record<'create' | 'ingest' | 'autoIssue', boolean>;
  savingMode: boolean;
  limits: { service: Record<string, number>; user: Record<string, number> };
  usage: { day: string; used: Record<string, number> };
  jobs: { job: string; at: string | null; outcome: string; processed: number; failed: number }[];
  artists: {
    id: string;
    name: string;
    status: string;
    failCount: number;
    channelId: string | null;
    lastScannedAt: string | null;
  }[];
  testers: { uid: string; email: string | null }[];
  blocked: { uid: string; email: string | null }[];
}
export type AdminAction =
  | 'setKillSwitch'
  | 'setLimits'
  | 'addArtist'
  | 'setArtistStatus'
  | 'setLinkStatus'
  | 'setUserBlocked'
  | 'setExportTester'
  | 'runJob';

export interface SignedInUser {
  uid: string;
}

export interface MusicwebApi {
  /** 로그인 상태가 바뀔 때마다 부른다. 돌려준 함수로 구독을 끊는다. */
  onUser(cb: (user: SignedInUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  create(text: string, locale: Locale): Promise<CreateResult>;
  update(
    id: string,
    action: 'remove' | 'replace',
    position: number,
  ): Promise<{ items: PlayableItem[] }>;
  save(id: string): Promise<{ id: string; state: 'saved' }>;
  /** 플레이어 오류 101·150(퍼가기 불가)을 기록한다(embed_blocked). 실패해도 재생은 계속. */
  reportEmbedBlocked(code: 101 | 150): Promise<void>;
  /** 재생목록 열기. 없거나 볼 수 없으면 ApiError('not-found') */
  getPlaylist(id: string): Promise<SharedPlaylist>;
  /** "YouTube에서 열기" 방식(D-006) */
  /** savingMode: 오늘 AI 비용 상한에 닿아 AI 없이 동작 중(SPEC 3.4) */
  siteConfig(): Promise<{ openLink: OpenLinkMode; savingMode?: boolean; noAi?: boolean }>;
  /** 공개 현황판 수치와 운영 일지 (로그인 불필요) */
  status(): Promise<StatusData>;
  /** 관리자 화면 한눈에 보기. 관리자가 아니면 ApiError('permission-denied') */
  adminOverview(): Promise<AdminOverview>;
  /** 관리자 변경. 서버가 관리자 확인·감사 기록을 한다 */
  admin(action: AdminAction, data: Record<string, unknown>): Promise<unknown>;
}
