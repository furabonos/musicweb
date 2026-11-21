import { defineConfig } from 'vitest/config';

// 통합 테스트: Firebase 에뮬레이터 안에서 실행 (pnpm test:int).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['functions/src/**/*.int.test.ts'],
    testTimeout: 20_000,
    // 파일들이 에뮬레이터 하나를 같이 쓰고 테스트마다 데이터를 지우므로 파일을 하나씩 돌린다.
    fileParallelism: false,
  },
});
