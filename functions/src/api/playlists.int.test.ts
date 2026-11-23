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
    // 기본은 미리 계산한 방식(AI 없이 고르기, D-040): 출처 문장. AI가 고르는 이유는 recommendMode ai에서
    expect(out.items[0]?.reason).toBe('People who play Doja also play this.');

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

  it('화면 언어가 한국어면 곡 이유도 한국어', async () => {
    const { token } = await googleSignIn(ADMIN);
    const out = await createOk(token, REQUEST, 'ko');
    expect(out.items[0]?.reason).toBe('「Doja」 청취자들이 함께 듣는 곡이에요.');
  });

  it('recommendMode ai면 AI가 화면 언어로 이유를 쓴다', async () => {
    await db.doc('config/runtime').set({ recommendMode: 'ai' }, { merge: true });
    const { token } = await googleSignIn(ADMIN);
    expect((await createOk(token, REQUEST, 'en')).items[0]?.reason).toBe(FAKE_REASON.en('Doja'));
    expect((await createOk(token, REQUEST, 'ko')).items[0]?.reason).toBe(FAKE_REASON.ko('Doja'));
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

describe('playlists-get / site-config (T16)', () => {
  it('저장 전에는 소유자만, 저장 뒤에는 로그인 없이 열림. 영상은 지금 곡 목록에서, 검색 문장은 없음', async () => {
    const a = await googleSignIn(ADMIN);
    const b = await googleSignIn('other@example.com');
    const { id } = await createOk(a.token);

    expect((await callFunction('playlists-get', { id })).error?.status).toBe('NOT_FOUND');
    expect((await callFunction('playlists-get', { id }, b.token)).error?.status).toBe('NOT_FOUND');
    const own = (await callFunction('playlists-get', { id }, a.token)).result as {
      state: string;
      items: Item[];
    };
    expect(own.state).toBe('draft');

    await callFunction('playlists-save', { id }, a.token);
    const r = await callFunction('playlists-get', { id });
    expect(r.error).toBeUndefined();
    const shared = r.result as {
      state: string;
      seed: { title: string };
      items: Item[];
      openLink: string;
    };
    expect(shared).toMatchObject({ state: 'saved', seed: { title: 'Doja' }, openLink: 'direct' });
    expect(shared.items).toHaveLength(10);
    expect(shared.items.every((i) => i.videoId?.startsWith('demoVid'))).toBe(true);
    expect(JSON.stringify(r.result)).not.toContain(REQUEST);
  });

  it('곡 목록에서 연결이 사라진 곡은 videoId null', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id, items } = await createOk(token);
    await callFunction('playlists-save', { id }, token);
    const gone = DEMO_SONGS.find((s) => s.mbid === items[0]?.songId);
    await db.doc(`songs/${gone?.mbid}/links/${gone?.videoId}`).update({ status: 'gone' });
    const shared = (await callFunction('playlists-get', { id })).result as { items: Item[] };
    expect(shared.items[0]?.videoId).toBeNull();
  });

  it('없는 재생목록·잘못된 id는 거부', async () => {
    expect((await callFunction('playlists-get', { id: 'nope' })).error?.status).toBe('NOT_FOUND');
    expect((await callFunction('playlists-get', { id: '../x' })).error?.status).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('site-config는 로그인 없이 "YouTube에서 열기" 방식을 알려 줌', async () => {
    expect((await callFunction('site-config', {})).result).toEqual({
      openLink: 'direct',
      savingMode: false,
      noAi: false,
    });
    await db.doc('config/runtime').set({ youtubeOpenLink: 'fallback' });
    expect((await callFunction('site-config', {})).result).toEqual({
      openLink: 'fallback',
      savingMode: false,
      noAi: false,
    });
  });

  it('설정 문서가 깨져도 공유 화면은 열리고 곡별 링크(fallback)로 답함', async () => {
    const { token } = await googleSignIn(ADMIN);
    const { id } = await createOk(token);
    await callFunction('playlists-save', { id }, token);
    await db.doc('config/runtime').set({ unknownField: 1 });
    const r = await callFunction('playlists-get', { id });
    expect(r.error).toBeUndefined();
    expect((r.result as { openLink: string }).openLink).toBe('fallback');
    expect((await callFunction('site-config', {})).result).toEqual({
      openLink: 'fallback',
      savingMode: false,
      noAi: false,
    });
  });
});

describe('저장된 해석·결과 (T32, D-048)', () => {
  const parsedPaths = async () =>
    (await db.collection('events').where('type', '==', 'request_parsed').get()).docs
      .map((d) => [d.get('at')?.toMillis?.() ?? 0, d.get('attrs.path')] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, p]) => p);
  const created = async () =>
    (await db.collection('events').where('type', '==', 'playlist_created').get()).docs
      .map((d) => [d.get('at')?.toMillis?.() ?? 0, d.get('attrs.fromCache') === true] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, f]) => f);
  const usedAi = async () =>
    (await db.collection('events').where('type', '==', 'playlist_created').get()).docs
      .map((d) => [d.get('at')?.toMillis?.() ?? 0, d.get('attrs.usedAi')] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, f]) => f);

  it('규칙으로 못 읽는 같은 문장 두 번째는 저장된 해석(AI 호출 없음), 원문은 저장하지 않음', async () => {
    const { token } = await googleSignIn(ADMIN);
    const text = 'please find me something that feels like Doja';
    await createOk(token, text, 'en');
    await createOk(token, `  PLEASE find me something  that feels like doja `, 'en');
    expect(await parsedPaths()).toEqual(['ai', 'cache']);
    // 현황판 "AI 없이 처리"(T35): 첫 번째는 AI 해석, 두 번째는 저장된 해석이라 AI 없음
    expect(await usedAi()).toEqual([true, false]);
    const docs = (await db.collection('parseCache').get()).docs.map((d) => d.data());
    expect(docs).toHaveLength(1);
    expect(JSON.stringify(docs)).not.toMatch(/please|feels/i);
  });

  it('규칙으로 읽히는 문장은 처음부터 AI 없이(rule)', async () => {
    const { token } = await googleSignIn(ADMIN);
    await createOk(token, REQUEST, 'en');
    expect(await parsedPaths()).toEqual(['rule']);
    // 미리 계산한 추천(기본)이라 AI를 부르지 않았다
    expect(await usedAi()).toEqual([false]);
    // AI 추천 방식이면 후보·고르기에서 AI를 부른다
    await db.doc('config/runtime').set({ recommendMode: 'ai' }, { merge: true });
    await createOk(token, 'something like Doja by Central Cee, 12 songs', 'en');
    expect(await usedAi()).toEqual([false, true]);
  });

  it('같은 조합 두 번째 결과는 추천 계산 없이 같은 곡, 영상 ID는 저장하지 않음, 7일 지나면 다시 계산', async () => {
    const { token } = await googleSignIn(ADMIN);
    const a = await createOk(token, REQUEST, 'en');
    const b = await createOk(token, REQUEST, 'en');
    expect(b.items.map((i) => i.songId)).toEqual(a.items.map((i) => i.songId));
    expect(await created()).toEqual([false, true]);
    // 두 번째는 추천 단계 기록이 늘지 않는다(계산하지 않음)
    const steps = (await db.collection('events').where('type', '==', 'recommend_step').get()).size;
    await createOk(token, REQUEST, 'en');
    expect((await db.collection('events').where('type', '==', 'recommend_step').get()).size).toBe(
      steps,
    );

    const cache = (await db.collection('resultCache').get()).docs;
    expect(cache).toHaveLength(1);
    expect(JSON.stringify(cache[0]?.data())).not.toMatch(/videoId|demoVid|ytTitle/);

    // 7일 지난 결과는 쓰지 않는다
    await cache[0]?.ref.update({ expiresAt: new Date(Date.now() - 1000) });
    await createOk(token, REQUEST, 'en');
    expect(await created()).toEqual([false, true, true, false]);
  });

  it('절약 모드에서도 AI가 전에 읽은 문장은 저장된 해석으로 성공한다', async () => {
    const { token } = await googleSignIn(ADMIN);
    const text = 'please find me something that feels like Doja';
    await createOk(token, text, 'en');
    const { enterSavingMode } = await import('../core/savingMode.js');
    const { memoryEvents } = await import('../testing/music.js');
    await enterSavingMode(db, memoryEvents().sink, new Date());
    const again = await createOk(token, text, 'en');
    expect(again.items.length).toBeGreaterThan(0);
    expect((await parsedPaths()).at(-1)).toBe('cache');
  });
});

