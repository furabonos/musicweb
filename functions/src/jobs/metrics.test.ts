import { describe, expect, it } from 'vitest';
import { catalogMetrics, serviceMetrics, type EventCounts } from './metrics.js';

/** 현황판 지표 계산 (SPEC 4.10, T21, D-042). 손으로 계산한 값과 맞춰 본다. */
const counts: EventCounts = {
  parsed: 45,
  parseFailed: 5,
  hallucinated: 7,
  removed: 12,
  songsShown: 400,
  lookups: 40,
  searchFreeLookups: 30,
};

describe('serviceMetrics', () => {
  const m = serviceMetrics(counts, {
    eval: { fresh: true, matchingScore: 0.98 },
    recommendBaseline: { score: 1, measuredAt: '2026-11-22T14:42:08.887Z' },
  });

  it('요청 해석 성공률 = 성공 / (성공 + 실패)', () => {
    expect(m.parseSuccessRate.value).toBe(0.9); // 45 / 50
    expect(m.parseSuccessRate.unit).toBe('rate');
  });
  it('걸러 낸 없는 곡 수 = AI가 낸 목록 밖 곡의 합', () => {
    expect(m.madeUpSongsFiltered).toMatchObject({ value: 7, unit: 'count' });
  });
  it('사용자가 뺀 곡 비율 = 뺀 곡 / 보여 준 곡', () => {
    expect(m.removedSongRate.value).toBe(0.03); // 12 / 400
  });
  it('공식 음원 연결 정확도 = 오늘 곡 연결 시험 점수', () => {
    expect(m.officialLinkAccuracy).toMatchObject({ value: 0.98, unit: 'score' });
  });
  it('추천 시험 점수 = 마지막으로 잰 기준 점수, 언제 쟀는지 방법에 적는다', () => {
    expect(m.recommendTestScore.value).toBe(1);
    expect(m.recommendTestScore.method).toContain('2026-11-22');
  });
  it('숫자마다 계산 방법 문장이 있다', () => {
    for (const metric of Object.values(m)) expect(metric.method.length).toBeGreaterThan(20);
  });

  it('분모가 0이면 값은 null(0%로 보이지 않게)', () => {
    const zero = serviceMetrics(
      { ...counts, parsed: 0, parseFailed: 0, removed: 0, songsShown: 0 },
      { eval: { fresh: true, matchingScore: 0.98 }, recommendBaseline: null },
    );
    expect(zero.parseSuccessRate.value).toBeNull();
    expect(zero.removedSongRate.value).toBeNull();
    expect(zero.recommendTestScore.value).toBeNull();
  });

  it('오늘 시험이 없으면(오래된 점수) 연결 정확도는 null', () => {
    const stale = serviceMetrics(counts, {
      eval: { fresh: false, matchingScore: 0.98 },
      recommendBaseline: null,
    });
    expect(stale.officialLinkAccuracy.value).toBeNull();
  });

  it('비율은 소수 셋째 자리까지', () => {
    const r = serviceMetrics(
      { ...counts, parsed: 1, parseFailed: 2 },
      { eval: { fresh: false, matchingScore: null }, recommendBaseline: null },
    );
    expect(r.parseSuccessRate.value).toBe(0.333);
  });
});

describe('catalogMetrics', () => {
  const limits = { ytUnits: 9000, ytSearchUser: 80, ytSearchJob: 20 };
  const usage = { ytUnits: 1200, ytSearchUser: 5, ytSearchJob: 20 };

  it('보유 곡·전날보다 늘어난 곡·검색 없이 처리한 비율·남은 YouTube 호출', () => {
    const m = catalogMetrics({
      playableSongs: 1500,
      previousPlayableSongs: 1480,
      lookups: 40,
      searchFreeLookups: 30,
      limits,
      usage,
    });
    expect(m.playableSongs.value).toBe(1500);
    expect(m.songsAdded.value).toBe(20);
    expect(m.searchFreeRate.value).toBe(0.75); // 30 / 40
    expect(m.ytUnitsLeft.value).toBe(7800);
    expect(m.ytUserSearchesLeft.value).toBe(75);
    expect(m.ytJobSearchesLeft.value).toBe(0);
  });

  it('줄어든 날은 음수 그대로(숨기지 않음), 전날 값이 없으면 null', () => {
    const base = { playableSongs: 10, lookups: 0, searchFreeLookups: 0, limits, usage };
    expect(catalogMetrics({ ...base, previousPlayableSongs: 12 }).songsAdded.value).toBe(-2);
    expect(catalogMetrics({ ...base, previousPlayableSongs: null }).songsAdded.value).toBeNull();
  });

  it('요청이 없으면 검색 없이 처리한 비율은 null, 사용량을 넘겨도 남은 값은 0 아래로 안 감', () => {
    const m = catalogMetrics({
      playableSongs: 0,
      previousPlayableSongs: 0,
      lookups: 0,
      searchFreeLookups: 0,
      limits,
      usage: { ytUnits: 9500, ytSearchUser: 0, ytSearchJob: 0 },
    });
    expect(m.searchFreeRate.value).toBeNull();
    expect(m.ytUnitsLeft.value).toBe(0);
  });
});
