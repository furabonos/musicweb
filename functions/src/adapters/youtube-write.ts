import { FieldValue } from 'firebase-admin/firestore';
import { reserve, settle, type Reservation } from '../core/budget.js';
import { recordCall } from '../core/events.js';
import {
  InvalidWriteInputError,
  MAX_EXPORT_ITEMS,
  MAX_TITLE_LENGTH,
  NotOwnedPlaylistError,
  PlaylistFullError,
  YouTubeWriteError,
  YT_INSERT_UNITS,
  type WriteResult,
  type YouTubeWriteContext,
} from './youtube-write-types.js';

/**
 * 사용자 YouTube 계정에 쓰는 유일한 곳 (SPEC 6.2 "사용자의 기존 재생목록은 절대 바꾸지 않는다", T05).
 *
 * - 공개 함수는 createPlaylist, addItems 두 개뿐이다. 수정·삭제는 만들지 않는다.
 * - addItems는 ytExports에 이 사용자 소유로 기록된 재생목록에만 쓴다. 쓸 YouTube 재생목록 ID는 호출자가 아니라
 *   ytExports 문서에서 읽는다. 그래서 호출자가 사용자의 기존 재생목록 ID를 넘길 방법이 없다.
 * - 모든 호출은 budget 예약(insert 1회 = 50단위)을 먼저 거친다. YouTube는 실패한 요청에도 할당량을 쓰므로
 *   보낸 요청 수만큼 정산한다.
 * - 이 파일 밖에서 YouTube 쓰기 주소·googleapis youtube를 쓰면 lint가 막는다(eslint.config.js).
 */

const API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_TIMEOUT_MS = 15_000;

