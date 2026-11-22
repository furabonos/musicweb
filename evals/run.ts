/**
 * 시험 실행기 (T17, SPEC 4.9, D-034). `pnpm eval`
 * - matching: 곡 연결 규칙(AI 없음, 결정적). 항상 돈다.
 * - parse: 요청 해석, recommend: 추천 — 실제 AI가 필요하다. EVAL_LLM으로 고른다:
 *     EVAL_LLM=cli  이 컴퓨터의 Claude Code(구독)로 Haiku 호출
 *     EVAL_LLM=api  ANTHROPIC_API_KEY로 직접 호출(서비스와 같은 어댑터)
 *     없음          AI 시험은 건너뜀(건너뛰었다고 출력하고 비교하지 않음)
 * - evals/baseline.json의 점수보다 (허용 폭을 넘어) 낮으면 실패(exit≠0). 같거나 높으면 통과.
 * - EVAL_UPDATE_BASELINE=1이면 이번 결과로 baseline.json을 쓴다(첫 측정·규칙 변경 PR에서).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLlm, type Llm, type LlmBudget } from '../functions/src/adapters/llm.js';
import { parseRequest } from '../functions/src/core/parseRequest.js';
import { memoryEvents } from '../functions/src/testing/music.js';
import { createCliLlm } from './claudeCli.js';
import { scoreMatchingCase, summarizeMatching, type MatchingCase } from './matching/score.js';
import { scoreCase, summarize, type ParseCase } from './parse/score.js';
import { runRecommendCase, summarizeRecommend, type RecommendCase } from './recommend/score.js';

export const SUITES = ['matching', 'parse', 'recommend'] as const;
export type SuiteName = (typeof SUITES)[number];

export interface SuiteResult {
  score: number;
  cases: number;
  skipped?: string;
  [k: string]: unknown;
}
export type Results = Partial<Record<SuiteName, SuiteResult>>;

export interface Baseline {
  _note?: string;
  /** 시험마다 기준 점수, 허용 폭, 어떤 AI 방식으로·언제 쟀는지 */
  suites: Partial<
    Record<SuiteName, SuiteResult & { tolerance?: number; llm?: string; measuredAt?: string }>
  >;
}

const DIR = import.meta.dirname;
const read = <T>(path: string) => JSON.parse(readFileSync(join(DIR, path), 'utf8')) as T;

/** 기준과 비교. 기준이 있고 이번에 잰 시험만 본다. 점수 < 기준 − 허용 폭이면 실패. */
export function compareToBaseline(
  current: Results,
  baseline: Baseline,
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const name of SUITES) {
    const cur = current[name];
    const base = baseline.suites[name];
    if (!cur) continue;
    if (cur.skipped) {
      lines.push(`${name}: 건너뜀 (${cur.skipped})`);
      continue;
    }
    if (!base || base.skipped) {
      lines.push(`${name}: ${cur.score} (기준 없음)`);
      continue;
    }
    if (cur.cases !== base.cases) {
      // 문제를 지우거나 더하면 점수 비교가 의미 없다(틀리는 문제를 지워 통과하는 것을 막음)
      ok = false;
      lines.push(
        `${name}: 문제 수가 기준(${base.cases})과 다름(${cur.cases}) → 실패. 문제를 바꿨으면 EVAL_UPDATE_BASELINE=1로 기준을 다시 쓰고 PR에 전후 점수를 적으세요`,
      );
      continue;
    }
    const tol = base.tolerance ?? 0;
    const pass = cur.score >= base.score - tol - 1e-9;
    if (!pass) ok = false;
    lines.push(
      `${name}: ${cur.score} (기준 ${base.score}, 허용 폭 ${tol}) ${pass ? '통과' : '떨어짐 → 실패'}`,
    );
  }
  return { ok, lines };
}

export async function runMatching(): Promise<SuiteResult> {
  const { cases } = read<{ cases: MatchingCase[] }>('matching/cases.json');
  const results = [];
  for (const c of cases) results.push(await scoreMatchingCase(c));
  return summarizeMatching(results);
}

export async function runParse(llm: Llm): Promise<SuiteResult> {
  const { cases } = read<{ cases: ParseCase[] }>('parse/cases.json');
  const events = memoryEvents().sink;
  const results = [];
  for (const c of cases) {
    const out = await parseRequest({ llm, events }, c.input, c.locale);
    results.push({ id: c.id, wrong: scoreCase(c, out) });
  }
  const s = summarize(results);
  return { score: s.accuracy, cases: s.cases, passed: s.passed, failedIds: s.failedIds };
}

