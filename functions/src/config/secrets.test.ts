import { describe, expect, it } from 'vitest';
import { SERVER_SECRET_NAMES } from './secret-names.js';
import { secrets } from './secrets.js';

describe('secrets', () => {
  it('비밀값 이름 목록과 정의가 정확히 일치한다', () => {
    expect(Object.keys(secrets).sort()).toEqual([...SERVER_SECRET_NAMES].sort());
    for (const name of SERVER_SECRET_NAMES) expect(secrets[name].name).toBe(name);
  });
});
