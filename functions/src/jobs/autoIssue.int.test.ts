import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIssueFiler,
  firestoreFingerprintStore,
  firestoreIssueBudget,
  GITHUB_REPO,
} from '../adapters/github.js';
import { pacificDay } from '../core/day.js';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { gatherSignals, runAutoIssue } from './autoIssue.js';

const db = emulatorDb();
beforeEach(clearFirestore);

const NOW = new Date('2026-11-23T14:00:00Z');
// 상한 카운터는 가짜 시각이 아니라 실제 현재 날짜(usage/{오늘})에 쌓인다
const HOUR = 60 * 60 * 1000;
const ago = (h: number) => Timestamp.fromMillis(NOW.getTime() - h * HOUR);

async function addEvent(
  type: string,
  attrs: Record<string, unknown>,
  at: Timestamp,
  outcome = 'ok',
) {
  await db
    .collection('events')
    .add({ type, attrs, outcome, durationMs: null, actorHash: null, at });
}

/** 요청을 세는 가짜 GitHub */
function countingGitHub() {
  const requests: { method: string; url: string }[] = [];
  let n = 40;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url });
    if (method === 'POST' && url.endsWith('/issues')) {
      const num = n++;
      return Response.json(
        { number: num, html_url: `https://github.com/${GITHUB_REPO}/issues/${num}` },
        { status: 201 },
      );
    }
    if (method === 'GET') return Response.json({ state: 'open' });
    return Response.json({ id: 1 }, { status: 201 });
  }) as typeof fetch;
  return { fetch: f, requests };
}

function filerAt(now: Date, gh: ReturnType<typeof countingGitHub>) {
  return createIssueFiler({
    token: 'test-token-not-real',
    events: memoryEvents().sink,
    budget: firestoreIssueBudget(db),
    store: firestoreFingerprintStore(db),
    fetch: gh.fetch,
    now: () => now,
  });
}

/** 감지 규칙 두 개(링크 고장, 작업 실패)가 걸리는 하루 */
async function seedProblems() {
  await addEvent('error', { code: 'open_link_broken', where: 'linkHealth' }, ago(10), 'error');
  await addEvent('job_started', { job: 'refresh' }, ago(13));
  await addEvent('job_finished', { job: 'refresh', processed: 3, failed: 1 }, ago(12), 'error');
}