describe('곡 고르기로 만들기 (T33)', () => {
  it('곡 ID·곡 수·조건으로 만들면 해석 단계가 없다(AI·규칙 해석 0건), 없는 곡 ID는 거부', async () => {
    // AI 비용 상한 0: AI를 한 번이라도 부르면 상한에 닿아 절약 모드가 켜진다 → 안 켜졌으면 AI 호출 0건
    await db.doc('config/runtime').set({ limits: { service: { aiCostMicroUsd: 0 } } });
    const { token } = await googleSignIn(ADMIN);
    const r = await callFunction(
      'playlists-create',
      {
        seedSongId: DEMO_SEED.mbid,
        count: 12,
        include: { live: true, cover: false, remix: false },
        locale: 'en',
      },
      token,
    );
    expect(r.error).toBeUndefined();
    const out = r.result as Created;
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(12);
    expect((r.result as { seed: unknown }).seed).toEqual({
      artist: DEMO_SEED.artist,
      title: DEMO_SEED.title,
    });
    const parsedEvents = await db
      .collection('events')
      .where('type', 'in', ['request_parsed', 'request_parse_failed'])
      .get();
    expect(parsedEvents.size).toBe(0);
    expect((await db.collection('parseCache').get()).size).toBe(0);
    expect((await db.doc('config/runtime').get()).get('savingMode')).toBeUndefined();

    const missing = await callFunction(
      'playlists-create',
      {
        seedSongId: 'nope',
        count: 10,
        include: { live: false, cover: false, remix: false },
        locale: 'en',
      },
      token,
    );
    expect(missing.error?.status).toBe('NOT_FOUND');
    expect(missing.error?.details).toEqual({ reason: 'seedSongNotFound' });
    const bad = await callFunction(
      'playlists-create',
      {
        seedSongId: DEMO_SEED.mbid,
        count: 40,
        include: { live: false, cover: false, remix: false },
        locale: 'en',
      },
      token,
    );
    expect(bad.error?.status).toBe('INVALID_ARGUMENT');
  });
});