/** 이 앱 이름으로 새 비공개 재생목록을 만들고 곡을 넣은 뒤 ytExports에 기록한다. */
export async function createPlaylist(
  ctx: YouTubeWriteContext,
  uid: string,
  title: string,
  items: string[],
): Promise<WriteResult> {
  validateUid(uid);
  const cleanTitle = validateTitle(title);
  validateItems(items);

  const reservation = await reserve(ctx.db, {
    service: { ytUnits: YT_INSERT_UNITS * (1 + items.length), exports: 1 },
    user: { uid, counters: { exports: 1 } },
    feature: 'create',
    ...(ctx.now ? { now: ctx.now } : {}),
  });

  let spent = 0;
  let created = false;
  try {
    const token = await ctx.getAccessToken(uid);
    spent += YT_INSERT_UNITS;
    const body = await insert(ctx, uid, token, 'playlists', 'snippet,status', {
      snippet: { title: cleanTitle },
      status: { privacyStatus: 'private' },
    });
    const youtubePlaylistId = typeof body.id === 'string' ? body.id : '';
    if (!youtubePlaylistId) throw new YouTubeWriteError(200, 'missingId');
    created = true;

    // 곡을 넣기 전에 먼저 기록한다: 중간에 실패해도 "이 앱이 만든 재생목록"으로 남아 addItems로 이어 넣을 수 있다.
    // 곡 수 자리는 처음부터 다 잡고 실패한 만큼만 돌려준다: 중간에 함수가 죽어도 30곡을 넘기지 않는 쪽으로 남는다.
    const exportRef = ctx.db.collection('ytExports').doc();
    await exportRef.set({
      ownerUid: uid,
      youtubePlaylistId,
      itemCount: items.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    const { added, failed, attempts } = await insertItems(
      ctx,
      uid,
      token,
      youtubePlaylistId,
      items,
    );
    spent += attempts * YT_INSERT_UNITS;
    await releaseSlotsQuietly(exportRef, items.length - added);
    return { exportId: exportRef.id, youtubePlaylistId, added, failed };
  } finally {
    const exports = created ? 1 : 0;
    await settleQuietly(ctx, reservation, {
      service: { ytUnits: spent, exports },
      user: { exports },
    });
  }
}

/** 이 앱이 이 사용자를 위해 만든 재생목록(ytExports)에만 곡을 더 넣는다. */
export async function addItems(
  ctx: YouTubeWriteContext,
  uid: string,
  ytExportId: string,
  items: string[],
): Promise<WriteResult> {
  validateUid(uid);
  if (!ytExportId || ytExportId.includes('/') || ytExportId.length > 128) {
    throw new InvalidWriteInputError('ytExportId 형식이 잘못됐습니다.');
  }
  validateItems(items);

  // 소유 확인과 곡 수 자리 잡기를 한 트랜잭션에서 한다(동시에 넣어도 30곡을 넘지 않게).
  const exportRef = ctx.db.doc(`ytExports/${ytExportId}`);
  const youtubePlaylistId = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(exportRef);
    const playlistId: unknown = snap.get('youtubePlaylistId');
    if (
      !snap.exists ||
      snap.get('ownerUid') !== uid ||
      typeof playlistId !== 'string' ||
      !playlistId
    ) {
      throw new NotOwnedPlaylistError();
    }
    const current: unknown = snap.get('itemCount') ?? 0;
    // 숫자가 아니면 막는 쪽으로 실패한다(budget.ts와 같은 관례).
    if (typeof current !== 'number' || !Number.isInteger(current) || current < 0) {
      throw new NotOwnedPlaylistError();
    }
    if (current + items.length > MAX_EXPORT_ITEMS)
      throw new PlaylistFullError(current, items.length);
    tx.update(exportRef, { itemCount: FieldValue.increment(items.length) });
    return playlistId;
  });

  let added = 0;
  let reservation: Reservation | undefined;
  let spent = 0;
  try {
    reservation = await reserve(ctx.db, {
      service: { ytUnits: YT_INSERT_UNITS * items.length },
      feature: 'create',
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    const token = await ctx.getAccessToken(uid);
    const result = await insertItems(ctx, uid, token, youtubePlaylistId, items);
    added = result.added;
    spent = result.attempts * YT_INSERT_UNITS;
    return { exportId: ytExportId, youtubePlaylistId, added, failed: result.failed };
  } finally {
    // 정산을 먼저 한다. 자리 돌려주기가 실패해도 정산·결과가 날아가지 않게 둘 다 오류를 삼키고 기록만 남긴다.
    if (reservation) await settleQuietly(ctx, reservation, { service: { ytUnits: spent } });
    await releaseSlotsQuietly(exportRef, items.length - added);
  }
}

// ---- 내부 함수 (내보내지 않음) ----

async function insertItems(
  ctx: YouTubeWriteContext,
  uid: string,
  token: string,
  playlistId: string,
  items: string[],
): Promise<{ added: number; failed: string[]; attempts: number }> {
  let added = 0;
  let attempts = 0;
  const failed: string[] = [];
  // 순서를 지키려고 한 곡씩 넣는다.
  for (const [i, videoId] of items.entries()) {
    attempts++;
    try {
      await insert(ctx, uid, token, 'playlistItems', 'snippet', {
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      });
      added++;
    } catch (err) {
      failed.push(videoId);
      // 영상 하나의 문제(없음·비공개)는 건너뛰고, 재생목록·권한·할당량·서버 문제면 남은 곡도 실패로 두고 멈춘다.
      if (!(err instanceof YouTubeWriteError) || isFatal(err)) {
        failed.push(...items.slice(i + 1));
        break;
      }
    }
  }
  return { added, failed, attempts };
}

// 재생목록 단위 오류: 남은 곡을 보내도 모두 실패하므로 할당량만 버린다.
const PLAYLIST_LEVEL_REASONS = new Set([
  'playlistNotFound',
  'playlistContainsMaximumNumberOfVideos',
  'playlistOperationUnsupported',
]);

function isFatal(err: YouTubeWriteError): boolean {
  const { status, reason } = err;
  if (reason && PLAYLIST_LEVEL_REASONS.has(reason)) return true;
  return status === null || status === 401 || status === 403 || status === 429 || status >= 500;
}

/** 잡아 둔 곡 수 자리를 돌려준다. 실패하면 자리가 남는 쪽(막는 쪽)이므로 기록만 남긴다. */
async function releaseSlotsQuietly(ref: FirebaseFirestore.DocumentReference, count: number) {
  if (count <= 0) return;
  try {
    await ref.update({ itemCount: FieldValue.increment(-count) });
  } catch (err) {
    console.error('youtube-write: 곡 수 자리 돌려주기 실패, 자리가 남습니다', {
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** 한 번의 insert. 결과와 관계없이 external_call 이벤트를 남긴다(실패한 요청도 50단위). */
async function insert(
  ctx: YouTubeWriteContext,
  uid: string,
  token: string,
  resource: 'playlists' | 'playlistItems',
  part: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const doFetch = ctx.fetch ?? fetch;
  return recordCall(
    ctx.events,
    { target: 'youtube_write', op: `${resource}.insert`, actorUid: uid },
    async () => {
      let res: Response;
      try {
        res = await doFetch(`${API}/${resource}?part=${encodeURIComponent(part)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new YouTubeWriteError(null, 'network');
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new YouTubeWriteError(res.status, errorReason(json));
      return { result: json, units: YT_INSERT_UNITS, status: res.status };
    },
    (err) => ({
      units: YT_INSERT_UNITS,
      ...(err instanceof YouTubeWriteError && err.status !== null ? { status: err.status } : {}),
    }),
  );
}

function errorReason(json: Record<string, unknown>): string | null {
  const error = json.error as { errors?: { reason?: unknown }[] } | undefined;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason.slice(0, 64) : null;
}

/** 정산 실패가 원래 결과·오류를 덮지 않게 한다. 정산이 안 되면 예약한 양이 그대로 남는다(막는 쪽). */
async function settleQuietly(
  ctx: YouTubeWriteContext,
  reservation: Reservation,
  actual: Parameters<typeof settle>[2],
) {
  try {
    await settle(ctx.db, reservation, actual);
  } catch (err) {
    console.error('youtube-write: 정산 실패, 예약한 양이 그대로 남습니다', {
      reservation: reservation.id,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

function validateUid(uid: string) {
  if (!uid || uid.includes('/') || uid.length > 128) {
    throw new InvalidWriteInputError('uid 형식이 잘못됐습니다.');
  }
}

function validateTitle(title: string): string {
  const t = typeof title === 'string' ? title.trim() : '';
  // YouTube는 제목의 < > 를 거부한다.
  if (!t || t.length > MAX_TITLE_LENGTH || /[<>]/.test(t)) {
    throw new InvalidWriteInputError(`제목은 1~${MAX_TITLE_LENGTH}자이고 < > 를 쓸 수 없습니다.`);
  }
  return t;
}

function validateItems(items: string[]) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EXPORT_ITEMS) {
    throw new InvalidWriteInputError(`곡은 1~${MAX_EXPORT_ITEMS}개여야 합니다.`);
  }
  for (const id of items) {
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) {
      throw new InvalidWriteInputError('영상 ID 형식이 잘못됐습니다.');
    }
  }
}
