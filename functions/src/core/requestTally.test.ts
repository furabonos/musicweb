import { describe, expect, it } from 'vitest';
import {
  failedSeedId,
  MIN_PEOPLE,
  peopleInWindow,
  prunedDays,
  rankTally,
  windowStartDay,
} from './requestTally.js';

/** 요청 횟수 집계의 계산 부분 (SPEC 4.3b, T42, D-056). 저장은 requestTally.int.test.ts */
const KEY = 'k'.repeat(32);
const NOW = new Date('2026-11-26T20:00:00Z'); // 태평양 2026-11-26

describe('30일 창', () => {
  it('오늘 포함 30일: 29일 전은 들어가고 30일 전은 빠진다', () => {
    expect(windowStartDay(NOW)).toBe('2026-10-28');
    const days = { '2026-10-27': 5, '2026-10-28': 1, '2026-11-26': 2 };
    expect(peopleInWindow(days, NOW)).toBe(3);
  });

  it('서머타임 시작 주에도 창은 정확히 30일(시간이 아니라 날짜로 뺌)', () => {
    // 2026-03-08 서머타임 시작. 태평양 4/1 00:30(PDT) = UTC 07:30
    expect(windowStartDay(new Date('2026-04-01T07:30:00Z'))).toBe('2026-03-03');
    // 서머타임 끝(11/1) 다음 날 23:30(PST) = UTC 다음 날 07:30
    expect(windowStartDay(new Date('2026-11-03T07:30:00Z'))).toBe('2026-10-04');
  });

  it('창 밖 날짜는 지우고 창 안은 그대로', () => {
    expect(prunedDays({ '2026-10-27': 5, '2026-10-28': 1, '2026-11-26': 2 }, NOW)).toEqual({
      '2026-10-28': 1,
      '2026-11-26': 2,
    });
  });

  it('잘못된 값(음수·숫자 아님)은 0으로 본다', () => {
    expect(peopleInWindow({ '2026-11-26': -3, '2026-11-25': 'x' as unknown as number }, NOW)).toBe(
      0,
    );
  });
});

describe('3명 기준과 순서', () => {
  const doc = (id: string, days: Record<string, number>) => ({ id, days });

  it('기준은 3명', () => {
    expect(MIN_PEOPLE).toBe(3);
  });

  it('2명인 대상은 빠지고 3명부터 들어가며, 사람 수 많은 순(같으면 ID 순)', () => {
    const out = rankTally(
      [
        doc('two', { '2026-11-26': 2 }),
        doc('three-b', { '2026-11-25': 1, '2026-11-26': 2 }),
        doc('five', { '2026-11-20': 5 }),
        doc('three-a', { '2026-11-26': 3 }),
        doc('old', { '2026-10-01': 9 }),
      ],
      NOW,
    );
    expect(out.map((o) => [o.id, o.people])).toEqual([
      ['five', 5],
      ['three-a', 3],
      ['three-b', 3],
    ]);
  });
});

describe('실패한 이름의 키', () => {
  it('대소문자·공백·기호만 다른 이름은 같은 키, 다른 곡은 다른 키', () => {
    const a = failedSeedId(KEY, { artist: 'Central Cee', title: 'Doja' });
    expect(failedSeedId(KEY, { artist: '  central  CEE ', title: 'DOJA!' })).toBe(a);
    expect(failedSeedId(KEY, { artist: 'Central Cee', title: 'Sprinter' })).not.toBe(a);
  });

  it('키에 이름이 드러나지 않고, 서버 비밀 없이는 같은 키를 만들 수 없다', () => {
    const a = failedSeedId(KEY, { artist: 'Central Cee', title: 'Doja' });
    expect(a.toLowerCase()).not.toContain('doja');
    expect(failedSeedId('z'.repeat(32), { artist: 'Central Cee', title: 'Doja' })).not.toBe(a);
  });

  it('짧은 비밀값은 거부', () => {
    expect(() => failedSeedId('short', { artist: 'a', title: 'b' })).toThrow();
  });
});
