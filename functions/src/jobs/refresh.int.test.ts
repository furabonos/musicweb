import { beforeEach, describe, expect, it } from 'vitest';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { recommendableLinks } from '../core/catalog.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import {
  fakeMusicWorld,
  IU,
  KARMA_MBID,
  NO_SURPRISES_MBID,
  RADIOHEAD,
} from '../testing/youtube.js';
import { firestoreLastfmCache } from '../adapters/lastfm.js';
import { runPurge } from './purge.js';
import { runRefresh } from './refresh.js';

const db = emulatorDb();
const API_KEY = 'AIzaFAKEKEYFORTESTS000000000000000000';
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const RH_CHANNEL = 'UCq19-LqvG35A-30oyAiPiqA';
const IU_CHANNEL = 'UC3SyT4_WLHzN7JmHQwKQZww';
const NIGHT = 'cf3b2fd9-91d3-4d35-a0c5-d9f2ed8a5a01';

beforeEach(clearFirestore);

function setup(world = fakeMusicWorld()) {
  const ev = memoryEvents();
  const deps = {
    db,
    yt: createYouTubeRead({
      apiKey: API_KEY,
      events: ev.sink,
      budget: firestoreYtBudget(db, 'ingest'),
      fetch: world.fetch,
    }),
    events: ev.sink,
    now: () => NOW,
  };
  return { deps, world, events: ev.events };
}

function link(videoId: string, verifiedDaysAgo: number, extra: Record<string, unknown> = {}) {
  return {
    videoId,
    kind: 'official_mv',
    status: 'active',
    linkedBy: 'rule',
    ytTitle: `old title ${videoId}`,
    channelId: RH_CHANNEL,
    embeddable: true,
    madeForKids: false,
    durationSec: 200,
    verifiedAt: ago(verifiedDaysAgo),
    ...extra,
  };
}

const linkRef = (song: string, videoId: string) => db.doc(`songs/${song}/links/${videoId}`);

async function seed() {
  await db.doc(`songs/${KARMA_MBID}`).set({ mbid: KARMA_MBID, title: 'Karma Police' });
  await db
    .doc(`songs/${NO_SURPRISES_MBID}`)
    .set({ mbid: NO_SURPRISES_MBID, title: 'No Surprises' });
  await db.doc(`songs/${NIGHT}`).set({ mbid: NIGHT, title: '밤편지' });
  // 26일 된 연결: 그대로 있음(제목 바뀜) / 비공개 / 퍼가기 불가 / 삭제(응답에 없음)
  await linkRef(KARMA_MBID, 'rhKarmaMV01').set(link('rhKarmaMV01', 26));
  await linkRef(KARMA_MBID, 'rhPrivate01').set(link('rhPrivate01', 26, { kind: 'other' }));
  await linkRef(NIGHT, 'iuNoEmbed01').set(link('iuNoEmbed01', 26, { channelId: IU_CHANNEL }));
  await linkRef(NIGHT, 'deleted0001').set(link('deleted0001', 26));
  // 10일 된 연결: 재확인하지 않음
  await linkRef(NO_SURPRISES_MBID, 'rhNoSurp001').set(link('rhNoSurp001', 10));
}

describe('runRefresh — 25일 넘은 연결 재확인', () => {
  it('26일 된 연결을 재확인: 응답에 없거나 비공개·퍼가기 불가면 gone + YouTube 필드 삭제', async () => {
    await seed();
    const { deps, world } = setup();
    const r = await runRefresh(deps);
    expect(r.stoppedBy).toBeNull();
    expect(r.linksChecked).toBe(4);
    expect(r.linksGone).toBe(3);
    // 4개를 한 번에(50개 묶음) 물어봄 = 1단위
    expect(world.count('www.googleapis.com', '/videos')).toBe(1);

    for (const [song, id] of [
      [NIGHT, 'deleted0001'],
      [KARMA_MBID, 'rhPrivate01'],
      [NIGHT, 'iuNoEmbed01'],
    ] as const) {
      const d = (await linkRef(song, id).get()).data();
      expect(d?.status, id).toBe('gone');
      for (const f of ['ytTitle', 'channelId', 'embeddable', 'madeForKids', 'durationSec']) {
        expect(d, `${id}.${f}`).not.toHaveProperty(f);
      }
    }
  });

  it('바뀐 제목은 갱신되고 확인 시각이 지금으로 바뀜', async () => {
    await seed();
    const { deps } = setup();
    await runRefresh(deps);
    const d = (await linkRef(KARMA_MBID, 'rhKarmaMV01').get()).data();
    expect(d?.status).toBe('active');
    expect(d?.ytTitle).toBe('Radiohead - Karma Police (Official Music Video)');
    expect(d?.durationSec).toBeTypeOf('number');
    expect(d?.verifiedAt.toDate().getTime()).toBe(NOW.getTime());
  });

  it('25일 안 연결과 이미 gone인 연결은 다시 묻지 않음', async () => {
    await linkRef(NO_SURPRISES_MBID, 'rhNoSurp001').set(link('rhNoSurp001', 10));
    await linkRef(KARMA_MBID, 'rhKarmaMV01').set(
      link('rhKarmaMV01', 27, { status: 'gone', ytTitle: null }),
    );
    const { deps, world } = setup();
    const r = await runRefresh(deps);
    expect(r.linksChecked).toBe(0);
    expect(world.count('www.googleapis.com', '/videos')).toBe(0);
    expect((await linkRef(NO_SURPRISES_MBID, 'rhNoSurp001').get()).get('ytTitle')).toBe(
      'old title rhNoSurp001',
    );
  });

  it('아티스트 채널 정보도 25일 넘으면 재확인: 있으면 확인 시각 갱신, 없어졌으면 지움', async () => {
    const artist = (mbid: string, channelId: string) => ({
      name: 'x',
      mbid,
      status: 'paused',
      channelId,
      uploadsPlaylistId: `UU${channelId.slice(2)}`,
      lastSeenPublishedAt: '2024-01-01T00:00:00Z',
      lastScannedAt: null,
      failCount: 0,
      ytVerifiedAt: ago(26),
    });
    await db.doc(`artists/${RADIOHEAD.mbid}`).set(artist(RADIOHEAD.mbid, RH_CHANNEL));
    await db.doc(`artists/${IU.mbid}`).set(artist(IU.mbid, IU_CHANNEL));
    const { deps } = setup(fakeMusicWorld({ goneChannels: [IU_CHANNEL] }));
    const r = await runRefresh(deps);
    expect(r.artistsChecked).toBe(2);
    const rh = (await db.doc(`artists/${RADIOHEAD.mbid}`).get()).data();
    expect(rh?.channelId).toBe(RH_CHANNEL);
    // 기준 시각은 channels.list로 확인되지 않으므로 지운다(다음 수집이 다시 정함)
    expect(rh?.lastSeenPublishedAt).toBeNull();
    expect(rh?.ytVerifiedAt.toDate().getTime()).toBe(NOW.getTime());
    const iu = (await db.doc(`artists/${IU.mbid}`).get()).data();
    expect(iu).toMatchObject({
      channelId: null,
      uploadsPlaylistId: null,
      lastSeenPublishedAt: null,
      ytVerifiedAt: null,
    });
  });

  it('긴급 정지 ingest가 꺼져 있으면 YouTube를 부르지 않음', async () => {
    await seed();
    await db.doc('config/runtime').set({ killSwitches: { ingest: false } }, { merge: true });
    const { deps, world } = setup();
    const r = await runRefresh(deps);
    expect(r.stoppedBy).toBe('killSwitch');
    expect(world.calls).toHaveLength(0);
  });
});

