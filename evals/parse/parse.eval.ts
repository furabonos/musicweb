/**
 * 요청 해석 실제 모델 시험 (T12). 실제 AI를 부르므로 돈이 든다(20문항, Haiku 5.5로 1센트 안팎).
 *   ANTHROPIC_API_KEY=... pnpm eval:parse
 * 결과를 evals/parse/baseline.json에 쓴다. 키가 없으면 실패한다(몰래 건너뛰지 않음).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLlm, type LlmBudget } from '../../functions/src/adapters/llm.js';
import { parseRequest } from '../../functions/src/core/parseRequest.js';
import { memoryEvents } from '../../functions/src/testing/music.js';
import { scoreCase, summarize, type ParseCase } from './score.js';

const DIR = import.meta.dirname;

it('요청 해석 정확도 측정', { timeout: 300_000 }, async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 없습니다. 실제 모델 시험은 키가 필요합니다.');
  const { cases } = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')) as {
    cases: ParseCase[];
  };
  let spent = 0;
  const budget: LlmBudget = {
    run: async (_max, fn) => {
      const r = await fn();
      spent += r.costMicroUsd;
      return r.result;
    },
  };
  const events = memoryEvents().sink;
  const llm = createLlm({ apiKey, events, budget });
  const results = [];
  for (const c of cases) {
    const out = await parseRequest({ llm, events }, c.input, c.locale);
    const wrong = scoreCase(c, out);
    results.push({ id: c.id, wrong });
    console.log(c.id, wrong.length ? `FAIL ${wrong.join(',')}` : 'ok');
  }
  const summary = summarize(results);
  writeFileSync(
    join(DIR, 'baseline.json'),
    JSON.stringify(
      {
        _note: '실제 모델(claude-haiku-5-5) 정확도. `pnpm eval:parse`가 쓴다(T12, D-029).',
        model: 'claude-haiku-5-5',
        measured: true,
        measuredAt: new Date().toISOString(),
        costMicroUsd: spent,
        ...summary,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(summary);
  expect(summary.cases).toBe(cases.length);
});
