import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '../core/budget.js';
import { pacificDay } from '../core/day.js';
import { buildEvent, type EventInput, type EventRecord } from '../core/events.js';
import { KillSwitchError } from '../core/runtimeConfig.js';
import { addItems, createPlaylist } from './youtube-write.js';
import {
  MAX_EXPORT_ITEMS,
  NotOwnedPlaylistError,
  PlaylistFullError,
  YouTubeWriteError,
} from './youtube-write-types.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const now = new Date('2026-11-21T20:00:00Z');
const day = pacificDay(now);
const TOKEN = 'ya29.fake-token-for-test';
const HASH_KEY = 'test-actor-hash-key-0123456789abcdef';
const V: [string, string, string] = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'ccccccccc_3'];

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST가 없습니다. pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  expect(res.ok).toBe(true);
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: { snippet?: { playlistId?: string; title?: string; resourceId?: { videoId?: string } } };
  status?: { privacyStatus?: string };
}

type Fail = number | { status: number; reason: string } | 'network';

/** 가짜 YouTube. failVideo에 있는 영상은 주어진 상태 코드(또는 연결 실패)로 실패한다. */
function fakeYouTube(
  opts: {
    playlistStatus?: number;
    failVideo?: Record<string, Fail>;
    onItem?: (videoId: string) => Promise<void>;
    /** 기록기가 항상 실패하는 경우(키 오류 등) */
    brokenEvents?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body,
      status: body.status,
    });
    if (url.includes('/youtube/v3/playlists?')) {
      const status = opts.playlistStatus ?? 200;
      return status === 200
        ? Response.json({ id: 'PLnew123' })
        : Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status });
    }
    const videoId = body.snippet?.resourceId?.videoId as string;
    await opts.onItem?.(videoId);
    const fail = opts.failVideo?.[videoId];
    if (fail === 'network') throw new TypeError('fetch failed');
    if (fail === undefined) return Response.json({ id: `item-${videoId}` });
    const { status, reason } =
      typeof fail === 'number' ? { status: fail, reason: 'videoNotFound' } : fail;
    return Response.json({ error: { errors: [{ reason }] } }, { status });
  });
  const events: EventRecord[] = [];
  const ctx = {
    db,
    // 실제 기록기와 같은 검사(buildEvent)를 거쳐 메모리에 쌓는다
    events: {
      record: async (e: EventInput) => {
        if (opts.brokenEvents) throw new Error('기록 실패');
        events.push(buildEvent(e, HASH_KEY));
      },
    },
    fetch: fetchFn as unknown as typeof fetch,
    getAccessToken: vi.fn(async () => TOKEN),
    now,
  };
  return { ctx, calls, events };
}

const counter = async (path: string, field: string) =>
  ((await db.doc(path).get()).get(field) as number | undefined) ?? 0;

async function seedExport(id: string, ownerUid: string, itemCount = 0) {
  await db.doc(`ytExports/${id}`).set({ ownerUid, youtubePlaylistId: `PL-${id}`, itemCount });
}

beforeEach(clearFirestore);

