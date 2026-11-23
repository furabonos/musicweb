import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Include, LinkKind, Locale } from '@musicweb/shared';
import { BudgetExceededError, consume } from './budget.js';
import { recommendableLinks } from './catalog.js';
import type { EventSink } from './events.js';
import { errName } from './jobErrors.js';
import {
  MAX_REQUEST_CHARS,
  type ParsedRequest,
  type ParseFailReason,
  type ParseResult,
  type SeedFailReason,
} from './parseRequest.js';
import type { RecommendResult } from './recommend.js';
import { KillSwitchError, type ServiceCounter, type UserCounter } from './runtimeConfig.js';

/**
 * 재생목록 만들기·빼기·바꾸기·저장 (SPEC 1.3, 4.3, 5, T14, D-031).
 *
 * - 만들기: 긴급 정지·사용자 하루 한도를 **AI를 부르기 전에** 확인한다(D-029: 사용자별 AI 한도가 따로 없음).
 *   요청 해석 → 추천(요청 수 + 바꾸기용 예비 SPARES곡) → draft 문서와 비공개 문서(검색 문장·해석 결과·예비 곡).
 * - 재생목록 문서에는 영상 ID를 저장하지 않는다(D-028·D-031: 공유 재생목록은 오래 남음).
 *   곡 ID만 두고, 돌려줄 때마다 곡 목록에서 지금 재생할 수 있는 연결을 고른다(resolveItems).
 * - 빼기·바꾸기·저장은 소유자만, draft일 때만. 빼기·바꾸기는 위치만 이벤트로 남긴다(곡 이름·검색 문장 없음).
 */

export const SPARES = 5;

export interface PlaylistItem {
  songId: string;
  artist: string;
  title: string;
  /** AI가 화면 언어로 쓴 한 줄 이유. 화면은 글자로만 그린다(HTML 아님). */
  reason: string | null;
}

/** 화면에 돌려주는 곡: 지금 재생할 영상(없으면 null). */
export interface PlayableItem extends PlaylistItem {
  videoId: string | null;
  kind: LinkKind | null;
}

export type CreateOutcome =
  | {
      ok: true;
      id: string;
      seed: { artist: string; title: string };
      items: PlayableItem[];
      shortfall: { requested: number; got: number } | null;
      unsupported: ParsedRequest['unsupported'];
      locale: Locale;
    }
  | { ok: false; reason: ParseFailReason | SeedFailReason };

export type PlaylistErrorReason =
  'notFound' | 'notOwner' | 'alreadySaved' | 'badPosition' | 'lastSong' | 'noSpare' | 'blocked';

/** 관리자가 차단한 계정은 재생목록을 만들거나 바꾸거나 저장하지 못한다 (T22, D-043) */
export async function assertNotBlocked(db: Firestore, uid: string): Promise<void> {
  if ((await db.doc(`users/${uid}`).get()).get('blocked') === true) {
    throw new PlaylistError('blocked');
  }
}

/** 재생목록 조작 거부. api 계층이 callable 오류 코드로 바꾼다. */
export class PlaylistError extends Error {
  override name = 'PlaylistError';
  constructor(readonly reason: PlaylistErrorReason) {
    super(`playlist: ${reason}`);
  }
}

export interface CreateDeps {
  db: Firestore;
  events: EventSink;
  parse(text: string, locale: Locale): Promise<ParseResult>;
  /** spares: 요청 수 밖의 예비 곡 수. 조회·검색은 요청 수까지만 한다(recommend opts). */
  recommend(req: ParsedRequest, spares: number): Promise<RecommendResult>;
  /** 기준 곡 아티스트를 수집 대기열에 (SPEC 3.3). 실패해도 만들기는 계속한다. */
  enqueueArtist(artist: { mbid: string; name: string }): Promise<unknown>;
  now?: () => Date;
}

