import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import type { GitHubReader } from '../adapters/github.js';
import { runGithubStats } from '../jobs/githubStats.js';
import { cachedStatus, readStatus } from './status.js';

/** 공개 현황판 데이터와 GitHub 수치 작업 (T21, D-042) */
const db = emulatorDb();
beforeEach(clearFirestore);
const NOW = new Date('2026-11-23T12:00:00Z');

describe('readStatus', () => {
  it('정해진 필드만 골라내고, 이상한 값·다른 주소 링크는 버린다', async () => {
    await db.doc('metrics/current').set({
      updatedAt: Timestamp.fromDate(NOW),
      service: {
        parseSuccessRate: {
          value: 0.9,
          unit: 'rate',
          method: 'Requests understood divided by all.',
        },
        injected: { value: 1, unit: 'rate', method: 'not in the list' },
        removedSongRate: { value: 'x', unit: 'rate', method: 'bad value becomes null' },
      },
      catalog: { playableSongs: { value: 10, unit: 'count', method: 'Songs with a video.' } },
      github: {
        recent: [
          { number: 5, url: 'https://github.com/furabonos/musicweb/pull/5', state: 'merged' },
          { number: 6, url: 'https://evil.example/pull/6', state: 'merged' },
        ],
      },
      privateNote: 'never returned',
    });
    await db.collection('opsLog').add({
      at: Timestamp.fromDate(NOW),
      kind: 'pr',
      message: 'Auto-fix PR merged; CI success.',
      links: ['https://github.com/furabonos/musicweb/pull/5', 'https://evil.example/x'],
    });

    const s = await readStatus(db);
    expect(s.updatedAt).toBe(NOW.toISOString());
    expect(Object.keys(s.service).sort()).toEqual(['parseSuccessRate', 'removedSongRate']);
    expect(s.service.removedSongRate?.value).toBeNull();
    expect(s.catalog.playableSongs?.value).toBe(10);
    expect(s.github?.recent?.map((r) => r.number)).toEqual([5]);
    expect(s.opsLog).toEqual([
      {
        at: NOW.toISOString(),
        kind: 'pr',
        message: 'Auto-fix PR merged; CI success.',
        links: ['https://github.com/furabonos/musicweb/pull/5'],
      },
    ]);
    expect(JSON.stringify(s)).not.toContain('never returned');
  });

  it('아직 아무 지표가 없어도 빈 모양으로 답한다', async () => {
    const s = await readStatus(db);
    expect(s).toEqual({ updatedAt: null, service: {}, catalog: {}, github: null, opsLog: [] });
  });
});

describe('cachedStatus', () => {
  it('60초 안에는 같은 결과를 다시 쓰고, 지나면 새로 읽는다', async () => {
    const a = cachedStatus(db, 1_000_000);
    expect(cachedStatus(db, 1_050_000)).toBe(a);
    const c = cachedStatus(db, 1_070_001);
    expect(c).not.toBe(a);
    await Promise.all([a, c]);
  });
});

describe('runGithubStats', () => {
  const pull = (number: number, merged: boolean) => ({
    number,
    state: 'closed' as const,
    created_at: '2026-11-22T10:00:00Z',
    closed_at: '2026-11-22T12:00:00Z',
    merged_at: merged ? '2026-11-22T12:00:00Z' : null,
    merge_commit_sha: `${'a'.repeat(39)}${number}`,
    head: { ref: `claude/issue-${number}`, sha: `${'b'.repeat(39)}${number}` },
    body: null,
    labels: [],
    html_url: `https://github.com/furabonos/musicweb/pull/${number}`,
  });
  const reader = (pulls: ReturnType<typeof pull>[]): GitHubReader => ({
    listIssues: async () => [],
    listPulls: async () => pulls,
    listMainCommits: async () => [],
    ciState: async () => 'success',
  });

  it('PR 상태가 바뀔 때만 운영 일지에 남기고, 수치를 metrics/current.github에 쓴다', async () => {
    const log = async () =>
      (await db.collection('opsLog').orderBy('at').get()).docs.map((d) => d.get('message'));
    await runGithubStats({
      db,
      events: memoryEvents().sink,
      reader: reader([pull(1, true)]),
      now: () => NOW,
    });
    await runGithubStats({
      db,
      events: memoryEvents().sink,
      reader: reader([pull(1, true)]),
      now: () => NOW,
    });
    expect(await log()).toEqual(['Auto-fix PR merged; CI success.']);
    await runGithubStats({
      db,
      events: memoryEvents().sink,
      reader: reader([pull(2, false), pull(1, true)]),
      now: () => NOW,
    });
    expect(await log()).toHaveLength(2);
    const g = (await db.doc('metrics/current').get()).get('github');
    expect(g.approvalRate.value).toBe(0.5);
    expect(g.updatedAt).toBeInstanceOf(Timestamp);
  });

  it('토큰이 없으면 수치 대신 "토큰 없음", GitHub 실패는 운영 일지·오류 기록', async () => {
    await runGithubStats({ db, events: memoryEvents().sink, reader: null, now: () => NOW });
    expect((await db.doc('metrics/current').get()).get('github.unavailable')).toBe(
      'no GitHub token',
    );

    const ev = memoryEvents();
    const broken: GitHubReader = {
      ...reader([]),
      listPulls: async () => Promise.reject(new Error('503')),
    };
    await runGithubStats({ db, events: ev.sink, reader: broken, now: () => NOW });
    expect(ev.events.find((e) => e.type === 'error')?.attrs).toMatchObject({
      where: 'githubStats.run',
    });
    expect(ev.events.at(-1)).toMatchObject({ type: 'job_finished', outcome: 'error' });
    const msgs = (await db.collection('opsLog').get()).docs.map((d) => d.get('kind'));
    expect(msgs).toContain('job_failed');
  });
});
