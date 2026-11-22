/**
 * 시험용 AI 호출: 이 컴퓨터의 Claude Code(구독 로그인)로 Haiku를 부른다 (T17, D-034).
 * - 사용자가 API 키 없이 구독으로 검증하기로 함. 개인 개발용 검증에만 쓴다(서비스·CI·서버에는 쓰지 않음).
 * - 서비스의 AI 호출(functions/src/adapters/llm.ts)과 같은 지시문·데이터 형식·답 형식(JSON 스키마)을 쓰되,
 *   Claude Code를 거치므로 똑같지는 않다: 생각 단계가 켜질 수 있고, 출력 길이 상한(maxTokens)은 적용되지 않는다.
 * - 도구 없이(--tools ""), 설정 파일·MCP·명령 없이, 프로젝트 밖의 빈 폴더에서 실행한다(프로젝트 CLAUDE.md를 읽지 않게).
 *   구독 로그인은 --bare(API 키 전용)를 쓸 수 없어서, 사용자 전역 설정(~/.claude/CLAUDE.md 등)이 끼는지는 보장하지 못한다.
 * - 셸의 ANTHROPIC_API_KEY는 넘기지 않는다(구독 대신 API로 과금되지 않게).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataMessage, LLM_MODEL, type Llm } from '../functions/src/adapters/llm.js';

export interface CliStats {
  calls: number;
  failures: number;
  /** Claude Code가 알려 준 정가 기준 비용(구독은 따로 청구되지 않고 사용량 한도에서 깎임) */
  listCostMicroUsd: number;
}

export function cliArgs(
  system: string,
  schema: Record<string, unknown>,
  model = LLM_MODEL,
): string[] {
  return [
    '-p',
    '--model',
    model,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--system-prompt',
    system,
    '--json-schema',
    JSON.stringify(schema),
  ];
}

/** Claude Code 출력(JSON 한 줄)에서 구조화 답을 꺼낸다. 오류·형식 밖이면 null. */
export function parseCliOutput(stdout: string): { value: unknown; costUsd: number } {
  let out: { is_error?: boolean; structured_output?: unknown; total_cost_usd?: number };
  try {
    out = JSON.parse(stdout) as typeof out;
  } catch {
    return { value: null, costUsd: 0 };
  }
  const costUsd = typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0;
  if (out.is_error || out.structured_output === undefined) return { value: null, costUsd };
  return { value: out.structured_output, costUsd };
}

/** 자식 프로세스 환경: API 키는 뺀다 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  return out;
}

export function createCliLlm(opts: { bin?: string; timeoutMs?: number } = {}): {
  llm: Llm;
  stats: CliStats;
  cleanup(): void;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'musicweb-eval-'));
  const stats: CliStats = { calls: 0, failures: 0, listCostMicroUsd: 0 };
  const llm: Llm = {
    structured: (req) =>
      new Promise((resolve, reject) => {
        stats.calls++;
        const child = spawn(opts.bin ?? 'claude', cliArgs(req.system, req.schema), {
          cwd,
          env: childEnv(process.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        // 시간이 넘으면 끄고, 그래도 안 끝나면 5초 뒤 강제로 끈다
        let kill: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
        }, opts.timeoutMs ?? 90_000);
        const stop = () => {
          clearTimeout(timer);
          if (kill) clearTimeout(kill);
        };
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) => {
          stop();
          reject(err);
        });
        // claude가 없거나 일찍 끝나면 입력 쓰기가 EPIPE를 낸다: 'close'·'error'에서 처리하므로 여기서는 무시
        child.stdin.on('error', () => {});
        child.on('close', (code) => {
          stop();
          const { value, costUsd } = parseCliOutput(stdout);
          stats.listCostMicroUsd += Math.round(costUsd * 1_000_000);
          if (code !== 0 && value === null) {
            stats.failures++;
            // 서비스 어댑터가 호출 실패를 던지는 것과 맞춘다
            reject(new Error(`claude 실행 실패(code ${code}): ${stderr.slice(0, 200)}`));
            return;
          }
          if (value === null) stats.failures++;
          resolve(value);
        });
        child.stdin.end(dataMessage(req.input));
      }),
  };
  return { llm, stats, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
