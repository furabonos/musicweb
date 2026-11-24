import { describe, expect, it } from 'vitest';
import { emulatorConfig } from './firebaseConfig';

describe('emulatorConfig', () => {
  it('Google 로그인 팝업에 필요한 authDomain을 넣는다', () => {
    expect(emulatorConfig(undefined)).toEqual({
      apiKey: 'fake-api-key',
      authDomain: 'demo-musicweb.firebaseapp.com',
      projectId: 'demo-musicweb',
    });
  });

  it('프로젝트 ID를 주면 그 이름으로 만든다', () => {
    expect(emulatorConfig('demo-other').authDomain).toBe('demo-other.firebaseapp.com');
  });
});