describe('addItems: 이 앱이 만든 내 재생목록에만 쓴다', () => {
  it('ytExports에 없는 ID면 거부되고 HTTP 호출이 0건, 할당량도 안 쓴다', async () => {
    const { ctx, calls } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'PLusersOwnList', [V[0]])).rejects.toBeInstanceOf(
      NotOwnedPlaylistError,
    );
    expect(calls).toHaveLength(0);
    expect(ctx.getAccessToken).not.toHaveBeenCalled();
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(0);
  });

  it('다른 사용자 소유 ID면 거부되고 HTTP 호출이 0건', async () => {
    await seedExport('eb', 'bob');
    const { ctx, calls } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'eb', [V[0]])).rejects.toBeInstanceOf(
      NotOwnedPlaylistError,
    );
    expect(calls).toHaveLength(0);
    expect(await counter('ytExports/eb', 'itemCount')).toBe(0);
  });

  it('YouTube 재생목록 ID는 호출자가 아니라 ytExports 기록에서 읽는다', async () => {
    await seedExport('ea', 'alice');
    const { ctx, calls } = fakeYouTube();
    const r = await addItems(ctx, 'alice', 'ea', [V[0], V[1]]);
    expect(r).toMatchObject({ youtubePlaylistId: 'PL-ea', added: 2, failed: [] });
    expect(calls.map((c) => [c.method, c.body.snippet?.playlistId])).toEqual([
      ['POST', 'PL-ea'],
      ['POST', 'PL-ea'],
    ]);
    expect(
      calls.every((c) => c.url.startsWith('https://www.googleapis.com/youtube/v3/playlistItems?')),
    ).toBe(true);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(2);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(100);
  });

  it(`재생목록당 ${MAX_EXPORT_ITEMS}곡을 넘기면 거부되고 HTTP 호출이 0건`, async () => {
    await seedExport('ea', 'alice', MAX_EXPORT_ITEMS - 1);
    const { ctx, calls } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'ea', [V[0], V[1]])).rejects.toBeInstanceOf(
      PlaylistFullError,
    );
    expect(calls).toHaveLength(0);
  });

  it('YouTube 단위 한도를 넘으면 거부되고, 잡아 둔 곡 수 자리를 돌려준다', async () => {
    await db.doc('config/runtime').set({ limits: { service: { ytUnits: 60 } } });
    await seedExport('ea', 'alice', 3);
    const { ctx, calls } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'ea', [V[0], V[1]])).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(calls).toHaveLength(0);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(3);
  });

  it('실패한 곡은 자리를 돌려주고, 실패한 요청도 할당량으로 센다', async () => {
    await seedExport('ea', 'alice');
    const { ctx } = fakeYouTube({ failVideo: { [V[1]]: 404 } });
    const r = await addItems(ctx, 'alice', 'ea', V);
    expect(r).toMatchObject({ added: 2, failed: [V[1]] });
    expect(await counter('ytExports/ea', 'itemCount')).toBe(2);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(150);
  });

  it('긴급 정지(create=false)면 거부되고 HTTP 호출이 0건', async () => {
    await db.doc('config/runtime').set({ killSwitches: { create: false } });
    await seedExport('ea', 'alice');
    const { ctx, calls } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'ea', [V[0]])).rejects.toBeInstanceOf(KillSwitchError);
    expect(calls).toHaveLength(0);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(0);
  });
});

describe('createPlaylist: 새 재생목록을 만들고 기록한다', () => {
  it('비공개 새 재생목록을 만들고 곡을 순서대로 넣은 뒤 ytExports에 기록한다', async () => {
    const { ctx, calls } = fakeYouTube();
    const r = await createPlaylist(ctx, 'alice', '  Rainy day jazz  ', V);
    expect(r).toMatchObject({ youtubePlaylistId: 'PLnew123', added: 3, failed: [] });

    expect(calls[0]).toMatchObject({ method: 'POST', status: { privacyStatus: 'private' } });
    expect(calls[0]?.url).toMatch(/^https:\/\/www\.googleapis\.com\/youtube\/v3\/playlists\?/);
    expect(calls[0]?.body.snippet?.title).toBe('Rainy day jazz');
    expect(calls.slice(1).map((c) => c.body.snippet?.resourceId?.videoId)).toEqual(V);
    expect(calls.slice(1).every((c) => c.body.snippet?.playlistId === 'PLnew123')).toBe(true);
    expect(calls.every((c) => c.method === 'POST' && c.auth === `Bearer ${TOKEN}`)).toBe(true);

    const exp = await db.doc(`ytExports/${r.exportId}`).get();
    expect(exp.data()).toMatchObject({
      ownerUid: 'alice',
      youtubePlaylistId: 'PLnew123',
      itemCount: 3,
    });
    expect(exp.get('createdAt')).toBeDefined();
    // 50(재생목록) + 50×3(곡)
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(200);
    expect(await counter(`usage/${day}`, 'exports')).toBe(1);
    expect(await counter(`users/alice/usage/${day}`, 'exports')).toBe(1);
  });

  it('만든 재생목록에는 addItems로 이어 넣을 수 있다', async () => {
    const { ctx } = fakeYouTube();
    const r = await createPlaylist(ctx, 'alice', 'mix', [V[0]]);
    await expect(addItems(ctx, 'alice', r.exportId, [V[1]])).resolves.toMatchObject({ added: 1 });
    await expect(addItems(ctx, 'bob', r.exportId, [V[2]])).rejects.toBeInstanceOf(
      NotOwnedPlaylistError,
    );
  });

  it('사용자 하루 1개를 넘으면 거부되고 HTTP 호출이 0건', async () => {
    const first = fakeYouTube();
    await createPlaylist(first.ctx, 'alice', 'one', [V[0]]);
    const { ctx, calls } = fakeYouTube();
    const err = await createPlaylist(ctx, 'alice', 'two', [V[0]]).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ scope: 'user', counter: 'exports' });
    expect(calls).toHaveLength(0);
  });

  it('긴급 정지(create=false)면 거부되고 HTTP 호출이 0건', async () => {
    await db.doc('config/runtime').set({ killSwitches: { create: false } });
    const { ctx, calls } = fakeYouTube();
    await expect(createPlaylist(ctx, 'alice', 'x', [V[0]])).rejects.toBeInstanceOf(KillSwitchError);
    expect(calls).toHaveLength(0);
  });

  it('재생목록 만들기가 실패하면 기록이 없고, 내보내기 횟수는 돌려주고 쓴 할당량만 남는다', async () => {
    const { ctx, calls } = fakeYouTube({ playlistStatus: 403 });
    const err = await createPlaylist(ctx, 'alice', 'x', V).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeWriteError);
    expect(err).toMatchObject({ status: 403, reason: 'forbidden' });
    expect(String(err.message)).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect((await db.collection('ytExports').get()).size).toBe(0);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(50);
    expect(await counter(`usage/${day}`, 'exports')).toBe(0);
    expect(await counter(`users/alice/usage/${day}`, 'exports')).toBe(0);
  });

  it('권한 오류(401)가 나면 남은 곡은 보내지 않고 실패로 돌려준다', async () => {
    const { ctx, calls } = fakeYouTube({ failVideo: { [V[0]]: 401 } });
    const r = await createPlaylist(ctx, 'alice', 'x', V);
    expect(r).toMatchObject({ added: 0, failed: V });
    expect(calls).toHaveLength(2); // 재생목록 1 + 첫 곡 1
    expect(await counter(`ytExports/${r.exportId}`, 'itemCount')).toBe(0);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(100);
  });
});

