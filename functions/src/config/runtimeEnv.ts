/**
 * 실행 환경 판별 (T14, D-031).
 *
 * 가짜 외부 서비스(가짜 AI·가짜 음악 데이터·가짜 YouTube, functions/src/dev/fakeWorld.ts)는
 * 아래 세 조건이 모두 맞을 때만 쓴다. 하나라도 아니면 실제 어댑터를 쓴다.
 *   1. Functions 에뮬레이터 안 (FUNCTIONS_EMULATOR=true)
 *   2. 프로젝트 ID가 demo- 로 시작 (실제 Firebase 프로젝트에 연결되지 않는 가짜 프로젝트)
 *   3. tools/emulator-env.sh가 만든 functions/.env.demo-musicweb에 MUSICWEB_FAKE_EXTERNAL=true
 * 실제 배포에는 1·2가 성립하지 않으므로 이 값이 켜질 수 없다.
 */
export function fakeExternalEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const project = env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? '';
  return (
    env.FUNCTIONS_EMULATOR === 'true' &&
    project.startsWith('demo-') &&
    env.MUSICWEB_FAKE_EXTERNAL === 'true'
  );
}
