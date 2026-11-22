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
  'empty' | 'too_long' | 'no_output' | 'schema_invalid' | 'no_seed' | 'seed_not_found';

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
}
