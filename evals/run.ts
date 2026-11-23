/**
 * 시험 실행기 (T17, SPEC 4.9, D-034). `pnpm eval`
 * - matching: 곡 연결 규칙(AI 없음, 결정적). 항상 돈다.
 * - parse: 요청 해석, recommend: 추천 — 실제 AI가 필요하다. EVAL_LLM으로 고른다:
 *     EVAL_LLM=cli  이 컴퓨터의 Claude Code(구독)로 Haiku 호출
 *     EVAL_LLM=api  ANTHROPIC_API_KEY로 직접 호출(서비스와 같은 어댑터)
 *     없음          AI 시험은 건너뜀(건너뛰었다고 출력하고 비교하지 않음)
 * - evals/baseline.json의 점수보다 (허용 폭을 넘어) 낮으면 실패(exit≠0). 같거나 높으면 통과.
 * - EVAL_UPDATE_BASELINE=1이면 이번 결과로 baseline.json을 쓴다(첫 측정·규칙 변경 PR에서).
 * - EVAL_SUITES=recommend-compare: 같은 추천 문제를 미리 계산(precomputed)·AI 두 방식으로 채점해 나란히 출력한다(T31, D-040).
 *   기준 비교 대상이 아니고, 기본 목록에도 없다(실제 AI가 필요해 구독 사용량이 든다 → 사용자 확인 후 실행).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLlm, type Llm, type LlmBudget } from '../functions/src/adapters/llm.js';
import { parseRequest } from '../functions/src/core/parseRequest.js';
import { memoryEvents } from '../functions/src/testing/music.js';
import { createCliLlm } from './claudeCli.js';
import { scoreMatchingCase, summarizeMatching, type MatchingCase } from './matching/score.js';
import { scoreCase, summarize, type ParseCase } from './parse/score.js';
import {
  artistGenres,
  runPrecomputedCase,
  runRecommendCase,
  summarizeRecommend,
  type RecommendCase,
} from './recommend/score.js';

export const SUITES = ['matching', 'parse', 'recommend', 'recommend-precomputed'] as const;
export type SuiteName = (typeof SUITES)[number];
/** 기준 비교가 아닌 실행(명시할 때만) */
export const COMPARE = 'recommend-compare';
type Wanted = SuiteName | typeof COMPARE;

/** AI 방식이 미리 계산 방식보다 이만큼 넘게 높아야 AI를 기본으로 (D-040) */
export const MODE_MARGIN = 0.05;

export interface ModeComparison {
  precomputed: number;
  ai: number;
  /** ai − precomputed, 소수 셋째 자리 */
  diff: number;
  /** 기본 방식 판단: 차이가 MODE_MARGIN을 넘을 때만 ai */
  choice: 'precomputed' | 'ai';
  cases: number;
}

/** 두 방식 점수 비교와 판단 규칙. 차이가 정확히 0.05면 넘은 것이 아니다(소수 오차는 무시) */
export function compareModes(pre: SuiteResult, ai: SuiteResult): ModeComparison {
  if (pre.cases !== ai.cases) {
    throw new EvalConfigError(`두 방식의 문제 수가 다릅니다(${pre.cases} vs ${ai.cases}).`);
  }
  const raw = ai.score - pre.score;
  return {
    precomputed: pre.score,
    ai: ai.score,
    // 반올림은 보여 주기용. 판단은 반올림 전 값으로
    diff: Math.round(raw * 1000) / 1000,
    choice: raw > MODE_MARGIN + 1e-9 ? 'ai' : 'precomputed',
    cases: pre.cases,
  };
}

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

/** 미리 계산한 방식(AI 없음, 결정적). CI에서 항상 돈다(T30) */
export async function runRecommendPrecomputed(): Promise<SuiteResult> {
  const { cases } = read<{ cases: RecommendCase[] }>('recommend/cases.json');
  const genres = artistGenres(cases);
  const results = [];
  for (const c of cases) results.push(await runPrecomputedCase(c, genres));
  const s = summarizeRecommend(results);
  return { score: s.score, cases: s.cases, failedIds: s.failedIds };
}

export class EvalConfigError extends Error {
  override name = 'EvalConfigError';
}

