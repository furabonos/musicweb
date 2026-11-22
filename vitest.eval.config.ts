import { defineConfig } from 'vitest/config';

// 실제 모델 시험(evals/**/*.eval.ts). 돈이 들므로 unit·CI에서는 돌지 않고 직접 실행한다(T12, T17).
export default defineConfig({
  test: { name: 'eval', environment: 'node', include: ['evals/**/*.eval.ts'] },
});
