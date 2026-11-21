import { defineConfig } from 'vitest/config';

// unit 테스트: 외부 의존 없음. 통합 테스트(*.int.test.ts)는 vitest.int.config.ts.
export default defineConfig({
  test: {
    projects: [
      'apps/web/vite.config.ts',
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'functions/src/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'tools/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
    ],
  },
});