/** 정해진 값이 아니면 던진다(오타로 시험을 몰래 건너뛰지 않게). */
export function suitesFrom(env: Record<string, string | undefined>): Wanted[] {
  if (!env.EVAL_SUITES) return [...SUITES];
  const names = env.EVAL_SUITES.split(',').map((x) => x.trim());
  const known: readonly string[] = [...SUITES, COMPARE];
  for (const n of names)
    if (!known.includes(n))
      throw new EvalConfigError(
        `EVAL_SUITES에 모르는 시험 '${n}'. 쓸 수 있는 값: ${known.join(', ')}`,
      );
  return names as Wanted[];
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
  /** 테스트용: AI를 직접 넣는다(EVAL_LLM 대신) */
  inject?: { llm: Llm },
): Promise<{
  results: Results;
  label: string;
  stats?: Record<string, number>;
  compare?: ModeComparison | { skipped: string };
}> {
  const only = suitesFrom(env);
  const want = (n: Wanted) => only.includes(n);
  const { llm, label, stats, cleanup } = inject
    ? { llm: inject.llm, label: 'injected', stats: undefined, cleanup: undefined }
    : pickLlm(env);
  try {
    const results: Results = {};
    const noLlm = 'EVAL_LLM이 없어 실제 AI 시험을 건너뜀';
    if (want('matching')) results.matching = await runMatching();
    if (want('parse'))
      results.parse = llm ? await runParse(llm) : { score: 0, cases: 0, skipped: noLlm };
    if (want('recommend'))
      results.recommend = llm ? await runRecommend(llm) : { score: 0, cases: 0, skipped: noLlm };
    if (want('recommend-precomputed'))
      results['recommend-precomputed'] = await runRecommendPrecomputed();
    let compare: ModeComparison | { skipped: string } | undefined;
    if (want(COMPARE)) {
      if (!llm) compare = { skipped: noLlm };
      else {
        // 이미 잰 결과가 있으면 다시 쓰지 않는다(AI 호출을 두 번 하지 않게)
        const pre = results['recommend-precomputed'] ?? (await runRecommendPrecomputed());
        const ai = results.recommend ?? (await runRecommend(llm));
        compare = compareModes(pre, ai);
      }
    }
    return {
      results,
      label,
      ...(stats ? { stats: stats() } : {}),
      ...(compare ? { compare } : {}),
    };
  } finally {
    cleanup?.();
  }
}

export const TOLERANCE: Record<SuiteName, number> = {
  matching: 0, // 결정적: 1문제라도 떨어지면 실패
  parse: 0.05, // 실제 AI라 같은 입력에도 답이 조금씩 다를 수 있음(20문항 중 1문항)
  recommend: 0.05,
  'recommend-precomputed': 0, // 결정적
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
        llm: name === 'matching' || name === 'recommend-precomputed' ? 'none' : label,
        measuredAt: now.toISOString(),
      };
  }
  return { ...prev, suites };
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  baselinePath = join(DIR, 'baseline.json'),
): Promise<number> {
  const { results, label, stats, compare } = await runAll(env);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const { ok, lines } = compareToBaseline(results, baseline);
  console.log(`[eval] AI: ${label}`);
  for (const l of lines) console.log(`[eval] ${l}`);
  if (compare) {
    if ('skipped' in compare) console.log(`[eval] ${COMPARE}: 건너뜀 (${compare.skipped})`);
    else {
      console.log(`[eval] ${COMPARE} (${compare.cases}문제)`);
      console.log(`[eval]   precomputed ${compare.precomputed}  |  ai ${compare.ai}`);
      console.log(
        `[eval]   차이 ${compare.diff >= 0 ? '+' : ''}${compare.diff} (기준 ${MODE_MARGIN} 넘으면 ai) → 기본: ${compare.choice}`,
      );
    }
  }
  if (stats) console.log('[eval] 호출 기록', stats);
  console.log(JSON.stringify(results, null, 2));
  if (env.EVAL_UPDATE_BASELINE === '1' && Object.keys(results).length === 0) {
    console.log('[eval] 기준 비교 시험을 재지 않아 baseline.json은 그대로입니다.');
    return 0;
  }
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
