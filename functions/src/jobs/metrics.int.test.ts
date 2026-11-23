import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { pacificDay } from '../core/day.js';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { runMetrics } from './metrics.js';

/** 지표 작업 (T21, D-042): 실제 집계 쿼리(count·sum)를 에뮬레이터에서 돌린다. */
const db = emulatorDb();
beforeEach(clearFirestore);
const NOW = new Date('2026-11-23T13:30:00Z');
const at = (hoursAgo: number) => Timestamp.fromMillis(NOW.getTime() - hoursAgo * 3600_000);

async function event(type: string, attrs: Record<string, unknown>, hoursAgo = 1) {
  await db.collection('events').add({ type, attrs, outcome: 'ok', at: at(hoursAgo) });
}

describe('runMetrics', () => {
  it('지난 24시간 이벤트로 서비스·곡 목록 지표를 metrics/current와 오늘 문서에 쓴다', async () => {
    for (let i = 0; i < 3; i++) await event('request_parsed', { locale: 'en', requestedCount: 10 });
    await event('request_parse_failed', { reason: 'no_output' });
    // 기준 곡 실패는 request_parsed 뒤에 남으므로 성공률 분모에 다시 넣지 않는다
    await event('request_parse_failed', { reason: 'no_seed' });
    await event('request_parsed', { locale: 'en', requestedCount: 10 }, 30); // 24시간 밖
    await event('recommend_step', {
      step: 'ai_pick',
      candidates: 30,
      filtered: 3,
      hallucinated: 2,
    });
    await event('recommend_step', {
      step: 'ai_pick',
      candidates: 30,
      filtered: 1,
      hallucinated: 1,
    });
    for (let i = 0; i < 4; i++) {
      await event('recommend_step', { step: 'seed', candidates: 1, filtered: 0, hallucinated: 0 });
    }
    await event('recommend_step', {
      step: 'lookup',
      candidates: 5,
      filtered: 1,
      hallucinated: 0,
      usedSearch: true,
    });
    // usedSearch가 없는 옛 기록: 검색 없음으로 세지 않는다
    await event('recommend_step', { step: 'lookup', candidates: 5, filtered: 0, hallucinated: 0 });
    await event('recommend_step', {
      step: 'lookup',
      candidates: 5,
      filtered: 0,
      hallucinated: 0,
      usedSearch: false,
    });
    await event('playlist_created', { songs: 10, usedAi: true });
    await event('playlist_created', { songs: 10, usedAi: false });
    // AI 비용 (T35): llm 호출만 더한다
    await event('external_call', { target: 'llm', op: 'llm.pick', costMicroUsd: 3000 });
    await event('external_call', { target: 'llm', op: 'llm.explain', costMicroUsd: 1000 });
    await event('external_call', { target: 'llm', op: 'llm.pick', costMicroUsd: 9999 }, 30);
    await event('external_call', { target: 'youtube_read', op: 'youtube.videos.list', units: 1 });
    // 간단 모드: 2시간 전에 켜지고 1시간 전에 꺼짐(같은 태평양 날) = 60분
    await event('saving_mode', { state: 'on', reason: 'ai_limit' }, 2);
    await event('saving_mode', { state: 'off', reason: 'limit_raised' }, 1);
    await event('song_removed', { position: 3 });

    // 곡 목록: active 연결 2개, 막힌 연결 1개
    await db.doc('songs/s1/links/v1').set({ status: 'active' });
    await db.doc('songs/s2/links/v2').set({ status: 'active' });
    await db.doc('songs/s3/links/v3').set({ status: 'blocked' });
    const yesterday = pacificDay(new Date(NOW.getTime() - 24 * 3600_000));
    await db.doc(`metrics/${yesterday}`).set({ catalog: { playableSongs: { value: 1 } } });
    await db.doc(`usage/${pacificDay(NOW)}`).set({ ytUnits: 100, ytSearchUser: 3 });
    await db.doc('metrics/current').set({ eval: { at: at(8), matching: { score: 0.98 } } });

    const ev = memoryEvents();
    await runMetrics({ db, events: ev.sink, now: () => NOW });

    for (const path of ['metrics/current', `metrics/${pacificDay(NOW)}`]) {
      const d = (await db.doc(path).get()).data() ?? {};
      expect(d.updatedAt).toBeInstanceOf(Timestamp);
      expect(d.service.parseSuccessRate.value).toBe(0.75); // 3 / 4
      expect(d.service.madeUpSongsFiltered.value).toBe(3); // 2 + 1
      expect(d.service.removedSongRate.value).toBe(0.05); // 1 / 20
      expect(d.service.officialLinkAccuracy.value).toBe(0.98);
      expect(d.catalog.playableSongs.value).toBe(2);
      expect(d.catalog.songsAdded.value).toBe(1);
      expect(d.catalog.searchFreeRate.value).toBe(0.333); // false 1 / lookup 3
      expect(d.catalog.ytUnitsLeft.value).toBe(8900);
      expect(d.catalog.ytUserSearchesLeft.value).toBe(77);
      expect(d.ai.aiFreeRate.value).toBe(0.5); // 1 / 2
      expect(d.ai.aiCostPerSet.value).toBe(0.002); // 4000 / 2 microUSD
      expect(d.ai.savingModeMinutes.value).toBe(60);
    }
    // 매일 시험 결과(eval)는 지우지 않는다(merge)
    expect((await db.doc('metrics/current').get()).get('eval.matching.score')).toBe(0.98);
    expect(ev.events.at(-1)).toMatchObject({
      type: 'job_finished',
      attrs: { job: 'metrics', processed: 1, failed: 0 },
    });
  });

  it('설정 문서가 깨져 있으면 오류를 남기고 실패로 끝낸다', async () => {
    await db.doc('config/runtime').set({ unknownField: 1 });
    const ev = memoryEvents();
    await expect(runMetrics({ db, events: ev.sink, now: () => NOW })).rejects.toThrow();
    expect(ev.events.find((e) => e.type === 'error')?.attrs).toMatchObject({
      where: 'metrics.run',
    });
    expect(ev.events.at(-1)).toMatchObject({ type: 'job_finished', outcome: 'error' });
    const log = (await db.collection('opsLog').get()).docs.map((d) => d.get('kind'));
    expect(log).toEqual(['job_failed']);
  });
});
