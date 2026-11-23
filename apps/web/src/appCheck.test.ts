import { describe, expect, it } from 'vitest';
import { appCheckSiteKey } from './appCheck';

describe('appCheckSiteKey — 실제 서버에 붙을 때만 App Check를 켠다', () => {
  it('에뮬레이터면 키가 있어도 켜지 않는다', () => {
    expect(appCheckSiteKey('site-key', true)).toBeNull();
  });

  it('실제 서버면 키를 쓴다(앞뒤 공백 제거)', () => {
    expect(appCheckSiteKey(' site-key ', false)).toBe('site-key');
  });

  it.each([undefined, '', '   '])('실제 서버인데 키가 %j면 없음', (k) => {
    expect(appCheckSiteKey(k, false)).toBeNull();
  });
});
