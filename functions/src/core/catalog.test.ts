import { describe, expect, it } from 'vitest';
import { isRecommendable } from './catalog.js';

const NOW = new Date('2026-11-22T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const base = { status: 'active', kind: 'official_audio', embeddable: true };

describe('isRecommendable', () => {
  it('확인 시각 경계: 25일 직전은 포함, 정확히 25일·그 이후는 제외', () => {
    expect(
      isRecommendable({ ...base, verifiedAt: new Date(NOW.getTime() - 25 * DAY + 1) }, NOW),
    ).toBe(true);
    expect(isRecommendable({ ...base, verifiedAt: new Date(NOW.getTime() - 25 * DAY) }, NOW)).toBe(
      false,
    );
  });
  it('확인 시각이 없거나 퍼가기 불가면 제외', () => {
    expect(isRecommendable({ ...base }, NOW)).toBe(false);
    expect(isRecommendable({ ...base, embeddable: false, verifiedAt: NOW }, NOW)).toBe(false);
  });
  it('커버·리믹스는 요청 조건이 있을 때만', () => {
    const cover = { ...base, kind: 'cover', verifiedAt: NOW };
    expect(isRecommendable(cover, NOW)).toBe(false);
    expect(isRecommendable(cover, NOW, { cover: true })).toBe(true);
    expect(isRecommendable({ ...base, kind: 'remix', verifiedAt: NOW }, NOW, { remix: true })).toBe(
      true,
    );
  });
  it('모르는 종류는 제외', () => {
    expect(isRecommendable({ ...base, kind: 'karaoke', verifiedAt: NOW }, NOW)).toBe(false);
  });
});
