import { DEMO_SEED, DEMO_SONGS } from '@musicweb/shared/demo';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_REASON } from '../dev/fakeWorld.js';
import { seedDemoCatalog } from '../testing/demoCatalog.js';
import {
  callFunction,
  clearAuth,
  clearFirestore,
  emulatorDb,
  googleSignIn,
  projectId,
} from '../testing/emulator.js';

// pnpm test:int: 에뮬레이터의 실제 callable을 HTTP로 부른다. 에뮬레이터는 가짜 AI·음악 데이터를 쓴다
// (tools/emulator-env.sh의 MUSICWEB_FAKE_EXTERNAL, D-031). 관리자 목록은 admin@example.com.
const db = emulatorDb();
const ADMIN = 'admin@example.com';
const REQUEST = '10 songs like Doja by Central Cee';

interface Item {
  songId: string;
  title: string;
  reason: string | null;
  videoId: string | null;
}
interface Created {
  ok: true;
  id: string;
  items: Item[];
  shortfall: unknown;
  unsupported: string[];
}

async function create(token: string, text = REQUEST, locale = 'en') {
  return callFunction('playlists-create', { text, locale }, token);
}

async function createOk(token: string, text = REQUEST, locale = 'en'): Promise<Created> {
  const r = await create(token, text, locale);
  expect(r.error).toBeUndefined();
  return r.result as Created;
}

