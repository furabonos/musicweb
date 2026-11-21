import type { EventSink } from '../core/events.js';

/**
 * youtube-write.ts의 오류·상수·타입. 실행 시점에 내보내는 함수를 youtube-write.ts에 두 개만 두기 위해 분리했다.
 */

/** 재생목록 하나에 넣을 수 있는 최대 곡 수 (SPEC 6.3). */
export const MAX_EXPORT_ITEMS = 30;
/** playlists.insert / playlistItems.insert 한 번의 할당량 (youtube-policy 스킬). */
export const YT_INSERT_UNITS = 50;
/** YouTube 재생목록 제목 최대 길이. */
export const MAX_TITLE_LENGTH = 150;

export interface YouTubeWriteContext {
  db: FirebaseFirestore.Firestore;
  /**
   * 이 사용자의 YouTube 접근 토큰을 돌려준다(T26: secrets_oauth에서 복호화).
   * 어댑터는 토큰을 저장하거나 오류·로그에 넣지 않는다.
   */
  getAccessToken: (uid: string) => Promise<string>;
  /** 외부 호출 기록(external_call). 운영에서는 firestoreEventSink. */
  events: EventSink;
  /** 테스트용. 없으면 전역 fetch. */
  fetch?: typeof fetch;
  now?: Date;
}

export interface WriteResult {
  /** ytExports 문서 ID. */
  exportId: string;
  youtubePlaylistId: string;
  /** 실제로 들어간 곡 수. */
  added: number;
  /** 넣지 못한 영상 ID. */
  failed: string[];
}

export class InvalidWriteInputError extends Error {
  override name = 'InvalidWriteInputError';
}

/** ytExports에 없거나 다른 사용자 소유. 존재 여부를 드러내지 않게 둘을 구분하지 않는다. */
export class NotOwnedPlaylistError extends Error {
  override name = 'NotOwnedPlaylistError';
  constructor() {
    super('이 앱이 이 사용자를 위해 만든 재생목록이 아닙니다.');
  }
}

export class PlaylistFullError extends Error {
  override name = 'PlaylistFullError';
  constructor(
    readonly current: number,
    readonly requested: number,
  ) {
    super(
      `재생목록에는 최대 ${MAX_EXPORT_ITEMS}곡까지 넣습니다 (현재 ${current}, 요청 ${requested}).`,
    );
  }
}

/** YouTube가 오류로 응답했거나 연결에 실패했다. 메시지에 토큰·제목을 넣지 않는다. */
export class YouTubeWriteError extends Error {
  override name = 'YouTubeWriteError';
  constructor(
    readonly status: number | null,
    readonly reason: string | null,
  ) {
    super(`YouTube 쓰기 실패: status=${status ?? 'network'} reason=${reason ?? 'unknown'}`);
  }
}
