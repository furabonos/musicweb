import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMusicBrainz } from '../adapters/musicbrainz.js';
import { newRateLimiter } from '../adapters/music-http.js';
import { createWikidata } from '../adapters/wikidata.js';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { pacificDay } from '../core/day.js';
import { enqueueArtist } from '../core/ingestQueue.js';
import { countingBudget, fakeClock, memoryEvents } from '../testing/music.js';
import {
  fakeMusicWorld,
  IU,
  KARMA_MBID,
  NIGHT_LETTER_MBID,
  NO_SURPRISES_MBID,
  RADIOHEAD,
} from '../testing/youtube.js';
import { promoteQueue, runIngest } from './ingest.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const API_KEY = 'AIzaFAKEKEYFORTESTS000000000000000000';

beforeEach(() => clearAll());
async function clearAll() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    {
      method: 'DELETE',
    },
  );
  expect(res.ok).toBe(true);
}

/** 가짜 서버로 수집 작업 하나를 꾸민다. YouTube 한도는 실제 Firestore 카운터(consume)를 쓴다. */
function setup(world = fakeMusicWorld()) {
  const ev = memoryEvents();
  const clock = fakeClock();
  const music = {
    events: ev.sink,
    budget: countingBudget().budget,
    contact: 'https://github.com/furabonos/musicweb',
    fetch: world.fetch,
    now: clock.now,
  };
  const deps = {
    db,
    yt: createYouTubeRead({
      apiKey: API_KEY,
      events: ev.sink,
      budget: firestoreYtBudget(db, 'ingest'),
      fetch: world.fetch,
    }),
    mb: createMusicBrainz({ ...music, limiter: newRateLimiter(clock.sleep, clock.now) }),
    wd: createWikidata({ ...music, limiter: newRateLimiter(clock.sleep, clock.now) }),
    events: ev.sink,
  };
  return { deps, world, events: ev.events };
}

async function seedArtists() {
  await db.doc(`artists/${RADIOHEAD.mbid}`).set({
    name: RADIOHEAD.name,
    mbid: RADIOHEAD.mbid,
    status: 'active',
    channelId: null,
    uploadsPlaylistId: null,
    lastSeenPublishedAt: null,
    lastScannedAt: null,
    failCount: 0,
  });
  // IU는 사용자가 찾은 아티스트 대기열로 들어온다
  expect(await enqueueArtist(db, IU)).toBe('queued');
}

const ytUnits = async () =>
  ((await db.doc(`usage/${pacificDay(new Date())}`).get()).get('ytUnits') as number) ?? 0;
const links = async (songId: string) =>
  Object.fromEntries(
    (await db.collection(`songs/${songId}/links`).get()).docs.map((d) => [d.id, d.data()]),
  );

