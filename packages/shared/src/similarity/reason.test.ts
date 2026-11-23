import { describe, expect, it } from 'vitest';
import { tagLabel, tagReason } from './reason.js';
import { VOCAB } from './vocab.js';

/** 이유 문장 (T30, D-047) */
describe('tagReason', () => {
  it('두 언어, 태그 최대 2개, 같은 연도대', () => {
    expect(tagReason(['shoegaze', 'dream pop', 'noise rock'], 1990, 'en')).toBe(
      'Similar shoegaze · dream pop sound, also from the 90s.',
    );
    expect(tagReason(['shoegaze', 'dream pop', 'noise rock'], 1990, 'ko')).toBe(
      'shoegaze·dream pop 느낌이 비슷하고 같은 90년대에 나온 곡이에요.',
    );
    expect(tagReason(['k pop'], 2010, 'en')).toBe('Similar K-pop sound, also from the 2010s.');
    expect(tagReason(['k pop'], null, 'ko')).toBe('K-pop 느낌이 비슷한 곡이에요.');
    expect(tagReason(['rock'], 2000, 'ko')).toBe(
      'rock 느낌이 비슷하고 같은 2000년대에 나온 곡이에요.',
    );
  });
  it('연도대 경계: 1910~1990만 두 자리, 1900·1800·2000은 네 자리', () => {
    expect(tagReason(['jazz'], 1910, 'en')).toContain('the 10s');
    expect(tagReason(['jazz'], 1900, 'en')).toContain('the 1900s');
    expect(tagReason(['jazz'], 1890, 'ko')).toContain('1890년대');
    expect(tagReason(['jazz'], 2000, 'en')).toContain('the 2000s');
  });
  it('겹치는 태그가 없으면 null(출처 문장을 쓴다)', () => {
    expect(tagReason([], 1990, 'en')).toBeNull();
  });
  it('어떤 낱말도 HTML 특수문자 없이 글자만', () => {
    for (const w of VOCAB) {
      const r = tagReason([w], 1990, 'en') ?? '';
      expect(r, w).not.toMatch(/[<>"&]/);
      expect(tagLabel(w)).not.toMatch(/[<>"'&]/);
    }
    expect(tagReason(['r&b'], null, 'en')).toBe('Similar R and B sound.');
  });
});