describe('gatherSignals', () => {
  it('지난 24시간 기록만 세고, 요청 해석은 앞 7일과 따로 셈', async () => {
    for (let i = 0; i < 3; i++) await addEvent('embed_blocked', { code: 150 }, ago(1 + i));
    await addEvent('embed_blocked', { code: 150 }, ago(30)); // 창 밖
    await addEvent('title_split_failed', {}, ago(2));
    await addEvent('request_parsed', { locale: 'en', requestedCount: 10 }, ago(3));
    await addEvent('request_parse_failed', { reason: 'no_output' }, ago(3), 'error');
    // 사용자 쪽 이유(기준 곡 못 찾음·빈 입력)는 급증 판단에 세지 않는다
    await addEvent('request_parse_failed', { reason: 'seed_not_found' }, ago(3), 'error');
    await addEvent('request_parse_failed', { reason: 'empty' }, ago(3), 'error');
    await addEvent('request_parse_failed', { reason: 'schema_invalid' }, ago(48), 'error');
    await addEvent('error', { code: 'other', where: 'x' }, ago(2), 'error');
    await addEvent('job_started', { job: 'ingest' }, ago(5));
    await addEvent(
      'artist_ingest_failed',
      { artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', failCount: 3, status: 'failed' },
      ago(5),
      'error',
    );
    // 수집(규칙)이 연결한 커버·종류 other는 이상, 커버 요청으로 검색 경로가 저장한 커버(lookup)는 정상
    await db.doc('songs/s1/links/v1').set({ status: 'active', kind: 'cover', linkedBy: 'rule' });
    await db.doc('songs/s1/links/v4').set({ status: 'active', kind: 'cover', linkedBy: 'lookup' });
    await db.doc('songs/s1/links/v5').set({ status: 'active', kind: 'other', linkedBy: 'ai' });
    await db.doc('songs/s1/links/v2').set({ status: 'active', kind: 'official_audio' });
    await db.doc('songs/s1/links/v3').set({ status: 'gone', kind: 'other' });
    // 오늘 건너뛴 요청 해석 시험에 merge로 남은 어제 점수는 쓰지 않는다
    await db.doc('metrics/current').set({
      eval: { at: ago(8), matching: { score: 0.9 }, parse: { score: 0.5, skipped: 'no AI key' } },
    });
    await addEvent('job_started', { job: 'purge' }, ago(6));
    // 상한·긴급 정지로 멈춘 실행(rejected)은 실패가 아니다
    await addEvent('job_finished', { job: 'purge', processed: 0, failed: 0 }, ago(6), 'rejected');
    await addEvent('job_started', { job: 'autoIssue' }, ago(6));

    const s = await gatherSignals(db, NOW);
    expect(s).toMatchObject({
      titleSplitFailed: 1,
      embedBlocked: 3,
      unofficialActiveLinks: 2,
      parse: { ok: 1, failed: 1, priorOk: 0, priorFailed: 1 },
      openLinkBroken: 0,
      jobs: {
        ingest: { started: 1, finished: 0, failedRuns: 0 },
        purge: { started: 1, finished: 1, failedRuns: 0 },
      },
      failedArtists: ['a74b1b7f-71a5-4011-9441-d0b5e4122711'],
      eval: { fresh: true, matching: 0.9, parse: null },
      baseline: { matching: { score: 0.98, tolerance: 0 } },
    });
  });
});

describe('runAutoIssue', () => {
  it('autoIssue=false면 GitHub 호출 0건 (작업도 어댑터도)', async () => {
    await seedProblems();
    await db.doc('config/runtime').set({ killSwitches: { autoIssue: false } });
    const gh = countingGitHub();
    const ev = memoryEvents();
    const r = await runAutoIssue({ db, events: ev.sink, filer: filerAt(NOW, gh), now: () => NOW });
    expect(r.stoppedBy).toBe('killSwitch');
    expect(gh.requests).toEqual([]);
    expect(ev.events.map((e) => e.type)).toEqual(['kill_switch_blocked']);

    // 작업을 건너뛰고 어댑터를 바로 불러도 상한 트랜잭션이 긴급 정지를 확인해 요청하지 않는다
    await expect(
      filerAt(NOW, gh).file({ rule: 'open_link_broken', key: 'watch_videos', facts: { count: 1 } }),
    ).rejects.toThrow(/autoIssue/);
    expect(gh.requests).toEqual([]);
    expect((await db.doc(`usage/${pacificDay(new Date())}`).get()).exists).toBe(false);
  });

  it('켜져 있으면 문제마다 이슈 → 다음 날 같은 문제는 댓글만', async () => {
    await seedProblems();
    const gh = countingGitHub();
    const r1 = await runAutoIssue({
      db,
      events: memoryEvents().sink,
      filer: filerAt(NOW, gh),
      now: () => NOW,
    });
    expect(r1).toMatchObject({ findings: 2, created: 2, commented: 0, failed: 0 });
    expect(
      gh.requests.filter((q) => q.method === 'POST' && q.url.endsWith('/issues')),
    ).toHaveLength(2);
    expect((await db.collection('issueFingerprints').get()).size).toBe(2);
    expect((await db.doc(`usage/${pacificDay(new Date())}`).get()).data()).toMatchObject({
      autoIssues: 2,
      githubCalls: 2,
    });
    const log = await db.collection('opsLog').where('kind', '==', 'issue').get();
    expect(log.docs.map((d) => d.get('links')[0])).toEqual(
      expect.arrayContaining([`https://github.com/${GITHUB_REPO}/issues/40`]),
    );

    // 같은 날 다시 돌려도 호출 없음
    const before = gh.requests.length;
    await runAutoIssue({
      db,
      events: memoryEvents().sink,
      filer: filerAt(NOW, gh),
      now: () => NOW,
    });
    expect(gh.requests.length).toBe(before);

    // 다음 날: 같은 문제가 또 생김 → 새 이슈 없이 댓글
    const next = new Date(NOW.getTime() + 24 * HOUR);
    await db
      .collection('events')
      .get()
      .then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
    await addEvent(
      'error',
      { code: 'open_link_broken', where: 'linkHealth' },
      Timestamp.fromMillis(next.getTime() - HOUR),
      'error',
    );
    const r2 = await runAutoIssue({
      db,
      events: memoryEvents().sink,
      filer: filerAt(next, gh),
      now: () => next,
    });
    expect(r2).toMatchObject({ findings: 1, created: 0, commented: 1 });
    expect(gh.requests.slice(before).map((q) => q.method)).toEqual(['GET', 'POST']);
    expect(gh.requests.at(-1)?.url).toMatch(/\/issues\/\d+\/comments$/);
  });

  it('링크 고장 하루는 이슈 하나 (링크 확인 작업 실패로 또 열지 않음)', async () => {
    await addEvent('job_started', { job: 'linkHealth' }, ago(10));
    await addEvent('error', { code: 'open_link_broken', where: 'linkHealth' }, ago(10), 'error');
    await addEvent(
      'job_finished',
      { job: 'linkHealth', processed: 1, failed: 1 },
      ago(10),
      'error',
    );
    const gh = countingGitHub();
    const r = await runAutoIssue({
      db,
      events: memoryEvents().sink,
      filer: filerAt(NOW, gh),
      now: () => NOW,
    });
    expect(r).toMatchObject({ findings: 1, created: 1 });
  });

  it('GitHub가 실패하면 실패로 세고 오류·작업 실패 기록을 남김', async () => {
    await seedProblems();
    const ev = memoryEvents();
    const filer = createIssueFiler({
      token: 'test-token-not-real',
      events: ev.sink,
      budget: firestoreIssueBudget(db),
      store: firestoreFingerprintStore(db),
      fetch: (async () => new Response('{}', { status: 502 })) as typeof fetch,
      now: () => NOW,
    });
    const r = await runAutoIssue({ db, events: ev.sink, filer, now: () => NOW });
    expect(r).toMatchObject({ findings: 2, failed: 2, created: 0 });
    expect(ev.events.filter((e) => e.type === 'error').map((e) => e.attrs)).toEqual([
      { code: 'git_hub_error', where: 'autoIssue.file' },
      { code: 'git_hub_error', where: 'autoIssue.file' },
    ]);
    expect(ev.events.at(-1)).toMatchObject({ type: 'job_finished', outcome: 'error' });
    const log = await db.collection('opsLog').where('kind', '==', 'job_failed').get();
    expect(log.size).toBe(1);
  });

  it('신호를 모으지 못하면(설정·데이터 문제) 조용히 멈추지 않고 기록', async () => {
    // metrics/current.eval.at이 시각이 아니어도 견디는지가 아니라, 읽기 자체가 실패하는 경우를 흉내 낸다
    const ev = memoryEvents();
    const broken = new Proxy(db, {
      get(t, k) {
        if (k === 'collectionGroup')
          return () => {
            throw new Error('index missing');
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await runAutoIssue({ db: broken, events: ev.sink, filer: null, now: () => NOW });
    expect(r.failed).toBe(1);
    expect(ev.events.find((e) => e.type === 'error')?.attrs).toEqual({
      code: 'error',
      where: 'autoIssue.gather',
    });
    expect(ev.events.at(-1)).toMatchObject({ type: 'job_finished', outcome: 'error' });
    expect((await db.collection('opsLog').where('kind', '==', 'job_failed').get()).size).toBe(1);
  });

  it('하루 상한을 넘는 새 문제는 만들지 않고 한도 도달 이벤트·운영 일지에 남김', async () => {
    await seedProblems();
    await db.doc('config/runtime').set({ limits: { service: { autoIssues: 1 } } });
    const gh = countingGitHub();
    const ev = memoryEvents();
    const r = await runAutoIssue({ db, events: ev.sink, filer: filerAt(NOW, gh), now: () => NOW });
    expect(r).toMatchObject({ findings: 2, created: 1, notFiled: 1 });
    expect(gh.requests).toHaveLength(1);
    expect(ev.events.filter((e) => e.type === 'limit_reached').map((e) => e.attrs)).toEqual([
      { scope: 'service', counter: 'autoIssues' },
    ]);
    const limit = await db.collection('opsLog').where('kind', '==', 'limit').get();
    expect(limit.docs[0]?.get('message')).toContain('new auto-issue limit');
    expect(limit.docs[0]?.get('message')).toContain('1 problem');
  });

  it('실행 중에 긴급 정지를 끄면 그 뒤로는 요청하지 않음', async () => {
    await seedProblems();
    const gh = countingGitHub();
    const ev = memoryEvents();
    const r = await runAutoIssue({
      db,
      events: ev.sink,
      filer: filerAt(NOW, gh),
      now: () => NOW,
      // 첫 이슈를 남긴 직후 관리자가 끈 것처럼
      opsLog: async () => {
        await db.doc('config/runtime').set({ killSwitches: { autoIssue: false } });
      },
    });
    expect(r).toMatchObject({ created: 1, stoppedBy: 'killSwitch' });
    expect(gh.requests).toHaveLength(1);
    expect(ev.events.filter((e) => e.type === 'kill_switch_blocked')).toHaveLength(1);
  });

  it('토큰이 없으면 감지만 하고 운영 일지에 남김', async () => {
    await seedProblems();
    const r = await runAutoIssue({ db, events: memoryEvents().sink, filer: null, now: () => NOW });
    expect(r).toMatchObject({ findings: 2, notFiled: 2, created: 0 });
    const log = await db.collection('opsLog').get();
    expect(log.docs[0]?.get('message')).toContain('no GitHub token');
  });
});