describe('수집 작업 (에뮬레이터, 가짜 YouTube·음악 데이터)', () => {
  it('아티스트 2명을 수집하면 곡과 연결이 생기고, 단위 사용량이 기대값과 같다', async () => {
    await seedArtists();
    const { deps, world } = setup();
    const summary = await runIngest(deps);
    expect(summary).toMatchObject({ stoppedBy: null, artists: 2, linksActive: 4, linksPending: 0 });

    // 곡 정보는 MusicBrainz에서 (YouTube 제목 아님)
    expect((await db.doc(`songs/${KARMA_MBID}`).get()).data()).toMatchObject({
      title: 'Karma Police',
      artist: 'Radiohead',
      releaseYear: 1997,
      source: 'musicbrainz',
    });
    expect((await db.doc(`songs/${NIGHT_LETTER_MBID}`).get()).get('title')).toBe('밤편지');
    // 연결: 공식 MV + 라이브(라이브 판은 따로 표시), 공식 음원
    const karma = await links(KARMA_MBID);
    expect(karma.rhKarmaMV01).toMatchObject({
      kind: 'official_mv',
      status: 'active',
      embeddable: true,
      linkedBy: 'rule',
    });
    expect(karma.rhKarmaLive).toMatchObject({ kind: 'live', status: 'active' });
    expect(karma.rhKarmaMV01?.verifiedAt).toBeDefined();
    expect((await links(NO_SURPRISES_MBID)).rhNoSurp001).toMatchObject({ kind: 'official_audio' });
    expect((await links(NIGHT_LETTER_MBID)).iuNightMV01).toMatchObject({ kind: 'official_mv' });
    // 비공개·퍼가기 불가·티저(곡 없음)는 연결하지 않는다
    for (const id of ['rhPrivate01', 'iuNoEmbed01', 'rhTeaser001']) {
      const all = await db.collectionGroup('links').get();
      expect(
        all.docs.some((d) => d.id === id),
        id,
      ).toBe(false);
    }

    // 공식 채널: Radiohead는 MusicBrainz, IU는 Wikidata에서. 대기열은 비워지고 수집 대상이 된다
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).data()).toMatchObject({
      channelId: 'UCq19-LqvG35A-30oyAiPiqA',
      uploadsPlaylistId: 'UUq19-LqvG35A-30oyAiPiqA',
      lastSeenPublishedAt: '2024-03-01T12:00:00Z',
      failCount: 0,
    });
    expect((await db.doc(`artists/${IU.mbid}`).get()).get('channelId')).toBe(
      'UC3SyT4_WLHzN7JmHQwKQZww',
    );
    // 채널 정보(YouTube 데이터)를 확인한 시각이 남는다 — 25일 재확인·30일 정리 기준(T11)
    for (const mbid of [RADIOHEAD.mbid, IU.mbid]) {
      const at = (await db.doc(`artists/${mbid}`).get()).get('ytVerifiedAt') as { toDate(): Date };
      expect(Date.now() - at.toDate().getTime()).toBeLessThan(60_000);
    }
    // 곡 문서에는 이름 찾기용 키(추천의 Last.fm·AI 후보, T13)
    expect((await db.doc(`songs/${KARMA_MBID}`).get()).get('key')).toBe('radiohead|karma police');
    expect((await db.collection('ingestQueue').get()).size).toBe(0);
    expect(world.count('query.wikidata.org')).toBe(1);

    // 단위: Radiohead 채널 1 + 업로드 2쪽 + 영상 1 = 4, IU 채널 1 + 업로드 1 + 영상 1 = 3. 검색은 0.
    expect(await ytUnits()).toBe(7);
    expect(world.count('www.googleapis.com', '/search')).toBe(0);
  });

  it('제목을 아티스트·곡으로 나누지 못하면 숫자로만 기록한다(자동 이슈 감지 재료, 제목 원문 없음)', async () => {
    await seedArtists();
    const normal = setup();
    await runIngest(normal.deps);
    expect(normal.events.filter((e) => e.type === 'title_split_failed')).toEqual([]);

    await clearAll();
    await seedArtists();
    const odd = setup(fakeMusicWorld({ unsplittableUpload: true }));
    await runIngest(odd.deps);
    const failed = odd.events.filter((e) => e.type === 'title_split_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.attrs).toEqual({});
  });

  it('두 번째 실행에서는 이미 본 영상을 다시 처리하지 않는다 (업로드 목록 1쪽씩만 확인)', async () => {
    await seedArtists();
    await runIngest(setup().deps);
    const before = await ytUnits();

    const second = setup();
    const summary = await runIngest(second.deps);
    expect(summary).toMatchObject({ videosSeen: 0, linksActive: 0 });
    expect(second.world.count('www.googleapis.com', '/videos')).toBe(0);
    expect(second.world.count('musicbrainz.org')).toBe(0);
    expect((await ytUnits()) - before).toBe(2);
  });

  it('새 업로드가 생기면 그것만 처리한다', async () => {
    await seedArtists();
    await runIngest(setup().deps);
    const third = setup(fakeMusicWorld({ extraRadioheadUpload: true }));
    const summary = await runIngest(third.deps);
    expect(summary).toMatchObject({ videosSeen: 1, linksActive: 1 });
    const videoCalls = third.world.calls.filter((c) => c.path.endsWith('/videos'));
    expect(videoCalls.map((c) => c.url.searchParams.get('id'))).toEqual(['rhLucky0001']);
    expect((await links(NO_SURPRISES_MBID)).rhLucky0001).toMatchObject({ kind: 'official_mv' });
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).get('lastSeenPublishedAt')).toBe(
      '2024-04-01T12:00:00Z',
    );
  });

  it('단위 상한에 닿으면 그 자리에서 멈추고 운영 일지에 한도 도달을 남긴다', async () => {
    await db.doc('config/runtime').set({ limits: { service: { ytUnits: 5 } } });
    await seedArtists();
    const { deps, events } = setup();
    const summary = await runIngest(deps);
    expect(summary.stoppedBy).toBe('limit');
    expect(await ytUnits()).toBe(5);
    const logs = (await db.collection('opsLog').get()).docs.map((d) => d.data());
    expect(logs.some((l) => l.kind === 'limit' && /limit reached/i.test(String(l.message)))).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'limit_reached' && e.attrs.counter === 'ytUnits')).toBe(
      true,
    );
    // 멈추기 전에 처리한 Radiohead 연결은 남아 있다
    expect(Object.keys(await links(KARMA_MBID)).length).toBeGreaterThan(0);
  });

  it('killSwitches.ingest=false면 외부 호출을 하나도 하지 않는다', async () => {
    await db.doc('config/runtime').set({ killSwitches: { ingest: false } });
    await seedArtists();
    const { deps, world, events } = setup();
    expect(await runIngest(deps)).toMatchObject({ stoppedBy: 'killSwitch', artists: 0 });
    expect(world.calls).toHaveLength(0);
    expect(await ytUnits()).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['kill_switch_blocked']);
    expect((await db.collection('ingestQueue').get()).size).toBe(1);
  });

  it('공식 채널을 못 찾는 아티스트는 연속 3번 실패하면 failed가 되고 이벤트·운영 일지가 남는다', async () => {
    const nowhere = { mbid: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d', name: 'Nobody' };
    await db.doc(`artists/${nowhere.mbid}`).set({
      ...nowhere,
      status: 'active',
      channelId: null,
      uploadsPlaylistId: null,
      lastSeenPublishedAt: null,
      lastScannedAt: null,
      failCount: 0,
    });
    for (let i = 1; i <= 3; i++) {
      const { deps, events } = setup();
      await runIngest(deps);
      expect(events.find((e) => e.type === 'artist_ingest_failed')?.attrs).toMatchObject({
        failCount: i,
      });
    }
    expect((await db.doc(`artists/${nowhere.mbid}`).get()).data()).toMatchObject({
      status: 'failed',
      failCount: 3,
    });
    const logs = (await db.collection('opsLog').get()).docs.map((d) => d.data());
    expect(logs.filter((l) => l.kind === 'job_failed')).toHaveLength(1);
    // failed가 된 뒤에는 수집 대상에서 빠진다
    const { deps, world } = setup();
    expect(await runIngest(deps)).toMatchObject({ artists: 0 });
    expect(world.calls).toHaveLength(0);
  });

  it('YouTube 할당량 소진(403 quotaExceeded)은 아티스트 실패로 세지 않고 작업을 멈춘다', async () => {
    await seedArtists();
    const { deps, events, world } = setup(fakeMusicWorld({ quotaExceeded: true }));
    expect(await runIngest(deps)).toMatchObject({ stoppedBy: 'outage', failedArtists: 0 });
    expect(world.count('www.googleapis.com')).toBe(1); // 첫 호출에서 멈춘다(다음 아티스트로 할당량을 더 쓰지 않음)
    expect(events.some((e) => e.type === 'artist_ingest_failed')).toBe(false);
    for (const a of [RADIOHEAD, IU]) {
      expect((await db.doc(`artists/${a.mbid}`).get()).get('failCount')).toBe(0);
    }
    const logs = (await db.collection('opsLog').get()).docs.map((d) => d.data());
    expect(
      logs.some(
        (l) => l.kind === 'job_failed' && /youtube is unavailable/i.test(String(l.message)),
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it('MusicBrainz 장애(재시도 후에도 503)도 아티스트 실패로 세지 않는다', async () => {
    await seedArtists();
    const { deps, events } = setup(fakeMusicWorld({ musicbrainzDown: true }));
    expect(await runIngest(deps)).toMatchObject({ stoppedBy: 'outage' });
    expect(events.some((e) => e.type === 'artist_ingest_failed')).toBe(false);
    expect(events.some((e) => e.type === 'source_unavailable')).toBe(true);
  });

  it('새 영상이 한 번에 볼 수(maxVideos)보다 많으면 오래된 것부터 처리하고 다음 실행에서 이어서 본다', async () => {
    await seedArtists();
    await runIngest({ ...setup().deps, limits: { maxVideos: 2 } });
    // Radiohead 새 영상(게시 시각 있는 5개) 중 오래된 2개(비공개 01-10, 티저 01-20)만 처리
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).get('lastSeenPublishedAt')).toBe(
      '2024-01-20T12:00:00Z',
    );
    expect(await links(KARMA_MBID)).toEqual({});

    await runIngest({ ...setup().deps, limits: { maxVideos: 2 } });
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).get('lastSeenPublishedAt')).toBe(
      '2024-02-15T12:00:00Z',
    );
    expect(Object.keys(await links(KARMA_MBID))).toEqual(['rhKarmaLive']);

    await runIngest({ ...setup().deps, limits: { maxVideos: 2 } });
    expect(Object.keys(await links(KARMA_MBID)).sort()).toEqual(['rhKarmaLive', 'rhKarmaMV01']);
  });

  it('자른 자리와 게시 시각이 같은 영상은 함께 처리해 잃지 않는다', async () => {
    await seedArtists();
    const { deps } = setup(fakeMusicWorld({ tie: true }));
    await runIngest({ ...deps, limits: { maxVideos: 3 } });
    // 01-10, 01-20, 02-01(Live) + 같은 시각 02-01(No Surprises)까지
    expect((await links(NO_SURPRISES_MBID)).rhNoSurp001).toBeDefined();
    expect((await links(KARMA_MBID)).rhKarmaLive).toBeDefined();
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).get('lastSeenPublishedAt')).toBe(
      '2024-02-01T12:00:00Z',
    );
  });

  it('마감 시각이 지나면 처리한 데까지 저장하고 정상 종료 기록을 남긴다', async () => {
    await seedArtists();
    const { deps, events } = setup();
    let ticks = 0;
    // 첫 아티스트 시작 전 확인(0)은 통과, 첫 영상 묶음 뒤 확인(1)에서 마감
    const summary = await runIngest({ ...deps, deadlineMs: 1, clock: () => ticks++ });
    expect(summary).toMatchObject({ stoppedBy: 'deadline', artists: 1 });
    expect((await db.doc(`artists/${RADIOHEAD.mbid}`).get()).get('lastSeenPublishedAt')).toBe(
      '2024-01-10T12:00:00Z',
    );
    expect(events.at(-1)).toMatchObject({ type: 'job_finished' });
    const logs = (await db.collection('opsLog').get()).docs.map((d) => String(d.get('message')));
    expect(logs.some((m) => m.includes('stopped: deadline'))).toBe(true);
  });

  it('이미 연결된 영상은 다시 다루지 않는다 (재확인·관리자가 바꾼 상태를 덮지 않음, 다른 곡에 겹치지 않음)', async () => {
    await seedArtists();
    await runIngest(setup().deps);
    await db.doc(`songs/${KARMA_MBID}/links/rhKarmaMV01`).update({ status: 'gone' });
    await db.doc(`artists/${RADIOHEAD.mbid}`).update({ lastSeenPublishedAt: null });
    const again = setup();
    expect(await runIngest(again.deps)).toMatchObject({ linksActive: 0 });
    // 연결된 3개(MV·No Surprises·Live)는 건너뛰고, 곡을 못 찾았던 티저 1개만 다시 검색한다
    expect(again.world.count('musicbrainz.org')).toBe(1);
    expect((await db.doc(`songs/${KARMA_MBID}/links/rhKarmaMV01`).get()).get('status')).toBe(
      'gone',
    );
  });
});

