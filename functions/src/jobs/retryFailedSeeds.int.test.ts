import { readFileSync } from 'node:fs';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseRecordingSearch, type RecordingCandidate } from '../adapters/musicbrainz.js';
import { BudgetExceededError } from '../core/budget.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { runRetryFailedSeeds } from './retryFailedSeeds.js';

/** 실패한 이름 다시 찾기 (SPEC 4.3b, T43, D-056). MusicBrainz 검색은 녹화 응답(Karma Police) */
const db = emulatorDb();
beforeEach(clearFirestore);

const NOW = new Date('2026-11-26T11:00:00Z'); // 태평양 2026-11-26 03:00
const DAY = '2026-11-26';
const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const karma = parseRecordingSearch(
  JSON.parse(readFileSync('tests/fixtures/music/mb-recording-search-karma-police.json', 'utf8')),
);

function mb(opts: { failWith?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    port: {
      searchRecordings: async (artist: string, title: string): Promise<RecordingCandidate[]> => {
        calls.push(`${artist}|${title}`);
        if (opts.failWith) throw opts.failWith;
        return artist.toLowerCase() === 'radiohead' ? karma : [];
      },
    },
  };
}

/** 3명이 찾아 이름이 저장된 실패 기록 */
async function failed(
  id: string,
  label: { artist: string; title: string },
  over: Record<string, unknown> = {},
) {
  await db.doc(`failedSeedTally/${id}`).set({
    days: { [DAY]: 3 },
    people: { p1: DAY, p2: DAY, p3: DAY },
    label,
    labeledAt: Timestamp.fromDate(NOW),
    firstSeenAt: Timestamp.fromDate(NOW),
    lastTryAt: null,
    gaveUp: false,
    updatedAt: Timestamp.fromDate(NOW),
    ...over,
  });
}

const run = (port: ReturnType<typeof mb>['port'], extra = {}) => {
  const ev = memoryEvents();
  return {
    run: runRetryFailedSeeds({ db, events: ev.sink, mb: port, now: () => NOW, ...extra }),
    events: ev.events,
  };
};

describe('runRetryFailedSeeds', () => {
  it('찾으면 아티스트를 대기열에 넣고 실패 기록(이름)을 지운다. 못 찾으면 시도 시각만 남긴다', async () => {
    await failed('found', { artist: 'Radiohead', title: 'Karma Police' });
    await failed('missing', { artist: 'Nobody Knows', title: 'Secret Song' });
    const m = mb();
    const summary = await run(m.port).run;
    expect(summary).toMatchObject({ stoppedBy: null, tried: 2, found: 1, gaveUp: 0 });
    expect((await db.doc(`ingestQueue/${RADIOHEAD}`).get()).get('name')).toBe('Radiohead');
    expect((await db.doc('failedSeedTally/found').get()).exists).toBe(false);
    const miss = (await db.doc('failedSeedTally/missing').get()).data();
    expect((miss?.['lastTryAt'] as Timestamp).toMillis()).toBe(NOW.getTime());
    expect(miss?.['gaveUp']).toBe(false);
  });

  it('찾았을 때도 운영 일지·이벤트에 이름이 없다', async () => {
    await failed('found', { artist: 'Radiohead', title: 'Karma Police' });
    const { run: r, events } = run(mb().port);
    expect((await r).found).toBe(1);
    const log = JSON.stringify((await db.collection('opsLog').get()).docs.map((d) => d.data()));
    expect(log).toContain('Retry failed names');
    expect(log + JSON.stringify(events)).not.toMatch(/radiohead|karma/i);
  });

  it('대기열이 오늘 다 찼으면 이름을 지우지 않고 다음 밤에 다시 한다', async () => {
    const day = '2026-11-26';
    await db.doc(`ingestQueueDays/${day}`).set({ count: 50 });
    await failed('found', { artist: 'Radiohead', title: 'Karma Police' });
    const summary = await run(mb().port).run;
    expect(summary.found).toBe(0);
    const doc = (await db.doc('failedSeedTally/found').get()).data();
    expect(doc?.['label']).toEqual({ artist: 'Radiohead', title: 'Karma Police' });
    expect((doc?.['lastTryAt'] as Timestamp).toMillis()).toBe(NOW.getTime());
    // 다음 날 대기열에 자리가 나면 넣는다
    const next = new Date(NOW.getTime() + DAY_MS);
    expect((await run(mb().port, { now: () => next }).run).found).toBe(1);
    expect((await db.doc(`ingestQueue/${RADIOHEAD}`).get()).exists).toBe(true);
  });

  it('같은 날 이미 시도한 이름은 다시 찾지 않는다', async () => {
    await failed(
      'missing',
      { artist: 'Nobody', title: 'Song' },
      { lastTryAt: Timestamp.fromDate(NOW) },
    );
    const m = mb();
    expect((await run(m.port).run).tried).toBe(0);
    expect(m.calls).toEqual([]);
  });

  it('이름이 저장된 지 30일 동안 못 찾으면 그만 찾고 이름을 지운다', async () => {
    await failed(
      'old',
      { artist: 'Nobody', title: 'Song' },
      { labeledAt: Timestamp.fromMillis(NOW.getTime() - 31 * DAY_MS) },
    );
    expect((await run(mb().port).run).gaveUp).toBe(1);
    const doc = (await db.doc('failedSeedTally/old').get()).data();
    expect(doc).toMatchObject({ gaveUp: true, label: null });
    // 그만둔 이름은 다음 밤에 다시 조회하지 않는다
    const m = mb();
    expect((await run(m.port, { now: () => new Date(NOW.getTime() + DAY_MS) }).run).tried).toBe(0);
    expect(m.calls).toEqual([]);
  });

  it('하룻밤 상한을 지키고, 사람 수 많은 이름부터', async () => {
    await failed('three', { artist: 'Nobody A', title: 'x' });
    await failed('five', { artist: 'Nobody B', title: 'y' }, { days: { [DAY]: 5 } });
    const m = mb();
    const summary = await run(m.port, { limits: { maxNames: 1 } }).run;
    expect(summary.tried).toBe(1);
    expect(m.calls).toEqual(['Nobody B|y']);
  });

  it('긴급 정지(ingest)면 외부 호출 0건', async () => {
    await db.doc('config/runtime').set({ killSwitches: { ingest: false } });
    await failed('found', { artist: 'Radiohead', title: 'Karma Police' });
    const m = mb();
    const { run: r, events } = run(m.port);
    expect((await r).stoppedBy).toBe('killSwitch');
    expect(m.calls).toEqual([]);
    expect(events.some((e) => e.type === 'kill_switch_blocked')).toBe(true);
  });

  it('호출 한도에 닿으면 멈추고, 운영 일지에는 이름 없이 개수만', async () => {
    await failed('found', { artist: 'Radiohead', title: 'Karma Police' });
    const summary = await run(
      mb({ failWith: new BudgetExceededError('service', 'musicDataCalls', 1, 1, NOW) }).port,
    ).run;
    expect(summary.stoppedBy).toBe('limit');
    const log = JSON.stringify((await db.collection('opsLog').get()).docs.map((d) => d.data()));
    expect(log).toContain('Retry failed names');
    expect(log).not.toMatch(/radiohead|karma|nobody/i);
  });
});
