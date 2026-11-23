import { readFileSync } from 'node:fs';
import { Timestamp } from 'firebase-admin/firestore';
import { VOCAB_VERSION } from '@musicweb/shared/similarity';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseRecording, type RecordingDetail } from '../adapters/musicbrainz.js';
import { parseSimilarArtists } from '../adapters/listenbrainz.js';
import { BudgetExceededError } from '../core/budget.js';
import { touchRequested } from '../core/precomputeOnDemand.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { runPrecompute, type PrecomputePorts } from './precompute.js';

/** 미리 계산 작업 (T29, D-046). 음악 데이터는 녹화 응답(Radiohead 비슷한 아티스트, Karma Police 녹음) */
const db = emulatorDb();
beforeEach(clearFirestore);
const NOW = new Date('2026-11-23T11:30:00Z');
const fx = (f: string) => JSON.parse(readFileSync(`tests/fixtures/music/${f}`, 'utf8')) as unknown;
const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const similar = parseSimilarArtists(fx('lb-similar-artists-radiohead.json'), RADIOHEAD);
const karma = parseRecording(fx('mb-recording-karma-police.json')) as RecordingDetail;
const A = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function music(opts: { failWith?: Error } = {}) {
  const calls: string[] = [];
  const ports: PrecomputePorts = {
    similarArtists: async (mbid, limit) => {
      calls.push(`similar:${mbid}`);
      if (opts.failWith) throw opts.failWith;
      return similar.slice(0, limit);
    },
    getRecording: async (mbid) => {
      calls.push(`rec:${mbid}`);
      return { ...karma, mbid };
    },
  };
  return { ports, calls };
}

/** 아티스트 n명: 곡 하나씩, 조회 시각은 n이 클수록 최근 */
async function seedArtists(ns: number[]) {
  for (const n of ns) {
    await db
      .doc(`artistVectors/${A(n)}`)
      .set({ lastRequestedAt: Timestamp.fromMillis(NOW.getTime() - (10 - n) * 3600_000) });
    await db.doc(`songs/${A(100 + n)}`).set({ artistMbid: A(n), releaseYear: 1997 });
  }
}

describe('runPrecompute', () => {
  it('아티스트 3명 계산: artistSimilar·artistVectors, 운영 일지 처리량', async () => {
    await seedArtists([1, 2, 3]);
    const m = music();
    const ev = memoryEvents();
    const r = await runPrecompute({ db, music: m.ports, events: ev.sink, now: () => NOW });
    expect(r).toMatchObject({ artists: 3, songs: 3, failed: 0, stoppedBy: null });
    const sim = (await db.doc(`artistSimilar/${A(1)}`).get()).data();
    expect(sim?.items).toHaveLength(Math.min(30, similar.length));
    expect(sim?.items[0]).toEqual({ artistMbid: similar[0]?.mbid, score: similar[0]?.score });
    expect((await db.doc(`artistVectors/${A(2)}`).get()).get('vocabVersion')).toBe(VOCAB_VERSION);
    const log = (await db.collection('opsLog').get()).docs.map((d) => d.get('message'));
    expect(log).toEqual(['Precompute: 3 artists updated (3 songs), 0 still fresh, 0 failed.']);
    expect(ev.events.at(-1)).toMatchObject({
      type: 'job_finished',
      attrs: { job: 'precompute', processed: 3 },
    });
  });

  it('상한이 2명이면 최근 조회 순 2명만, 30일 안에 계산한 아티스트는 건너뜀', async () => {
    await seedArtists([1, 2, 3]);
    const first = music();
    await runPrecompute({
      db,
      music: first.ports,
      events: memoryEvents().sink,
      now: () => NOW,
      limits: { maxArtists: 2, recentFirst: 2 },
    });
    expect(first.calls.filter((c) => c.startsWith('similar:'))).toEqual([
      `similar:${A(3)}`,
      `similar:${A(2)}`,
    ]);

    // 다음 날: 이미 계산한 둘은 건너뛰고 남은 하나만
    const second = music();
    const r = await runPrecompute({
      db,
      music: second.ports,
      events: memoryEvents().sink,
      now: () => new Date(NOW.getTime() + DAY_MS),
    });
    expect(second.calls.filter((c) => c.startsWith('similar:'))).toEqual([`similar:${A(1)}`]);
    expect(r).toMatchObject({ artists: 1, skipped: 2 });
  });

  it('긴급 정지(ingest)가 꺼져 있으면 음악 데이터 호출 0건', async () => {
    await seedArtists([1]);
    await db.doc('config/runtime').set({ killSwitches: { ingest: false } });
    const m = music();
    const ev = memoryEvents();
    const r = await runPrecompute({ db, music: m.ports, events: ev.sink, now: () => NOW });
    expect(r.stoppedBy).toBe('killSwitch');
    expect(m.calls).toEqual([]);
    expect(ev.events.map((e) => e.type)).toEqual(['kill_switch_blocked']);
  });

  it('음악 데이터 호출 한도에 닿으면 멈추고 운영 일지에 남긴다', async () => {
    await seedArtists([1, 2]);
    const m = music({
      failWith: new BudgetExceededError('service', 'musicDataCalls', 20_000, 20_000, NOW),
    });
    const ev = memoryEvents();
    const r = await runPrecompute({ db, music: m.ports, events: ev.sink, now: () => NOW });
    expect(r.stoppedBy).toBe('limit');
    // 첫 아티스트의 곡 하나를 묻고 비슷한 아티스트에서 한도 → 두 번째 아티스트는 손대지 않는다
    expect(m.calls.filter((c) => c.startsWith('similar:'))).toHaveLength(1);
    expect(m.calls).toHaveLength(2);
    const log = (await db.collection('opsLog').get()).docs.map((d) => d.get('message') as string);
    expect(log).toContain(
      'Precompute stopped: daily limit reached (musicDataCalls). Resumes after the next reset.',
    );
    expect(ev.events.find((e) => e.type === 'limit_reached')?.attrs).toEqual({
      scope: 'service',
      counter: 'musicDataCalls',
    });
  });

  it('마감 시간이 지나면 멈추고 다음 밤에 이어 한다고 남긴다', async () => {
    await seedArtists([1, 2]);
    let t = 0;
    const r = await runPrecompute({
      db,
      music: music().ports,
      events: memoryEvents().sink,
      now: () => NOW,
      clock: () => t++,
      deadlineMs: 1,
    });
    expect(r).toMatchObject({ stoppedBy: 'deadline', artists: 1 });
  });
});

