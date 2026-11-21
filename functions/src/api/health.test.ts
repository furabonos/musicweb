import { describe, expect, it } from 'vitest';
import { healthCheck } from './health.js';

describe('healthCheck', () => {
  it('서비스 이름과 ok를 돌려준다', () => {
    expect(healthCheck()).toEqual({ ok: true, service: 'musicweb' });
  });
});