describe('실패 경로: 정산과 자리 돌려주기', () => {
  it('createPlaylist: 토큰을 못 가져오면 HTTP 0건, 할당량·내보내기 횟수를 모두 돌려준다', async () => {
    const { ctx, calls } = fakeYouTube();
    ctx.getAccessToken.mockRejectedValueOnce(new Error('연결 만료'));
    await expect(createPlaylist(ctx, 'alice', 'x', V)).rejects.toThrow('연결 만료');
    expect(calls).toHaveLength(0);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(0);
    expect(await counter(`usage/${day}`, 'exports')).toBe(0);
    expect(await counter(`users/alice/usage/${day}`, 'exports')).toBe(0);
  });

  it('addItems: 토큰을 못 가져오면 HTTP 0건, 할당량과 곡 수 자리를 돌려준다', async () => {
    await seedExport('ea', 'alice', 4);
    const { ctx, calls } = fakeYouTube();
    ctx.getAccessToken.mockRejectedValueOnce(new Error('연결 만료'));
    await expect(addItems(ctx, 'alice', 'ea', V)).rejects.toThrow('연결 만료');
    expect(calls).toHaveLength(0);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(0);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(4);
  });

  it.each<[string, Fail]>([
    ['서버 오류(503)', 503],
    ['연결 실패', 'network'],
    ['재생목록 없음(playlistNotFound)', { status: 404, reason: 'playlistNotFound' }],
    ['권한 오류(401)', 401],
  ])('addItems: %s면 남은 곡을 보내지 않는다', async (_name, fail) => {
    await seedExport('ea', 'alice');
    const { ctx, calls } = fakeYouTube({ failVideo: { [V[0]]: fail } });
    const r = await addItems(ctx, 'alice', 'ea', V);
    expect(r).toMatchObject({ added: 0, failed: V });
    expect(calls).toHaveLength(1);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(50);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(0);
  });

  it('createPlaylist: 곡을 넣는 동안 곡 수 자리는 이미 다 잡혀 있다 (중간에 죽어도 30곡을 넘지 않는 쪽)', async () => {
    const seen: number[] = [];
    const { ctx } = fakeYouTube({
      onItem: async () => {
        const snap = await db.collection('ytExports').get();
        seen.push(snap.docs[0]?.get('itemCount') as number);
      },
      failVideo: { [V[2]]: 404 },
    });
    const r = await createPlaylist(ctx, 'alice', 'x', V);
    expect(seen).toEqual([3, 3, 3]);
    expect(await counter(`ytExports/${r.exportId}`, 'itemCount')).toBe(2);
  });

  it('addItems: 동시에 불러도 재생목록당 30곡을 넘지 않는다', async () => {
    await seedExport('ea', 'alice', MAX_EXPORT_ITEMS - 5);
    const { ctx } = fakeYouTube();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => addItems(ctx, 'alice', 'ea', V)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const full = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof PlaylistFullError,
    );
    expect(ok).toHaveLength(1);
    expect(full).toHaveLength(3);
    expect(await counter('ytExports/ea', 'itemCount')).toBe(MAX_EXPORT_ITEMS - 2);
  });

  it('addItems: 자리 돌려주기가 실패해도 결과와 정산은 그대로다', async () => {
    await seedExport('ea', 'alice');
    // 곡을 넣는 도중 정리 작업이 기록을 지운 상황
    const { ctx } = fakeYouTube({
      onItem: async (videoId) => {
        if (videoId === V[1]) await db.doc('ytExports/ea').delete();
      },
      failVideo: { [V[2]]: 404 },
    });
    const r = await addItems(ctx, 'alice', 'ea', V);
    expect(r).toMatchObject({ added: 2, failed: [V[2]] });
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(150);
    const reservations = await db.collection(`usage/${day}/reservations`).get();
    expect(reservations.docs.every((d) => d.get('settled') === true)).toBe(true);
  });
});