describe('다시 계산 (리뷰 반영)', () => {
  const run = (m: ReturnType<typeof music>, now = NOW, extra = {}) =>
    runPrecompute({ db, music: m.ports, events: memoryEvents().sink, now: () => now, ...extra });

  it('30일 지난 것·낱말 목록 버전이 다른 것·그 뒤 곡이 늘어난 것은 다시 계산', async () => {
    await seedArtists([1, 2, 3]);
    await run(music());
    // 1: 그대로(신선), 2: 버전이 다름, 3: 수집이 곡을 더함
    await db.doc(`artistVectors/${A(2)}`).update({ vocabVersion: 0 });
    await db
      .doc(`artistVectors/${A(3)}`)
      .update({ songsChangedAt: Timestamp.fromMillis(NOW.getTime() + 3600_000) });
    const m = music();
    const r = await run(m, new Date(NOW.getTime() + 2 * 3600_000));
    expect(m.calls.filter((c) => c.startsWith('similar:')).sort()).toEqual(
      [`similar:${A(2)}`, `similar:${A(3)}`].sort(),
    );
    expect(r).toMatchObject({ artists: 2, skipped: 1 });
    // 31일 뒤에는 모두 다시
    const later = music();
    expect((await run(later, new Date(NOW.getTime() + 31 * DAY_MS))).artists).toBe(3);
  });

  it('아티스트 도중에 마감 시간이 되면 거기까지 저장하고 완료로 표시하지 않으며, 다음 밤에 이어 한다', async () => {
    await db
      .doc(`artistVectors/${A(1)}`)
      .set({ lastRequestedAt: Timestamp.fromDate(NOW), computedAt: null });
    for (let k = 0; k < 3; k++)
      await db.doc(`songs/${A(200 + k)}`).set({ artistMbid: A(1), releaseYear: 2000 });
    let t = 0;
    const m = music();
    const r = await run(m, NOW, { clock: () => t++, deadlineMs: 3 });
    expect(r).toMatchObject({ stoppedBy: 'deadline', artists: 1 });
    expect(m.calls.filter((c) => c.startsWith('rec:')).length).toBeLessThan(3);
    expect(m.calls.some((c) => c.startsWith('similar:'))).toBe(false);
    expect((await db.doc(`artistVectors/${A(1)}`).get()).get('computedAt')).toBeNull();

    const next = music();
    await run(next, NOW);
    const recs = next.calls.filter((c) => c.startsWith('rec:'));
    expect(recs.length).toBe(3 - m.calls.filter((c) => c.startsWith('rec:')).length);
    expect(next.calls).toContain(`similar:${A(1)}`);
  });

  it('출처 장애면 멈추고, 아티스트 하나의 다른 오류는 세고 다음으로 넘어간다', async () => {
    await seedArtists([1, 2]);
    const { SourceUnavailableError } = await import('../adapters/music-http.js');
    const down = music({ failWith: new SourceUnavailableError('listenbrainz', 503) });
    expect((await run(down)).stoppedBy).toBe('outage');

    let n = 0;
    const flaky: PrecomputePorts = {
      ...music().ports,
      similarArtists: async () => {
        if (n++ === 0) throw new Error('weird');
        return similar.slice(0, 3);
      },
    };
    const ev = memoryEvents();
    const r = await runPrecompute({ db, music: flaky, events: ev.sink, now: () => NOW });
    expect(r).toMatchObject({ failed: 1, artists: 1, stoppedBy: null });
    // 하나라도 됐으면 작업 실패(error)로 끝내지 않는다(자동 이슈 남발 방지)
    expect(ev.events.at(-1)).toMatchObject({ type: 'job_finished', outcome: 'ok' });
  });
});

describe('touchRequested', () => {
  it('같은 날 두 번째는 쓰지 않고, 아티스트 문서가 없으면 만들어 밤 작업 대상이 된다', async () => {
    await db.doc(`songs/${A(101)}`).set({ artistMbid: A(1) });
    const day = new Date('2026-11-23T20:00:00Z');
    expect(await touchRequested(db, { songIds: [A(101), A(999)], artistMbids: [A(1)] }, day)).toBe(
      2,
    );
    expect((await db.doc(`artistVectors/${A(1)}`).get()).get('lastRequestedAt')).toBeInstanceOf(
      Timestamp,
    );
    // 없는 곡은 만들지 않는다
    expect((await db.doc(`songs/${A(999)}`).get()).exists).toBe(false);
    // serverTimestamp는 지금 시각이라, 저장된 시각을 기준으로 같은 날 두 번째는 0
    const saved = (await db.doc(`songs/${A(101)}`).get()).get('lastRequestedAt') as Timestamp;
    expect(
      await touchRequested(db, { songIds: [A(101)], artistMbids: [A(1)] }, saved.toDate()),
    ).toBe(0);
  });
});
