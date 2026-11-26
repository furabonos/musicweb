/**
 * 에뮬레이터용 Firebase 설정. 에뮬레이터는 가짜 프로젝트(demo-musicweb)와 아무 키나 받는다.
 * authDomain이 없으면 Google 로그인 팝업이 auth/auth-domain-config-required로 바로 실패한다
 * (e2e는 테스트 전용 로그인을 써서 이 고장을 못 잡았다).
 */
export function emulatorConfig(projectId: string | undefined) {
  const project = projectId || 'demo-musicweb';
  return {
    apiKey: 'fake-api-key',
    authDomain: `${project}.firebaseapp.com`,
    projectId: project,
  };
}