export async function createPlaylist(
  deps: CreateDeps,
  uid: string,
  input: { text: string; locale: Locale },
): Promise<CreateOutcome> {
  const { db, events } = deps;
  const now = (deps.now ?? (() => new Date()))();

  // 0. 빈 문장·200자 초과는 AI를 부르지 않고 거부되므로 한도에서 빼지 않는다(해석이 이벤트를 남긴다).
  const chars = [...input.text.trim()].length;
  if (chars === 0 || chars > MAX_REQUEST_CHARS) {
    const r = await deps.parse(input.text, input.locale);
    if (!r.ok) return { ok: false, reason: r.reason };
  }

  // 0-1. 관리자가 차단한 계정은 만들 수 없다(SPEC 4.11, T22). 한도도 쓰지 않는다
  await assertNotBlocked(db, uid);

  // 1. 한도·긴급 정지 먼저 (AI 호출 전). AI가 해석에 실패해도 1회로 센다(AI 비용은 이미 썼으므로).
  try {
    await consume(db, { user: { uid, counters: { playlists: 1 } }, feature: 'create', now });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await events.record({
        type: 'limit_reached',
        attrs: { scope: err.scope, counter: err.counter as UserCounter | ServiceCounter },
        outcome: 'rejected',
        actorUid: uid,
      });
    } else if (err instanceof KillSwitchError) {
      await events.record({
        type: 'kill_switch_blocked',
        attrs: { feature: err.feature },
        outcome: 'rejected',
        actorUid: uid,
      });
    }
    throw err;
  }

  // 2. 요청 해석
  const parsed = await deps.parse(input.text, input.locale);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const req = parsed.value;

  // 3. 추천: 바꾸기용 예비 곡까지 한 번에
  const rec = await deps.recommend(req, SPARES);
  if (!rec.ok) return { ok: false, reason: rec.reason };
  const toItem = (i: (typeof rec.items)[number]): PlaylistItem => ({
    songId: i.songId,
    artist: i.artist,
    title: i.title,
    reason: i.reason,
  });
  const chosen = rec.items.slice(0, req.count);
  const spares = rec.items.slice(req.count);

  if (rec.seed.artistMbid) {
    try {
      await deps.enqueueArtist({ mbid: rec.seed.artistMbid, name: rec.seed.artist });
    } catch (err) {
      await events.record({
        type: 'error',
        attrs: { code: errName(err), where: 'playlists.enqueue_artist' },
        outcome: 'error',
      });
    }
  }

  // 4. 저장 (draft)
  const ref = db.collection('playlists').doc();
  const batch = db.batch();
  batch.create(ref, {
    ownerUid: uid,
    title: `${rec.seed.title} — ${rec.seed.artist}`,
    seed: { songId: rec.seed.songId, artist: rec.seed.artist, title: rec.seed.title },
    items: chosen.map(toItem),
    include: req.include,
    locale: req.locale,
    state: 'draft',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(ref.collection('private').doc('request'), {
    text: input.text,
    parsed: req,
    spares: spares.map(toItem),
  });
  await batch.commit();
  await events.record({
    type: 'playlist_created',
    attrs: { songs: chosen.length },
    outcome: 'ok',
    actorUid: uid,
  });

  return {
    ok: true,
    id: ref.id,
    seed: { artist: rec.seed.artist, title: rec.seed.title },
    items: chosen.map((i) => ({ ...toItem(i), videoId: i.videoId, kind: i.kind })),
    shortfall: chosen.length < req.count ? { requested: req.count, got: chosen.length } : null,
    unsupported: req.unsupported,
    locale: req.locale,
  };
}

/** 곡마다 지금 재생할 수 있는 영상을 곡 목록에서 고른다(25일 안 확인된 active 연결, 요청 조건의 종류). */
export async function resolveItems(
  db: Firestore,
  items: PlaylistItem[],
  include: Include,
  now: Date,
): Promise<PlayableItem[]> {
  const links = await recommendableLinks(
    db,
    items.map((i) => i.songId),
    now,
    include,
  );
  return items.map((i) => {
    const link = links.get(i.songId);
    return { ...i, videoId: link?.videoId ?? null, kind: link?.kind ?? null };
  });
}

interface StoredPlaylist {
  ownerUid: string;
  state: 'draft' | 'saved';
  items: PlaylistItem[];
  include: Include;
}

const NO_INCLUDE: Include = { live: false, cover: false, remix: false };

function readPlaylist(snap: FirebaseFirestore.DocumentSnapshot, uid: string): StoredPlaylist {
  if (!snap.exists) throw new PlaylistError('notFound');
  const d = snap.data() as Partial<StoredPlaylist>;
  if (d.ownerUid !== uid) throw new PlaylistError('notOwner');
  return {
    ownerUid: d.ownerUid,
    state: d.state === 'saved' ? 'saved' : 'draft',
    items: Array.isArray(d.items) ? d.items : [],
    include: d.include ?? NO_INCLUDE,
  };
}

export interface UpdateDeps {
  db: Firestore;
  events: EventSink;
  now?: () => Date;
}

export type UpdateInput = { id: string; action: 'remove' | 'replace'; position: number };

/** 빼기·바꾸기. 소유자만, draft일 때만. 바꾸기는 예비 곡 중 지금 재생할 수 있는 첫 곡으로. */
export async function updatePlaylist(
  deps: UpdateDeps,
  uid: string,
  input: UpdateInput,
): Promise<{ items: PlayableItem[] }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  await assertNotBlocked(db, uid);
  const ref = db.doc(`playlists/${input.id}`);
  const privRef = ref.collection('private').doc('request');

  // 바꾸기: 예비 곡 중 지금 재생할 수 있는 곡을 트랜잭션 전에 한 번에 확인한다(트랜잭션이 문서를 잡는 시간을 줄임).
  // 소유자 확인은 여기서 먼저 하고, 트랜잭션 안에서 다시 한다.
  let playable = new Set<string>();
  if (input.action === 'replace') {
    const [snap, priv] = await Promise.all([ref.get(), privRef.get()]);
    const p = readPlaylist(snap, uid);
    const spares = (priv.get('spares') as PlaylistItem[] | undefined) ?? [];
    const links = await recommendableLinks(
      db,
      spares.map((x) => x.songId),
      now,
      p.include,
    );
    playable = new Set(links.keys());
  }

  const result = await db.runTransaction(async (tx) => {
    const p = readPlaylist(await tx.get(ref), uid);
    if (p.state !== 'draft') throw new PlaylistError('alreadySaved');
    if (input.position < 0 || input.position >= p.items.length)
      throw new PlaylistError('badPosition');
    const items = [...p.items];

    if (input.action === 'remove') {
      if (items.length <= 1) throw new PlaylistError('lastSong');
      items.splice(input.position, 1);
      tx.update(ref, { items, updatedAt: FieldValue.serverTimestamp() });
      return { items, include: p.include };
    }

    const priv = await tx.get(privRef);
    const spares = [...((priv.get('spares') as PlaylistItem[] | undefined) ?? [])];
    const inList = new Set(items.map((i) => i.songId));
    let next: PlaylistItem | undefined;
    // 이미 목록에 있거나 지금 재생할 수 없는 예비 곡은 건너뛰며 버린다
    while (spares.length && !next) {
      const s = spares.shift() as PlaylistItem;
      if (!inList.has(s.songId) && playable.has(s.songId)) next = s;
    }
    if (!next) throw new PlaylistError('noSpare');
    items[input.position] = next;
    tx.update(ref, { items, updatedAt: FieldValue.serverTimestamp() });
    tx.update(privRef, { spares });
    return { items, include: p.include };
  });

  await deps.events.record({
    type: input.action === 'remove' ? 'song_removed' : 'song_replaced',
    attrs: { position: input.position },
    outcome: 'ok',
    actorUid: uid,
  });
  return { items: await resolveItems(db, result.items, result.include, now) };
}

