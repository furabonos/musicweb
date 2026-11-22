import { defineConfig } from 'vitest/config';

// 시험 실행기(`pnpm eval`, evals/run.eval.ts). unit에는 들어가지 않는다.
// 실제 AI 시험은 EVAL_LLM을 줄 때만 돈다(D-034). 결과를 그대로 보여 주려고 출력 가로채기를 끈다.
export default defineConfig({
  test: {
    name: 'eval',
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    disableConsoleIntercept: true,
  },
});