describe('자세한 이유 playlists-explain (T34, D-050)', () => {
  it('곡별 이유를 돌려주고, 두 번째는 저장된 이유를 쓰며, 11번째 요청은 거부', async () => {
    const { token } = await googleSignIn(ADMIN);
    const out = await createOk(token, REQUEST, 'en');
    const first = await callFunction('playlists-explain', { id: out.id }, token);
    expect(first.error).toBeUndefined();
    const reasons = (first.result as { reasons: Record<string, string> }).reasons;
    expect(Object.keys(reasons).sort()).toEqual(out.items.map((i) => i.songId).sort());
    expect(Object.values(reasons)[0]).toMatch(/^Demo detail: /);
    expect((await db.collection('reasonCache').get()).size).toBe(out.items.length);
    for (let i = 2; i <= 10; i++) {
      expect(
        (await callFunction('playlists-explain', { id: out.id }, token)).error,
      ).toBeUndefined();
    }
    const eleventh = await callFunction('playlists-explain', { id: out.id }, token);
    expect(eleventh.error?.status).toBe('RESOURCE_EXHAUSTED');
    expect(eleventh.error?.details).toMatchObject({ reason: 'limit', counter: 'explains' });
  });

  it('절약 모드면 failed-precondition, 다른 사용자의 재생목록은 거부', async () => {
    const owner = await googleSignIn(ADMIN);
    const out = await createOk(owner.token, REQUEST, 'en');
    const other = await googleSignIn('someone@example.com');
    const denied = await callFunction('playlists-explain', { id: out.id }, other.token);
    expect(denied.error?.status).toBe('PERMISSION_DENIED');

    const { enterSavingMode } = await import('../core/savingMode.js');
    const { memoryEvents } = await import('../testing/music.js');
    await enterSavingMode(db, memoryEvents().sink, new Date());
    const saving = await callFunction('playlists-explain', { id: out.id }, owner.token);
    expect(saving.error?.status).toBe('FAILED_PRECONDITION');
    expect(saving.error?.details).toEqual({ reason: 'savingMode' });
  });

  it('거부(남의 재생목록·절약 모드)는 explains를 쓰지 않는다, AI 비용 상한에 닿으면 절약 모드로 바뀌고 거부', async () => {
    const owner = await googleSignIn(ADMIN);
    const out = await createOk(owner.token, REQUEST, 'en');
    const other = await googleSignIn('someone2@example.com');
    await callFunction('playlists-explain', { id: out.id }, other.token);
    const { pacificDay } = await import('../core/day.js');
    const day = pacificDay(new Date());
    expect((await db.doc(`users/${other.uid}/usage/${day}`).get()).get('explains')).toBeUndefined();

    // AI 비용 상한 0: 가짜 AI도 예약하므로 닿는다
    await db
      .doc('config/runtime')
      .set({ limits: { service: { aiCostMicroUsd: 0 } } }, { merge: true });
    const limited = await callFunction('playlists-explain', { id: out.id }, owner.token);
    expect(limited.error?.status).toBe('FAILED_PRECONDITION');
    expect(limited.error?.details).toEqual({ reason: 'savingMode' });
    expect((await db.doc('config/runtime').get()).get('savingMode.active')).toBe(true);
    expect((await db.collection('reasonCache').get()).size).toBe(0);

    // 이미 절약 모드: 카운터를 쓰지 않고 거부
    const usageRef = db.doc(`users/${owner.uid}/usage/${day}`);
    const before = (await usageRef.get()).get('explains') as number;
    await callFunction('playlists-explain', { id: out.id }, owner.token);
    expect((await usageRef.get()).get('explains')).toBe(before);
  });
});
