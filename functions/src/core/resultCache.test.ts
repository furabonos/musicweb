import { describe, expect, it } from 'vitest';
import type { ParsedRequest } from './parseRequest.js';
import { resultCacheKey } from './resultCache.js';

/** 저장된 결과의 키 (T32, D-048): 조합 하나라도 다르면 다른 키(다른 요청 결과가 섞이지 않게) */
const req: ParsedRequest = {
  seed: { artist: 'Central Cee', title: 'Doja' },
  count: 10,
  include: { live: false, cover: false, remix: false },
  locale: 'en',
  unsupported: [],
};

describe('resultCacheKey', () => {
  const base = resultCacheKey(req, 'precomputed');
  it('이름 비교 키가 같으면(대소문자·공백) 같은 키', () => {
    expect(
      resultCacheKey({ ...req, seed: { artist: 'central  cee', title: 'DOJA' } }, 'precomputed'),
    ).toBe(base);
  });
  it.each([
    ['곡 수', { ...req, count: 15 }, 'precomputed'],
    ['조건', { ...req, include: { live: true, cover: false, remix: false } }, 'precomputed'],
    ['언어', { ...req, locale: 'ko' as const }, 'precomputed'],
    ['기준 곡', { ...req, seed: { artist: 'Central Cee', title: 'Sprinter' } }, 'precomputed'],
    ['추천 방식', req, 'ai'],
  ])('%s가 다르면 다른 키', (_n, r, mode) => {
    expect(resultCacheKey(r, mode)).not.toBe(base);
  });
  it('기준 곡이 없으면 저장하지 않는다(null)', () => {
    expect(resultCacheKey({ ...req, seed: null }, 'precomputed')).toBeNull();
  });
});
