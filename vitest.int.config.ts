import { defineConfig } from 'vitest/config';

// 통합 테스트: Firebase 에뮬레이터 안에서 실행 (pnpm test:int).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['functions/src/**/*.int.test.ts'],
    testTimeout: 20_000,
  },
});