describe('아티스트 대기열 (enqueueArtist)', () => {
  const mbid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  it('하루 50명까지만 넣고, 이미 대상이거나 대기 중이면 넣지 않는다', async () => {
    const at = new Date('2026-11-21T20:00:00Z');
    for (let i = 0; i < 50; i++)
      expect(await enqueueArtist(db, { mbid: mbid(i), name: `A${i}` }, at)).toBe('queued');
    expect(await enqueueArtist(db, { mbid: mbid(50), name: 'A50' }, at)).toBe('daily_limit');
    expect(await enqueueArtist(db, { mbid: mbid(1), name: 'A1' }, at)).toBe('already_queued');
    await db.doc(`artists/${RADIOHEAD.mbid}`).set({ name: 'Radiohead', mbid: RADIOHEAD.mbid });
    expect(await enqueueArtist(db, RADIOHEAD, at)).toBe('already_tracked');
    // 태평양 시간으로 다음 날이면 다시 넣을 수 있다
    expect(
      await enqueueArtist(db, { mbid: mbid(50), name: 'A50' }, new Date('2026-11-22T09:00:00Z')),
    ).toBe('queued');
  });

  it('MBID 형식이 틀리거나 이름이 비면 거부', async () => {
    await expect(enqueueArtist(db, { mbid: 'not-a-uuid', name: 'x' })).rejects.toThrow();
    await expect(enqueueArtist(db, { mbid: mbid(1), name: '  ' })).rejects.toThrow();
  });
});