describe('외부 호출 기록 (T07)', () => {
  it('YouTube 요청마다 external_call 이벤트가 남고, 실패한 요청도 단위·상태와 함께 남는다', async () => {
    const { ctx, events } = fakeYouTube({ failVideo: { [V[1]]: 404 } });
    await createPlaylist(ctx, 'alice', 'x', V);
    expect(events.map((e) => [e.attrs.op, e.outcome, e.attrs.units, e.attrs.status])).toEqual([
      ['playlists.insert', 'ok', 50, 200],
      ['playlistItems.insert', 'ok', 50, 200],
      ['playlistItems.insert', 'error', 50, 404],
      ['playlistItems.insert', 'ok', 50, 200],
    ]);
    expect(
      events.every((e) => e.type === 'external_call' && e.attrs.target === 'youtube_write'),
    ).toBe(true);
    // uid 원문 대신 해시. 같은 사용자는 같은 해시
    expect(new Set(events.map((e) => e.actorHash)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain('alice');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events.every((e) => typeof e.durationMs === 'number')).toBe(true);
  });

  it('연결 실패는 상태 없이 error로 남는다', async () => {
    await seedExport('ea', 'alice');
    const { ctx, events } = fakeYouTube({ failVideo: { [V[0]]: 'network' } });
    await addItems(ctx, 'alice', 'ea', [V[0]]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'error', attrs: { units: 50 } });
    expect(events[0]?.attrs.status).toBeUndefined();
  });

  it('거부돼서 요청을 보내지 않으면 기록도 없다', async () => {
    const { ctx, events } = fakeYouTube();
    await expect(addItems(ctx, 'alice', 'missing', [V[0]])).rejects.toBeInstanceOf(
      NotOwnedPlaylistError,
    );
    expect(events).toHaveLength(0);
  });
});

describe('기록이 실패해도 YouTube 쓰기 결과는 그대로 (리뷰 반영)', () => {
  it('createPlaylist: 결과·ytExports·곡 수·정산이 기록 성공 때와 같다', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, calls } = fakeYouTube({ brokenEvents: true, failVideo: { [V[1]]: 404 } });
    const r = await createPlaylist(ctx, 'alice', 'x', V);
    expect(r).toMatchObject({ youtubePlaylistId: 'PLnew123', added: 2, failed: [V[1]] });
    expect(calls).toHaveLength(4); // 404 하나로 멈추지 않는다
    expect(await counter(`ytExports/${r.exportId}`, 'itemCount')).toBe(2);
    expect(await counter(`usage/${day}`, 'ytUnits')).toBe(200);
    expect(await counter(`users/alice/usage/${day}`, 'exports')).toBe(1);
    errSpy.mockRestore();
  });

  it('addItems: 들어간 곡이 실패로 바뀌지 않는다', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedExport('ea', 'alice');
    const { ctx } = fakeYouTube({ brokenEvents: true });
    expect(await addItems(ctx, 'alice', 'ea', V)).toMatchObject({ added: 3, failed: [] });
    expect(await counter('ytExports/ea', 'itemCount')).toBe(3);
    errSpy.mockRestore();
  });
});
