import { describe, expect, it } from 'vitest';
import { nextPacificMidnight, pacificDay } from './day.js';

describe('pacificDay (YouTube 할당량과 같은 태평양 시간 자정 기준)', () => {
  it.each([
    // [UTC 시각, 태평양 날짜]
    ['2026-11-21T07:59:59Z', '2026-11-20'], // PST(UTC-8) 자정 직전
    ['2026-11-21T08:00:00Z', '2026-11-21'], // PST 자정
    ['2026-07-01T06:59:59Z', '2026-06-30'], // PDT(UTC-7) 자정 직전
    ['2026-07-01T07:00:00Z', '2026-07-01'], // PDT 자정
    ['2026-03-08T07:59:00Z', '2026-03-07'], // 서머타임 시작일(3/8) 전날 밤
    ['2026-03-08T10:30:00Z', '2026-03-08'], // 서머타임 시작 직후
    ['2026-11-01T08:30:00Z', '2026-11-01'], // 서머타임 끝나는 날
    ['2026-12-31T23:00:00Z', '2026-12-31'],
    ['2027-01-01T08:00:00Z', '2027-01-01'],
  ])('%s → %s', (utc, day) => {
    expect(pacificDay(new Date(utc))).toBe(day);
  });

  it('한국 시간 기준 날짜가 아니다 (KST 오전 9시는 태평양 전날)', () => {
    expect(pacificDay(new Date('2026-11-21T00:00:00Z'))).toBe('2026-11-20'); // KST 11/21 09:00
  });
});

describe('nextPacificMidnight (한도 초기화 시각)', () => {
  it.each([
    ['2026-11-21T20:00:00Z', '2026-11-22T08:00:00.000Z'], // PST
    ['2026-07-01T12:00:00Z', '2026-07-02T07:00:00.000Z'], // PDT
    ['2026-03-07T20:00:00Z', '2026-03-08T08:00:00.000Z'], // 서머타임 시작 전날 → 그날 자정은 아직 PST
    ['2026-03-08T20:00:00Z', '2026-03-09T07:00:00.000Z'], // 서머타임 시작일(23시간)
    ['2026-11-01T20:00:00Z', '2026-11-02T08:00:00.000Z'], // 서머타임 끝나는 날(25시간)
    ['2026-11-21T07:59:59Z', '2026-11-21T08:00:00.000Z'], // 자정 1초 전
  ])('%s → %s', (now, reset) => {
    const r = nextPacificMidnight(new Date(now));
    expect(r.toISOString()).toBe(reset);
    expect(pacificDay(r)).not.toBe(pacificDay(new Date(now)));
    expect(pacificDay(new Date(r.getTime() - 1000))).toBe(pacificDay(new Date(now)));
  });
});