describe('대기열 옮기기 순서 (T43, D-056)', () => {
  const mbid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  it('찾은 사람 수 많은 아티스트부터 옮기고, 같으면 먼저 들어온 순', async () => {
    const at = new Date();
    const day = pacificDay(at);
    // 먼저 들어온 순: 1명 → 아무도 없음 → 3명 → 3명
    for (const i of [1, 2, 3, 4]) {
      expect(
        await enqueueArtist(db, { mbid: mbid(i), name: `A${i}` }, new Date(at.getTime() + i)),
      ).toBe('queued');
    }
    const people = { [mbid(1)]: 1, [mbid(3)]: 3, [mbid(4)]: 3 };
    for (const [id, n] of Object.entries(people)) {
      await db
        .doc(`requestTally/artist_${id}`)
        .set({ kind: 'artist', id, days: { [day]: n }, updatedAt: at });
    }
    await promoteQueue(db, 2, at);
    const tracked = (await db.collection('artists').get()).docs.map((d) => d.id).sort();
    expect(tracked).toEqual([mbid(3), mbid(4)]);
    // 나머지는 다음 실행에: 1명 → 0명 순
    await promoteQueue(db, 1, at);
    expect((await db.doc(`artists/${mbid(1)}`).get()).exists).toBe(true);
    expect((await db.doc(`artists/${mbid(2)}`).get()).exists).toBe(false);
  });
});