/** 저장: 공유 주소(/p/{id})로 누구나 볼 수 있게 된다(보안 규칙: state == 'saved'). 이미 저장됐으면 그대로. */
export async function savePlaylist(
  deps: { db: Firestore },
  uid: string,
  input: { id: string },
): Promise<{ id: string; state: 'saved' }> {
  await assertNotBlocked(deps.db, uid);
  const ref = deps.db.doc(`playlists/${input.id}`);
  await deps.db.runTransaction(async (tx) => {
    const p = readPlaylist(await tx.get(ref), uid);
    if (p.state === 'saved') return;
    tx.update(ref, {
      state: 'saved',
      savedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { id: input.id, state: 'saved' };
}

export interface SharedPlaylist {
  id: string;
  title: string;
  seed: { artist: string; title: string };
  items: PlayableItem[];
  locale: Locale;
  state: 'draft' | 'saved';
}

/**
 * 재생목록 열기 (T16, `/p/:id`). 저장된 것은 누구나, draft는 소유자만(보안 규칙과 같은 기준).
 * 없거나 볼 수 없으면 똑같이 notFound(남의 draft가 있는지 드러내지 않음).
 * 검색 문장(비공개 문서)은 돌려주지 않는다. 영상은 지금 곡 목록에서 고른다(D-031).
 */
export async function getPlaylist(
  db: Firestore,
  uid: string | null,
  id: string,
  now = new Date(),
): Promise<SharedPlaylist> {
  const snap = await db.doc(`playlists/${id}`).get();
  const d = snap.data() as
    | (Partial<StoredPlaylist> & {
        title?: string;
        seed?: { artist?: string; title?: string };
        locale?: Locale;
      })
    | undefined;
  if (!d || (d.state !== 'saved' && (!uid || d.ownerUid !== uid)))
    throw new PlaylistError('notFound');
  const items = Array.isArray(d.items) ? d.items : [];
  return {
    id,
    title: typeof d.title === 'string' ? d.title : '',
    seed: { artist: d.seed?.artist ?? '', title: d.seed?.title ?? '' },
    items: await resolveItems(db, items, d.include ?? NO_INCLUDE, now),
    locale: d.locale === 'ko' ? 'ko' : 'en',
    state: d.state === 'saved' ? 'saved' : 'draft',
  };
}