/** 보안 규칙을 거쳐 로그인 없이 읽기(공유 주소로 여는 사람). */
async function anonymousGet(path: string) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  return fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/${path}`);
}

async function eventsOf(type: string) {
  const snap = await db.collection('events').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}

beforeEach(async () => {
  await clearFirestore();
  await clearAuth();
  await seedDemoCatalog(db);
});

describe('playlists-create (가짜 AI·음악 데이터)', () => {
  it('만들기 → 10곡, 재생목록 문서는 draft이고 영상 ID를 저장하지 않음, 검색 문장은 비공개 문서에만', async () => {
    const { token, uid } = await googleSignIn(ADMIN);
    const out = await createOk(token);
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(10);
    expect(out.shortfall).toBeNull();
    expect(out.items.every((i) => i.videoId?.startsWith('demoVid'))).toBe(true);
    expect(out.items.map((i) => i.songId)).not.toContain(DEMO_SEED.mbid);
    expect(out.items[0]?.reason).toBe(FAKE_REASON.en('Doja'));

    const doc = (await db.doc(`playlists/${out.id}`).get()).data();
    expect(doc).toMatchObject({ ownerUid: uid, state: 'draft', locale: 'en' });
    expect(doc?.items).toHaveLength(10);
    // D-028·D-031: 오래 남는 재생목록 문서에는 YouTube 데이터(영상 ID)가 없다
    expect(JSON.stringify(doc)).not.toContain('demoVid');
    expect(JSON.stringify(doc)).not.toContain(REQUEST);
    const priv = (await db.doc(`playlists/${out.id}/private/request`).get()).data();
    expect(priv?.text).toBe(REQUEST);
    expect(priv?.spares).toHaveLength(5);
    // 이벤트에는 검색 문장이 없다
    const all = (await db.collection('events').get()).docs.map((d) => JSON.stringify(d.data()));
    expect(all.join('\n')).not.toContain('Doja');
    // uid 원문·이메일도 없다(해시만, SPEC 4.1)
    expect(all.join('\n')).not.toContain(uid);
    expect(all.join('\n')).not.toContain(ADMIN);
  });

  it('화면 언어가 한국어면 곡 이유도 한국어로 요청됨', async () => {
    const { token } = await googleSignIn(ADMIN);
    const out = await createOk(token, REQUEST, 'ko');
    expect(out.items[0]?.reason).toBe(FAKE_REASON.ko('Doja'));
  });

  it('지원하지 않는 조건은 코드로 돌려줌', async () => {
    const { token } = await googleSignIn(ADMIN);
    const out = await createOk(token, 'songs like Doja from the 2010s, slow ones');
    expect(out.unsupported).toEqual(['year', 'mood']);
  });

  it('기준 곡이 없으면 ok:false(no_seed) + request_parse_failed, 재생목록 안 만듦', async () => {
    const { token } = await googleSignIn(ADMIN);
    const r = await create(token, 'something nice for tonight');
    expect(r.result).toEqual({ ok: false, reason: 'no_seed' });
    expect((await db.collection('playlists').get()).size).toBe(0);
    expect(await eventsOf('request_parse_failed')).toEqual([
      expect.objectContaining({ attrs: { reason: 'no_seed' } }),
    ]);
  });

  it('기준 곡 아티스트를 수집 대기열에 넣음(SPEC 3.3, 누가 찾았는지 없이)', async () => {
    const { token, uid } = await googleSignIn(ADMIN);
    await createOk(token);
    const q = (await db.doc(`ingestQueue/${DEMO_SEED.artistMbid}`).get()).data();
    expect(q).toMatchObject({ mbid: DEMO_SEED.artistMbid, name: DEMO_SEED.artist });
    expect(JSON.stringify(q)).not.toContain(uid);
  });

  it('빈 문장·200자 초과는 AI를 부르지 않고 하루 횟수도 쓰지 않음', async () => {
    await db.doc('config/runtime').set({ limits: { user: { playlists: 1 } } });
    const { token } = await googleSignIn(ADMIN);
    expect((await create(token, '   ')).result).toEqual({ ok: false, reason: 'empty' });
    expect((await create(token, '🎵'.repeat(201))).result).toEqual({
      ok: false,
      reason: 'too_long',
    });
    // 한도 1회가 그대로 남아 있어 만들기가 된다
    await createOk(token);
  });

  it('로그인 안 함 → unauthenticated, 관리자 아님 → permission-denied (D-015)', async () => {
    expect((await create('')).error?.status).toBe('UNAUTHENTICATED');
    const { token } = await googleSignIn('someone@example.com');
    const r = await create(token);
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    expect((await db.collection('playlists').get()).size).toBe(0);
  });

  it('긴급 정지면 AI를 부르기 전에 거부 + kill_switch_blocked', async () => {
    await db.doc('config/runtime').set({ killSwitches: { create: false } });
    const { token } = await googleSignIn(ADMIN);
    const r = await create(token);
    expect(r.error).toMatchObject({ status: 'UNAVAILABLE', details: { reason: 'killSwitch' } });
    expect(await eventsOf('request_parsed')).toHaveLength(0);
    expect(await eventsOf('kill_switch_blocked')).toHaveLength(1);
  });

  it('사용자 하루 한도에 닿으면 AI를 부르기 전에 거부 + limit_reached', async () => {
    await db.doc('config/runtime').set({ limits: { user: { playlists: 1 } } });
    const { token } = await googleSignIn(ADMIN);
    await createOk(token);
    const r = await create(token);
    expect(r.error).toMatchObject({
      status: 'RESOURCE_EXHAUSTED',
      details: { reason: 'limit', scope: 'user', counter: 'playlists' },
    });
    expect(await eventsOf('request_parsed')).toHaveLength(1);
    expect(await eventsOf('limit_reached')).toHaveLength(1);
  });
});

describe('playlists-update / playlists-save', () => {
  it('만들기 → 저장 → 공유 문서: 저장 전에는 로그인 없이 못 읽고, 저장 뒤에는 읽힘', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id } = await createOk(token);
    expect((await anonymousGet(`playlists/${id}`)).status).toBe(403);

    const saved = await callFunction('playlists-save', { id }, token);
    expect(saved.result).toEqual({ id, state: 'saved' });
    const res = await anonymousGet(`playlists/${id}`);
    expect(res.status).toBe(200);
    // 검색 문장(비공개 문서)은 저장 뒤에도 로그인 없이 못 읽는다
    expect((await anonymousGet(`playlists/${id}/private/request`)).status).toBe(403);
  });

  it('다른 사용자가 update·save하면 거부되고 문서는 그대로', async () => {
    const a = await googleSignIn(ADMIN);
    const b = await googleSignIn('other@example.com');
    const { id } = await createOk(a.token);
    const before = (await db.doc(`playlists/${id}`).get()).data();

    for (const action of ['remove', 'replace']) {
      const r = await callFunction('playlists-update', { id, action, position: 0 }, b.token);
      expect(r.error).toMatchObject({
        status: 'PERMISSION_DENIED',
        details: { reason: 'notOwner' },
      });
    }
    const s = await callFunction('playlists-save', { id }, b.token);
    expect(s.error?.status).toBe('PERMISSION_DENIED');
    expect((await db.doc(`playlists/${id}`).get()).data()).toEqual(before);
    expect(await eventsOf('song_removed')).toHaveLength(0);
  });

  it('빼기·바꾸기가 위치만 담긴 이벤트로 남음, 바꾸기는 목록에 없던 예비 곡으로', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id, items } = await createOk(token);

    const removed = await callFunction(
      'playlists-update',
      { id, action: 'remove', position: 2 },
      token,
    );
    const afterRemove = (removed.result as { items: Item[] }).items;
    expect(afterRemove).toHaveLength(9);
    expect(afterRemove.map((i) => i.songId)).not.toContain(items[2]?.songId);

    const replaced = await callFunction(
      'playlists-update',
      { id, action: 'replace', position: 0 },
      token,
    );
    const afterReplace = (replaced.result as { items: Item[] }).items;
    expect(afterReplace).toHaveLength(9);
    const newOne = afterReplace[0];
    expect(items.map((i) => i.songId)).not.toContain(newOne?.songId);
    expect(DEMO_SONGS.map((s) => s.mbid)).toContain(newOne?.songId);
    expect(newOne?.videoId).toMatch(/^demoVid/);

    expect(await eventsOf('song_removed')).toEqual([
      expect.objectContaining({ attrs: { position: 2 }, outcome: 'ok' }),
    ]);
    expect(await eventsOf('song_replaced')).toEqual([
      expect.objectContaining({ attrs: { position: 0 }, outcome: 'ok' }),
    ]);
    const stored = (await db.doc(`playlists/${id}`).get()).data();
    expect(stored?.items).toHaveLength(9);
    expect((await db.doc(`playlists/${id}/private/request`).get()).get('spares')).toHaveLength(4);
  });

  it('마지막 1곡은 뺄 수 없음(lastSong)', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id } = await createOk(token, '5 songs like Doja by Central Cee');
    for (let i = 0; i < 4; i++) {
      const r = await callFunction(
        'playlists-update',
        { id, action: 'remove', position: 0 },
        token,
      );
      expect(r.error).toBeUndefined();
    }
    const last = await callFunction(
      'playlists-update',
      { id, action: 'remove', position: 0 },
      token,
    );
    expect(last.error).toMatchObject({
      status: 'FAILED_PRECONDITION',
      details: { reason: 'lastSong' },
    });
  });

  it('바꾸기는 이미 목록에 있거나 지금 재생할 수 없는 예비 곡을 건너뛰고, 다 쓰면 noSpare', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id, items } = await createOk(token);
    const privRef = db.doc(`playlists/${id}/private/request`);
    const spares = (await privRef.get()).get('spares') as { songId: string }[];
    expect(spares).toHaveLength(5);
    // 첫 예비 곡: 이미 목록에 있는 곡으로 바꿔 둠, 둘째: 연결을 gone으로
    const dup = { ...spares[0], songId: items[5]?.songId ?? '' };
    await privRef.update({ spares: [dup, ...spares.slice(1)] });
    const second = DEMO_SONGS.find((x) => x.mbid === spares[1]?.songId);
    await db.doc(`songs/${second?.mbid}/links/${second?.videoId}`).update({ status: 'gone' });

    const r = await callFunction('playlists-update', { id, action: 'replace', position: 0 }, token);
    expect((r.result as { items: Item[] }).items[0]?.songId).toBe(spares[2]?.songId);
    // 남은 예비 곡 2개를 다 쓰면 noSpare
    for (const pos of [1, 2]) {
      const ok = await callFunction(
        'playlists-update',
        { id, action: 'replace', position: pos },
        token,
      );
      expect(ok.error).toBeUndefined();
    }
    const none = await callFunction(
      'playlists-update',
      { id, action: 'replace', position: 3 },
      token,
    );
    expect(none.error).toMatchObject({ details: { reason: 'noSpare' } });
  });

  it('비공개 문서가 없는 재생목록의 바꾸기는 noSpare', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id } = await createOk(token);
    await db.doc(`playlists/${id}/private/request`).delete();
    const r = await callFunction('playlists-update', { id, action: 'replace', position: 0 }, token);
    expect(r.error).toMatchObject({ details: { reason: 'noSpare' } });
  });

  it('저장한 뒤에는 빼기·바꾸기 거부, 범위 밖 위치·없는 재생목록도 거부', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id } = await createOk(token);
    const bad = await callFunction(
      'playlists-update',
      { id, action: 'remove', position: 10 },
      token,
    );
    expect(bad.error).toMatchObject({ details: { reason: 'badPosition' } });
    const missing = await callFunction(
      'playlists-update',
      { id: 'nope', action: 'remove', position: 0 },
      token,
    );
    expect(missing.error?.status).toBe('NOT_FOUND');

    await callFunction('playlists-save', { id }, token);
    const r = await callFunction('playlists-update', { id, action: 'remove', position: 0 }, token);
    expect(r.error).toMatchObject({
      status: 'FAILED_PRECONDITION',
      details: { reason: 'alreadySaved' },
    });
  });
});
