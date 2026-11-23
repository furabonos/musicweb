import { describe, expect, it } from 'vitest';
import { normalizeRequest, parseCacheKey } from './parseCache.js';

/** 저장된 해석의 키 (T32, D-048) */
const KEY = 'test-hash-key-0123456789abcdef-0123456789';

describe('parseCacheKey', () => {
  it('공백·대소문자만 다른 문장은 같은 키', () => {
    const a = parseCacheKey('Songs like  Doja by Central Cee', 'en', KEY);
    const b = parseCacheKey('  songs LIKE doja   by central cee ', 'en', KEY);
    expect(a).toBe(b);
  });
  it('화면 언어가 다르거나 문장이 다르면 다른 키', () => {
    const a = parseCacheKey('songs like Doja', 'en', KEY);
    expect(parseCacheKey('songs like Doja', 'ko', KEY)).not.toBe(a);
    expect(parseCacheKey('songs like Dojo', 'en', KEY)).not.toBe(a);
  });
  it('키에 문장 원문이 드러나지 않고, 서버 비밀이 다르면 다른 키', () => {
    const k = parseCacheKey('my private search sentence', 'en', KEY);
    expect(k).not.toMatch(/private|search|sentence/i);
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseCacheKey('my private search sentence', 'en', `${KEY}x`)).not.toBe(k);
  });
  it('짧은 키는 거부', () => {
    expect(() => parseCacheKey('x', 'en', 'short')).toThrow();
  });
  it('정규화: NFKC·소문자·공백 하나', () => {
    expect(normalizeRequest(' Ｄｏｊａ\t BY  Central ')).toBe('doja by central');
  });
});
