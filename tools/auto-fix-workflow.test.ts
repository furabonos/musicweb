import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTO_FIX_LABEL } from './auto-fix-gate.ts';

/** 자동 수정 워크플로 설정 검사 (SPEC 4.9, T20, D-038). YAML 해석기 없이 글자로 확인한다. */
const raw = readFileSync('.github/workflows/auto-fix.yml', 'utf8');
const wf = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const jobsPart = wf.slice(wf.indexOf('\njobs:'));
const fixJob = jobsPart.slice(jobsPart.indexOf('\n  fix:'));

/** `run:` 한 줄 또는 `run: |` 여러 줄 블록 */
function runBlocks(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    const [, lead = '', rest = ''] = m;
    if (!/^[|>]/.test(rest)) return void out.push(rest);
    const indent = lead.length;
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    out.push(body.join('\n'));
  });
  return out;
}
const gateJob = jobsPart.slice(jobsPart.indexOf('\n  gate:'), jobsPart.indexOf('\n  fix:'));

describe('auto-fix.yml', () => {
  it('이슈에 라벨이 붙을 때만 실행(댓글·PR 이벤트, pull_request_target 없음)', () => {
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    expect(on).toMatch(/issues:\n\s+types: \[labeled\]/);
    for (const ev of ['issue_comment', 'pull_request', 'pull_request_target', 'workflow_run']) {
      expect(on, `${ev} 이벤트로 실행하지 마세요`).not.toContain(ev);
    }
    expect(gateJob).toContain(`github.event.label.name == '${AUTO_FIX_LABEL}'`);
  });

  it('수정 job은 관문을 통과했을 때만 돈다', () => {
    expect(fixJob).toMatch(/needs: gate/);
    expect(fixJob).toContain("if: needs.gate.outputs.allowed == 'true'");
    expect(gateJob).toContain('tools/auto-fix-gate.ts');
  });

  it('관문만 한 번에 하나씩(상한을 정확히 세려고). 워크플로 전체를 묶으면 다른 라벨 실행이 대기 중 auto-fix를 취소한다', () => {
    const top = wf.slice(0, wf.indexOf('\njobs:'));
    expect(top).not.toContain('concurrency:');
    expect(gateJob).toMatch(/concurrency:\n\s+group: auto-fix-gate\n\s+cancel-in-progress: false/);
    expect(fixJob).not.toContain('concurrency:');
  });

  it('구독 토큰만 쓴다: API 키 입력 없음, 비밀값은 수정 job의 액션에만', () => {
    expect(fixJob).toContain('claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(wf).not.toContain('anthropic_api_key');
    expect(wf).not.toContain('ANTHROPIC_API_KEY');
    // 관문에는 "있는지"만 넘긴다(값은 넘기지 않음)
    expect(gateJob).toContain("secrets.CLAUDE_CODE_OAUTH_TOKEN != ''");
    expect(gateJob).not.toContain('claude_code_oauth_token:');
  });

  it('자동 합침 없음', () => {
    for (const s of ['gh pr merge', '--auto', 'enable-auto-merge', 'merge_method']) {
      expect(wf, `'${s}': 자동 수정 PR은 관리자가 확인하고 합칩니다`).not.toContain(s);
    }
  });

  it('위험한 액션 옵션을 켜지 않는다', () => {
    for (const s of [
      'allowed_bots',
      'allowed_non_write_users',
      'allow_fork_prs',
      'show_full_output',
    ]) {
      expect(wf, `${s}는 공개 저장소에서 남이 Claude를 부를 길을 엽니다`).not.toContain(s);
    }
    expect(wf).not.toContain('--dangerously-skip-permissions');
    // 이슈 댓글은 저장소 주인 것만 Claude에게 보인다
    expect(fixJob).toContain('include_comments_by_actor: ${{ github.repository_owner }}');
  });

  it('기본 권한은 읽기, 쓰기 권한은 job마다 필요한 만큼만', () => {
    expect(wf).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(gateJob).toMatch(/permissions:\n\s+actions: read\n\s+issues: write\n\s+contents: read/);
    expect(gateJob).not.toMatch(/contents: write|pull-requests: write|id-token/);
  });

  it('PR은 관리자가 링크로 만든다: main 판 검사 도구로 막힌 경로 확인·자리 표시 채우기·검사 후 링크 댓글', () => {
    expect(fixJob).toContain('git show origin/main:tools/pr-body.ts');
    for (const sub of ['guard', 'fill', 'check', 'link']) expect(fixJob).toContain(`pb ${sub} `);
    expect(fixJob).toContain('gh issue comment');
    // 앱 토큰은 액션이 끝날 때 회수되고, 기본 토큰으로 만든 PR에는 CI가 돌지 않는다
    expect(fixJob).not.toContain('gh pr create');
    expect(fixJob).not.toContain('steps.claude.outputs.github_token');
  });

  it('수정 job의 checkout은 기본 토큰을 남기지 않는다', () => {
    expect(fixJob).toMatch(/fetch-depth: 0\n\s+(#.*\n\s+)?persist-credentials: false/);
  });

  it('run 블록에 ${{ }} 값을 바로 끼우지 않는다(이슈 제목·브랜치 이름 같은 값은 env로)', () => {
    for (const block of runBlocks(raw)) {
      expect(block, `run 블록 안의 \${{ }}를 env 변수로 옮기세요:\n${block}`).not.toContain('${{');
    }
  });
});

describe('runBlocks', () => {
  it('여러 줄 run 블록 안의 값도 찾는다', () => {
    const y =
      'steps:\n  - run: |\n      echo ok\n      echo ${{ github.event.issue.title }}\n  - run: echo b\n';
    expect(runBlocks(y)).toEqual([
      '      echo ok\n      echo ${{ github.event.issue.title }}',
      'echo b',
    ]);
  });
});

describe('ci.yml의 run 블록', () => {
  it('${{ }} 값을 바로 끼우지 않는다', () => {
    for (const block of runBlocks(readFileSync('.github/workflows/ci.yml', 'utf8'))) {
      expect(block).not.toContain('${{');
    }
  });
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  it('PR 본문 검사는 이벤트의 옛 본문이 아니라 지금 본문을 읽는다(본문만 고치면 그 job만 다시)', () => {
    expect(ci).toContain('tools/pr-body.ts check');
    expect(ci).toContain('gh pr view "$PR" --json body');
    expect(ci).not.toContain('github.event.pull_request.body');
    // 본문 수정(edited)으로 무거운 검사 전체를 다시 돌리지 않는다
    expect(ci).not.toMatch(/types:.*edited/);
  });
  it('화면이 바뀐 PR은 CI가 수정 전후 캡처를 찍어 올린다', () => {
    expect(ci).toContain('tools/pr-body.ts screen');
    expect(ci).toContain('pnpm capture:after');
    expect(ci).toContain('CAPTURE_LABEL: before');
    expect(ci).toContain('name: screen-captures');
  });
});