export async function runRecommend(llm: Llm): Promise<SuiteResult> {
  const { cases } = read<{ cases: RecommendCase[] }>('recommend/cases.json');
  const results = [];
  for (const c of cases) results.push(await runRecommendCase(c, llm));
  return summarizeRecommend(results);
}

export class EvalConfigError extends Error {
  override name = 'EvalConfigError';
}

/** 정해진 값이 아니면 던진다(오타로 시험을 몰래 건너뛰지 않게). */
export function suitesFrom(env: Record<string, string | undefined>): SuiteName[] {
  if (!env.EVAL_SUITES) return [...SUITES];
  const names = env.EVAL_SUITES.split(',').map((x) => x.trim());
  for (const n of names)
    if (!(SUITES as readonly string[]).includes(n))
      throw new EvalConfigError(
        `EVAL_SUITES에 모르는 시험 '${n}'. 쓸 수 있는 값: ${SUITES.join(', ')}`,
      );
  return names as SuiteName[];
}

export function pickLlm(env: Record<string, string | undefined>): {
  llm: Llm | null;
  label: string;
  stats?: () => Record<string, number>;
  cleanup?: () => void;
} {
  if (env.EVAL_LLM === 'cli') {
    const { llm, stats, cleanup } = createCliLlm();
    return {
      llm,
      label: 'claude-code-cli (구독, claude-haiku-5-5)',
      stats: () => ({ ...stats }),
      cleanup,
    };
  }
  if (env.EVAL_LLM === 'api') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('EVAL_LLM=api에는 ANTHROPIC_API_KEY가 필요합니다.');
    let spent = 0;
    const budget: LlmBudget = {
      run: async (_max, fn) => {
        const r = await fn();
        spent += r.costMicroUsd;
        return r.result;
      },
    };
    return {
      llm: createLlm({ apiKey, events: memoryEvents().sink, budget }),
      label: 'anthropic-api (claude-haiku-5-5)',
      stats: () => ({ costMicroUsd: spent }),
    };
  }
  if (env.EVAL_LLM)
    throw new EvalConfigError(`EVAL_LLM은 cli 또는 api만 씁니다(받은 값: '${env.EVAL_LLM}').`);
  return { llm: null, label: 'none' };
}

export async function runAll(
  env: Record<string, string | undefined>,
): Promise<{ results: Results; label: string; stats?: Record<string, number> }> {
  const only = suitesFrom(env);
  const want = (n: SuiteName) => only.includes(n);
  const { llm, label, stats, cleanup } = pickLlm(env);
  try {
    const results: Results = {};
    const noLlm = 'EVAL_LLM이 없어 실제 AI 시험을 건너뜀';
    if (want('matching')) results.matching = await runMatching();
    if (want('parse'))
      results.parse = llm ? await runParse(llm) : { score: 0, cases: 0, skipped: noLlm };
    if (want('recommend'))
      results.recommend = llm ? await runRecommend(llm) : { score: 0, cases: 0, skipped: noLlm };
    return { results, label, ...(stats ? { stats: stats() } : {}) };
  } finally {
    cleanup?.();
  }
}

export const TOLERANCE: Record<SuiteName, number> = {
  matching: 0, // 결정적: 1문제라도 떨어지면 실패
  parse: 0.05, // 실제 AI라 같은 입력에도 답이 조금씩 다를 수 있음(20문항 중 1문항)
  recommend: 0.05,
};

/** 결과로 기준 파일 내용을 만든다(이번에 잰 시험만 바꾸고 나머지 기준은 그대로). */
export function nextBaseline(prev: Baseline, results: Results, label: string, now: Date): Baseline {
  const suites = { ...prev.suites };
  for (const name of SUITES) {
    const r = results[name];
    if (r && !r.skipped)
      suites[name] = {
        ...r,
        tolerance: TOLERANCE[name],
        // 곡 연결은 AI를 쓰지 않는다
        llm: name === 'matching' ? 'none' : label,
        measuredAt: now.toISOString(),
      };
  }
  return { ...prev, suites };
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  baselinePath = join(DIR, 'baseline.json'),
): Promise<number> {
  const { results, label, stats } = await runAll(env);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const { ok, lines } = compareToBaseline(results, baseline);
  console.log(`[eval] AI: ${label}`);
  for (const l of lines) console.log(`[eval] ${l}`);
  if (stats) console.log('[eval] 호출 기록', stats);
  console.log(JSON.stringify(results, null, 2));
  if (env.EVAL_UPDATE_BASELINE === '1') {
    writeFileSync(
      baselinePath,
      JSON.stringify(nextBaseline(baseline, results, label, new Date()), null, 2) + '\n',
    );
    console.log('[eval] baseline.json을 이번 결과로 썼습니다.');
    return 0;
  }
  return ok ? 0 : 1;
}
