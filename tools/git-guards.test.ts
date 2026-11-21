import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 가짜 키는 실행 중에 이어 붙여 만든다. 이 파일 자체가 비밀값 검사에 걸리지 않게 하기 위함.
const FAKE = {
  googleApiKey: 'AI' + 'za' + 'SyD' + 'x7Qm2Lp9Rk4Tz8Vb1Nw3Hc6Jf0Gs5AyQ',
  anthropicKey: 'sk-' + 'ant-' + 'api03-' + 'Zq8Xw2Vu4Ts6Rq8Po0Nm2Lk4Ji6Hg8Fe0Dc2Ba4Zy6Xw8Vu0Ts',
  githubToken: 'gh' + 'p_' + 'R4nD0mT0k3nV4lu3F0rT3st1ngPurp0s3s0nly',
  privateKey:
    '-----BEGIN ' +
    'RSA PRIVATE KEY-----\n' +
    'MIIEowIBAAKCAQEA' +
    'x'.repeat(60) +
    '\n-----END ' +
    'RSA PRIVATE KEY-----\n',
};

const root = resolve(__dirname, '..');
const preCommit = join(root, 'tools/git-hooks/pre-commit.sh');
const prePush = join(root, 'tools/git-hooks/pre-push.sh');

let repo: string;

// 개인 전역 git 설정(core.hooksPath, 템플릿 등)이 결과를 바꾸지 않게 막는다.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const BLOCKED = '비밀값으로 보이는';

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env });
}

function tryCommit(message = 'test') {
  return spawnSync('git', ['commit', '-m', message], { cwd: repo, encoding: 'utf8', env });
}

function commit(file: string, content: string) {
  writeFileSync(join(repo, file), content);
  git('add', file);
  return tryCommit();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'musicweb-guard-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.git/hooks/pre-commit'), `#!/bin/sh\nexec "${preCommit}"\n`, {
    mode: 0o755,
  });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('pre-commit: 비밀값 커밋 차단', () => {
  it.each(Object.entries(FAKE))('%s가 든 파일 커밋은 거부한다', (_name, secret) => {
    const r = commit('config.ts', `export const value = '${secret}';\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
    expect(() => git('rev-parse', 'HEAD')).toThrow(); // 커밋이 생기지 않음
  });

  it.each([
    '.env',
    '.env.local',
    'apps/web/.env.production',
    'functions/.secret.local',
    'key.pem',
    'server.key',
    'firebase-serviceAccount.json',
  ])('비밀 파일 이름(%s)은 내용과 상관없이 거부한다', (file) => {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    if (dir) execFileSync('mkdir', ['-p', join(repo, dir)]);
    writeFileSync(join(repo, file), 'HELLO=1\n');
    git('add', '-f', file);
    const r = tryCommit();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('.env.example 같은 예시 파일은 통과한다', () => {
    expect(commit('.env.example', 'VITE_FIREBASE_API_KEY=\n').status).toBe(0);
  });

  it('평범한 파일은 통과한다', () => {
    const r = commit('hello.ts', "export const hello = 'world';\n");
    expect(r.status).toBe(0);
    expect(git('log', '--oneline').trim()).toContain('test');
  });

  it('작업 폴더가 아니라 스테이징된 내용을 검사한다', () => {
    writeFileSync(join(repo, 'a.ts'), `export const k = '${FAKE.googleApiKey}';\n`);
    git('add', 'a.ts');
    writeFileSync(join(repo, 'a.ts'), 'export const k = 1;\n'); // 작업 폴더는 깨끗하게 바꿈
    const r = tryCommit();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('같은 커밋의 .gitignore 변경이 강제 추가한 비밀 파일 검사를 빼지 못한다', () => {
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, '.env'), 'HELLO=1\n');
    git('add', '.gitignore');
    git('add', '-f', '.env');
    const r = tryCommit();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('같은 커밋의 하위 .secretlintignore가 검사를 빼지 못한다', () => {
    execFileSync('mkdir', ['-p', join(repo, 'sub')]);
    writeFileSync(join(repo, 'sub/.secretlintignore'), '*\n');
    writeFileSync(join(repo, 'sub/config.ts'), `export const k = '${FAKE.googleApiKey}';\n`);
    git('add', 'sub');
    const r = tryCommit();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('파일 이름에 공백이 있어도 검사한다', () => {
    const r = commit('my config.ts', `export const k = '${FAKE.anthropicKey}';\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('삭제만 있는 커밋은 통과한다', () => {
    expect(commit('x.ts', 'export const x = 1;\n').status).toBe(0);
    git('rm', '-q', 'x.ts');
    const r = tryCommit('rm');
    expect(r.status).toBe(0);
  });
});

describe('pre-push: main 직접 push 차단', () => {
  const zero = '0'.repeat(40);
  const sha = 'a'.repeat(40);
  const run = (stdin: string) =>
    spawnSync(prePush, ['origin', 'https://example.com/r.git'], {
      input: stdin,
      encoding: 'utf8',
      env,
    });

  it('main 대상 push는 거부한다', () => {
    const r = run(`refs/heads/main ${sha} refs/heads/main ${zero}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('브랜치');
  });

  it('다른 로컬 브랜치를 main으로 보내는 것도 거부한다', () => {
    expect(run(`refs/heads/feature ${sha} refs/heads/main ${zero}\n`).status).not.toBe(0);
  });

  it('여러 ref 중 하나라도 main이면 거부한다', () => {
    const stdin = `refs/heads/a ${sha} refs/heads/a ${zero}\nrefs/heads/main ${sha} refs/heads/main ${zero}\n`;
    expect(run(stdin).status).not.toBe(0);
  });

  it('다른 브랜치 push는 통과한다', () => {
    expect(run(`refs/heads/t01-guards ${sha} refs/heads/t01-guards ${zero}\n`).status).toBe(0);
    expect(run(`refs/heads/main ${sha} refs/heads/maintenance ${zero}\n`).status).toBe(0);
  });

  it('태그 push는 통과한다', () => {
    expect(run(`refs/tags/v1 ${sha} refs/tags/v1 ${zero}\n`).status).toBe(0);
  });
});
