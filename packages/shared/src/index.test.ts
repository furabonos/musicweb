import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, resolveLocale } from './index';

describe('resolveLocale', () => {
  it('지원 언어는 그대로 돌려준다', () => {
    expect(resolveLocale('ko')).toBe('ko');
    expect(resolveLocale('en')).toBe('en');
  });

  it('없거나 모르는 값이면 기본 언어(영어)', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('KO')).toBe('en');
  });
});