/** 응답에 없는(삭제된) 영상 n개의 26일 된 연결 */
async function seedMany(n: number) {
  const w = db.bulkWriter();
  for (let i = 0; i < n; i++) {
    const id = `gonevid${String(i).padStart(4, '0')}`;
    void w.set(linkRef(`song${i}`, id), link(id, 26 + i / 1000));
  }
  await w.close();
}
const countStatus = async (status: string) =>
  (await db.collectionGroup('links').where('status', '==', status).get()).size;

describe('runRefresh — 나눠 묻기·한도·마감', () => {
  it('50개가 넘으면 50개씩 나눠 묻는다', async () => {
    await seedMany(60);
    const { deps, world } = setup();
    const r = await runRefresh(deps);
    expect(r.linksChecked).toBe(60);
    expect(world.count('www.googleapis.com', '/videos')).toBe(2);
    expect(await countStatus('gone')).toBe(60);
  });

  it('우리 쪽 하루 한도에 닿으면 처리한 묶음까지만 바꾸고 멈추며 운영 일지에 남김', async () => {
    await seedMany(60);
    await db.doc('config/runtime').set({ limits: { service: { ytUnits: 1 } } });
    const { deps, events, world } = setup();
    const r = await runRefresh(deps);
    expect(r.stoppedBy).toBe('limit');
    expect(r.linksChecked).toBe(50);
    expect(world.count('www.googleapis.com', '/videos')).toBe(1);
    expect(await countStatus('gone')).toBe(50);
    expect(await countStatus('active')).toBe(10);
    expect(events.some((e) => e.type === 'limit_reached')).toBe(true);
    const log = await db.collection('opsLog').where('kind', '==', 'limit').get();
    expect(log.docs[0]?.get('message')).toContain('Refresh stopped: daily limit reached');
  });

  it('실행 시간 마감이 지나면 다음 묶음으로 넘어가지 않고 정상 종료', async () => {
    await seedMany(60);
    let ticks = 0;
    const { deps, events } = setup();
    const r = await runRefresh({ ...deps, deadlineMs: 1, clock: () => ticks++ });
    expect(r.stoppedBy).toBe('deadline');
    expect(r.linksChecked).toBe(50);
    expect(events.some((e) => e.type === 'job_finished')).toBe(true);
  });
});

describe('재확인 실패 → 추천 제외 → 30일 정리', () => {
  it('할당량 소진으로 재확인이 실패하면 연결은 그대로지만 추천 후보에서 빠지고, 31일째 정리에서 지워짐', async () => {
    await seed();
    const { deps, events } = setup(fakeMusicWorld({ quotaExceeded: true }));
    const r = await runRefresh(deps);
    expect(r.stoppedBy).toBe('outage');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect((await linkRef(KARMA_MBID, 'rhKarmaMV01').get()).get('status')).toBe('active');

    // 추천 후보: 26일 된 연결은 빠지고 10일 된 것만 남는다
    const picks = await recommendableLinks(db, [KARMA_MBID, NO_SURPRISES_MBID, NIGHT], NOW);
    expect([...picks.keys()]).toEqual([NO_SURPRISES_MBID]);

    // 5일 뒤(31일째) 정리: 재확인 못 한 연결은 0건
    const later = new Date(NOW.getTime() + 5 * DAY_MS);
    await runPurge({
      db,
      events: memoryEvents().sink,
      lastfmCache: firestoreLastfmCache(db),
      now: () => later,
    });
    const stale = await db
      .collectionGroup('links')
      .where('verifiedAt', '<=', ago(30 - 5))
      .get();
    expect(stale.size).toBe(0);
    expect((await linkRef(KARMA_MBID, 'rhKarmaMV01').get()).exists).toBe(false);
    expect((await linkRef(NO_SURPRISES_MBID, 'rhNoSurp001').get()).exists).toBe(true);
  });
});
