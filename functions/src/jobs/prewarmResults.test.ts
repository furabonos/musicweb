import { describe, expect, it } from 'vitest';
import type { LlmBudget } from '../adapters/llm.js';
import { BudgetExceededError } from '../core/budget.js';
import { DEFAULT_RUNTIME } from '../core/runtimeConfig.js';
import { fakeLlm } from '../dev/fakeWorld.js';
import { nightAiBudget, PREWARM_LIMITS } from './prewarmResults.js';

/** 밤 AI 몫 (T44, D-056). 실제 예약(firestorePrewarmLlmBudget)과 작업 흐름은 prewarmResults.int.test.ts */
const NOW = new Date('2026-11-26T11:45:00Z');

describe('밤 미리 만들기 기본값', () => {
  it('하룻밤 50곡, AI 몫 $0.30(관리자 한도)', () => {
    expect(PREWARM_LIMITS.maxSeeds).toBe(50);
    expect(DEFAULT_RUNTIME.limits.service.prewarmAiMicroUsd).toBe(300_000);
  });
});

describe('nightAiBudget', () => {
  it('예약이 한도로 거부되면 표시하고 그대로 던진다', async () => {
    const inner: LlmBudget = {
      run: async () => {
        throw new BudgetExceededError('service', 'prewarmAiMicroUsd', 0, 0, NOW);
      },
    };
    const night = nightAiBudget(inner);
    const llm = fakeLlm(night.budget);
    await expect(
      llm.structured({ op: 'llm.candidates', input: {} } as never),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(night.exhausted()).toBe(true);
  });

  it('다른 오류는 몫 소진으로 보지 않는다', async () => {
    const night = nightAiBudget({
      run: async () => {
        throw new Error('network');
      },
    });
    await expect(night.budget.run(1, async () => ({ result: 1, costMicroUsd: 0 }))).rejects.toThrow(
      'network',
    );
    expect(night.exhausted()).toBe(false);
  });

  it('성공하면 결과를 그대로 넘긴다', async () => {
    const night = nightAiBudget({ run: async (_max, fn) => (await fn()).result });
    expect(await night.budget.run(1, async () => ({ result: 'ok', costMicroUsd: 1 }))).toBe('ok');
    expect(night.exhausted()).toBe(false);
  });
});
