import { defineConfig, devices } from '@playwright/test';

/**
 * e2e (T14): `pnpm test:e2e`가 에뮬레이터(auth·functions·firestore, 가짜 AI·음악 데이터)를 띄운 뒤 실행한다.
 * 화면은 vite 개발 서버를 에뮬레이터 모드(VITE_USE_EMULATORS=true)로 띄운다.
 */
const PORT = 5173;

export default defineConfig({
  testDir: 'e2e',
  // 에뮬레이터 하나를 같이 쓰고 테스트마다 데이터를 지우므로 하나씩
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    env: { VITE_USE_EMULATORS: 'true' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
