import { describe, expect, it } from 'vitest';
import { appCheckEnforced, fakeExternalEnabled } from './runtimeEnv.js';

const ON = {
  FUNCTIONS_EMULATOR: 'true',
  GCLOUD_PROJECT: 'demo-musicweb',
  MUSICWEB_FAKE_EXTERNAL: 'true',
};

describe('fakeExternalEnabled — 가짜 외부 서비스는 에뮬레이터의 가짜 프로젝트에서만', () => {
  it('세 조건이 모두 맞으면 켜짐', () => {
    expect(fakeExternalEnabled(ON)).toBe(true);
  });

  it.each([
    ['에뮬레이터 밖', { ...ON, FUNCTIONS_EMULATOR: undefined }],
    ['실제 프로젝트', { ...ON, GCLOUD_PROJECT: 'musicweb-prod' }],
    ['프로젝트 ID 없음', { ...ON, GCLOUD_PROJECT: undefined }],
    ['스위치 없음', { ...ON, MUSICWEB_FAKE_EXTERNAL: undefined }],
    ['스위치가 true 아님', { ...ON, MUSICWEB_FAKE_EXTERNAL: '1' }],
  ])('%s → 꺼짐', (_l, env) => {
    expect(fakeExternalEnabled(env)).toBe(false);
  });
});

describe('appCheckEnforced — App Check는 에뮬레이터 밖에서 항상 강제', () => {
  it('에뮬레이터 밖(배포 분석·실제 실행) → 켜짐', () => {
    expect(appCheckEnforced({})).toBe(true);
    expect(appCheckEnforced({ GCLOUD_PROJECT: 'aimusicwebs' })).toBe(true);
    expect(appCheckEnforced({ FUNCTIONS_EMULATOR: 'false' })).toBe(true);
  });

  it('Functions 에뮬레이터 안 → 꺼짐', () => {
    expect(appCheckEnforced({ FUNCTIONS_EMULATOR: 'true' })).toBe(false);
  });
});
