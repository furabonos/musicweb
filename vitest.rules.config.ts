import { defineConfig } from 'vitest/config';

// 보안 규칙 테스트: Firestore·Storage 에뮬레이터 안에서 실행 (pnpm test:rules).
// 같은 에뮬레이터 데이터를 지우고 다시 넣으므로 파일을 하나씩 실행한다.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
