import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** CI 설정 검사 (T18, D-036). YAML 해석기 없이 글자로 확인한다. */
const DIR = '.github/workflows';
const raw = readFileSync(join(DIR, 'ci.yml'), 'utf8');
/** 주석 줄을 뺀 본문 */
const ci = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const jobsPart = ci.slice(ci.indexOf('\njobs:'));

describe('ci.yml', () => {
  it('모든 검사를 돈다: lint·format·typecheck·unit·eval·번들·rules·integration·e2e', () => {
    for (const cmd of [
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm format:check',
      'pnpm typecheck',
      'pnpm test',
      'pnpm eval',
      'pnpm scan:bundle',
      'pnpm test:rules',
      'pnpm test:int',
      'pnpm test:e2e',
    ]) {
      // 줄 전체가 같아야 한다('run: pnpm test'가 'run: pnpm test:e2e'에 걸리지 않게)
      const lines = ci.split('\n').map((l) => l.trim().replace(/^- /, ''));
      expect(lines, `ci.yml에 'run: ${cmd}' 단계가 없습니다`).toContain(`run: ${cmd}`);
    }
  });

  it('필수 검사 job "ci"는 다른 모든 job을 기다리고, 하나라도 성공이 아니면 실패', () => {
    const jobs = [...jobsPart.matchAll(/^ {2}([a-z0-9_-]+):\n/gm)].map((m) => m[1]);
    expect(jobs).toContain('ci');
    const others = jobs.filter((j) => j !== 'ci');
    const needs = /needs: \[([^\]]+)\]/
      .exec(jobsPart.slice(jobsPart.indexOf('\n  ci:')))?.[1]
      ?.split(/,\s*/);
    expect(needs?.sort(), '"ci" job의 needs에 모든 job을 넣으세요').toEqual(others.sort());
    expect(ci).toMatch(/if: always\(\)/);
    expect(ci).toContain('if [ "$r" != "success" ]');
  });

  it('포크 PR에 비밀값을 주지 않는다: pull_request_target 금지, AI 키는 같은 저장소일 때만, 구독(cli) 금지', () => {
    expect(ci).not.toContain('pull_request_target');
    const keyLines = ci.split('\n').filter((l) => l.includes('ANTHROPIC_API_KEY'));
    expect(keyLines.length).toBeGreaterThan(0);
    // 키를 쓰는 줄은 모두 "같은 저장소의 PR"일 때만(포크 PR·main push 제외, SPEC 4.9)
    for (const l of keyLines) {
      expect(l).toContain("github.event_name == 'pull_request'");
      expect(l).toContain('head.repo.full_name == github.repository');
    }
    expect(ci).not.toMatch(/EVAL_LLM:\s*['"]?cli/);
    expect(ci).not.toMatch(/'cli'/);
  });

  it('main에 합친 커밋의 CI는 취소하지 않는다(PR만 앞 실행 취소)', () => {
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('권한은 읽기만', () => {
    expect(ci).toMatch(/permissions:\n {2}contents: read/);
    expect(ci).not.toMatch(/: write/);
  });
});

describe('모든 워크플로', () => {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  it.each(files)('%s: 외부 액션은 커밋 해시(40자)로 고정', (f) => {
    const text = readFileSync(join(DIR, f), 'utf8');
    for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      expect(m[1], `${f}: '${m[1]}'을 @<40자 커밋 해시> # vX.Y.Z 형태로 고정하세요`).toMatch(
        /@[0-9a-f]{40}$/,
      );
    }
  });
});
