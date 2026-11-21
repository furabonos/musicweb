import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hook = join(resolve(__dirname, '..'), '.claude/hooks/guard-git.sh');
// 훅 우회용 변수 이름은 이 파일을 다루는 명령이 훅에 걸리지 않게 실행 중에 만든다.
const SKIP = 'SKIP_' + 'SIMPLE_GIT_HOOKS';
const RC = 'SIMPLE_GIT_' + 'HOOKS_RC';

function run(command: string, branch = 'feature-x') {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return spawnSync(hook, [], {
    input,
    encoding: 'utf8',
    env: { ...process.env, GUARD_GIT_CURRENT_BRANCH: branch },
  });
}

describe('Claude PreToolUse 훅: 위험한 git 명령 차단', () => {
  it.each([
    // main 직접 push
    'git push origin main',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push origin feature:heads/main',
    'cd /tmp && git push origin main',
    'git push origin --delete main',
    'git push origin --del main',
    // 감싸는 명령·경로
    'env git push origin main',
    'command git push origin main',
    'sudo git push origin main',
    '/usr/bin/git push origin main',
    'bash -c "git push origin main"',
    "sh -c 'git commit -n -m x'",
    'eval "git push origin main"',
    // --no-verify (줄여 쓴 형태, 감싼 형태 포함)
    'git push --no-verify origin t01',
    'git push --no-veri origin t01',
    'git commit --no-verify -m x',
    'git commit --no-verif -m x',
    'echo hi; `git commit --no-verify -m x`',
    'git commit -n -m x',
    'git commit -am x -n',
    'git commit -nm x',
    // 강제 push
    'git push --force origin t01',
    'git push --force-w origin t01',
    'git push --force-with-lease origin t01',
    'git push -f origin t01',
    'git push origin +t01',
    'git push --mirror origin',
    'git push --all origin',
    // 훅 경로·환경 변수
    'git -c core.hooksPath=/dev/null commit -m x',
    'git config core.hooksPath /tmp',
    'git config --unset core.hooksPath',
    `${SKIP}=1 git commit -m x`,
    `export ${SKIP}=1 && git push origin t01`,
    `${RC}=/tmp/rc git commit -m x`,
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
  ])('막는다: %s', (command) => {
    const r = run(command);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('[guard-git] 차단');
  });

  it.each(['git push', 'git push origin', 'git push -u origin HEAD'])(
    'main 브랜치에서 대상 없이 push하면 막는다: %s',
    (command) => {
      expect(run(command, 'main').status).toBe(2);
    },
  );

  it.each([
    'git push -u origin t01-guards',
    'git push origin HEAD',
    'git commit -m "fix: main 화면 문구 수정"',
    'git commit -m"note about n"',
    'git commit -F msg.txt',
    'git commit -C HEAD~1',
    'git status',
    'git log --oneline -n 5',
    'echo "git push origin main 은 금지"',
    'pnpm test',
    'git push origin maintenance',
    'git config --get core.hooksPath',
    'git config --get core.hooksPath ".*"',
    'git config --get-all core.hooksPath tools',
    'git config --list',
    'git config get core.hooksPath',
    `grep -rn ${SKIP} .`,
    'grep -n "no-verify" docs/DECISIONS.md',
  ])('허용한다: %s', (command) => {
    const r = run(command);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('Bash가 아닌 도구 입력은 그대로 통과', () => {
    const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    expect(spawnSync(hook, [], { input, encoding: 'utf8' }).status).toBe(0);
  });
});
