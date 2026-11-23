import { describe, expect, it } from 'vitest';
import { SERVER_SECRET_NAMES } from './secret-names.js';
import { optionalValue, secrets } from './secrets.js';

describe('secrets', () => {
  it('비밀값 이름 목록과 정의가 정확히 일치한다', () => {
    expect(Object.keys(secrets).sort()).toEqual([...SERVER_SECRET_NAMES].sort());
    for (const name of SERVER_SECRET_NAMES) expect(secrets[name].name).toBe(name);
  });
});

describe('optionalValue — 아직 정하지 않은 비밀값은 none으로 넣어 두고 없음으로 동작', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['none', ''],
    [' NONE\n', ''],
    ['sk-abc', 'sk-abc'],
    [' sk-abc\n', 'sk-abc'],
    ['nonexistent', 'nonexistent'],
  ])('%j → %j', (raw, want) => {
    expect(optionalValue(raw)).toBe(want);
  });
});
