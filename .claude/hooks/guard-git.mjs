// PreToolUse 훅(Bash): main 직접 push, 강제 push, 훅 건너뛰기(--no-verify, 훅 경로·환경 변수 조작)를 막는다.
// 막으면 exit 2 + stderr 안내(Claude에게 전달). 이 훅은 실수를 줄이는 1차 방어이고,
// 최종 방어선은 GitHub main 보호 규칙과 CI 비밀값 검사다 (D-017).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROTECTED = 'main';

// 훅·설정을 끄는 환경 변수 "대입"(NAME=값, export NAME=값). 이름만 나오는 grep 등은 막지 않는다.
const HOOK_ENV_NAMES =
  'SKIP_SIMPLE_GIT_HOOKS|SIMPLE_GIT_HOOKS_RC|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\\d+|GIT_CONFIG_VALUE_\\d+';
const RAW_RULES = [
  {
    test: new RegExp(`(^|[\\s;&|(\`'"])(${HOOK_ENV_NAMES})=`),
    reason:
      '환경 변수(SKIP_SIMPLE_GIT_HOOKS, SIMPLE_GIT_HOOKS_RC, GIT_CONFIG_*)로 git 훅이나 설정을 바꿀 수 없습니다. 검사에 걸린 원인을 고치세요.',
  },
  {
    // bash -c, eval, 백틱 안의 --no-verify(및 줄여 쓴 --no-veri 등)도 잡기 위해 문자열 기준으로 본다.
    test: /\bgit\b[^\n;&|]*\s--no-ve/,
    reason:
      '--no-verify는 비밀값·push 검사를 건너뛰므로 쓸 수 없습니다. 검사에 걸린 값을 지우고 다시 하세요.',
  },
];

const WRAPPERS = new Set(['env', 'command', 'time', 'sudo', 'nice', 'nohup', 'exec', '{', '!']);
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_VALUE_LONG = new Set([
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--trailer',
  '--cleanup',
  '--pathspec-from-file',
]);
const CONFIG_READ = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--list',
  '-l',
  'get',
  'list',
  '--show-origin',
  '--show-scope',
]);
const CONFIG_WRITE = new Set([
  '--unset',
  '--unset-all',
  'unset',
  'set',
  '--add',
  '--replace-all',
  'edit',
  '-e',
  '--edit',
]);

/** 셸 명령을 따옴표를 고려해 단어로 나누고, ; && || | & ( ) 줄바꿈으로 구간을 나눈다. */
export function splitSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const pushWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      pushWord();
    } else if (';\n|&()`'.includes(c)) {
      pushSegment();
    } else {
      word += c;
      inWord = true;
    }
  }
  pushSegment();
  return segments;
}

/** sh|bash|zsh -c "…" 와 eval "…" 의 인자도 다시 나눠 검사 대상에 넣는다. */
export function expandShellC(segments, depth = 0) {
  if (depth > 3) return segments;
  const out = [];
  for (const words of segments) {
    out.push(words);
    const shellIdx = words.findIndex(
      (w, idx) => /(^|\/)(sh|bash|zsh)$/.test(w) && words[idx + 1] === '-c',
    );
    const inner = shellIdx !== -1 ? words[shellIdx + 2] : undefined;
    if (inner) out.push(...expandShellC(splitSegments(inner), depth + 1));
    const evalIdx = words.indexOf('eval');
    if (evalIdx !== -1 && words.length > evalIdx + 1) {
      out.push(...expandShellC(splitSegments(words.slice(evalIdx + 1).join(' ')), depth + 1));
    }
  }
  return out;
}

function isGitWord(w) {
  return w === 'git' || w.endsWith('/git');
}

function isMainRef(ref, currentBranch) {
  const name = ref === 'HEAD' ? currentBranch : ref;
  return name === PROTECTED || name === `refs/heads/${PROTECTED}` || name === `heads/${PROTECTED}`;
}

/** git commit 인자에 -n(--no-verify의 짧은 형태)이 있는지. -m"note" 같은 값은 건너뛴다. */
function commitHasShortNoVerify(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') return false;
    if (COMMIT_VALUE_LONG.has(a)) {
      j++;
      continue;
    }
    if (a.startsWith('--') || !/^-[a-zA-Z]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === 'n') return true;
      if (COMMIT_VALUE_SHORT.has(ch)) {
        if (k === a.length - 1) j++; // 값이 다음 단어
        break; // 같은 단어의 나머지는 값
      }
    }
  }
  return false;
}

/** git config 호출이 core.hooksPath 값을 바꾸는지 (읽기는 허용). */
function configWritesHooksPath(args) {
  const keyIndex = args.findIndex((a) => /^core\.hookspath$/i.test(a));
  if (keyIndex === -1) return false;
  const before = args.slice(0, keyIndex);
  if (before.some((a) => CONFIG_READ.has(a))) return false;
  if (before.some((a) => CONFIG_WRITE.has(a))) return true;
  return keyIndex < args.length - 1; // 키 뒤에 값이 있으면 쓰기
}

/** git 명령 한 구간을 보고 막을 이유를 돌려준다. 문제없으면 null. */
export function checkGit(words, currentBranch) {
  let i = 0;
  // 앞의 환경 변수 대입과 감싸는 명령(env, command, sudo, time …)은 건너뛴다.
  while (
    i < words.length &&
    (WRAPPERS.has(words[i]) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
      (words[i - 1] === 'env' && words[i].startsWith('-')))
  ) {
    i++;
  }
  if (i >= words.length || !isGitWord(words[i])) return null;
  i++;
  // git 전역 옵션
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (opt === '-c' || opt === '-C' || opt === '--git-dir' || opt === '--work-tree') {
      const value = words[i + 1] ?? '';
      if (opt === '-c' && /^core\.hookspath=/i.test(value)) {
        return '훅 경로(core.hooksPath)를 바꿔 훅을 건너뛸 수 없습니다.';
      }
      i += 2;
    } else {
      if (/^-ccore\.hookspath=/i.test(opt) || /^--config-env=core\.hookspath/i.test(opt)) {
        return '훅 경로(core.hooksPath)를 바꿔 훅을 건너뛸 수 없습니다.';
      }
      i++;
    }
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  if (sub === 'config' && configWritesHooksPath(args)) {
    return '훅 경로(core.hooksPath)를 바꿀 수 없습니다. 훅은 simple-git-hooks로 설치됩니다(pnpm install).';
  }
  if (sub === 'commit') {
    if (args.some((a) => a.startsWith('--no-ve')) || commitHasShortNoVerify(args)) {
      return 'git commit --no-verify(-n)는 비밀값 검사를 건너뛰므로 쓸 수 없습니다. 검사에 걸린 값을 지우고 다시 커밋하세요.';
    }
    return null;
  }
  if (sub !== 'push') return null;

  const positional = [];
  let deleting = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a.startsWith('--no-ve')) {
      return 'git push --no-verify는 push 전 검사를 건너뛰므로 쓸 수 없습니다.';
    }
    if (/^--(fo|mir|all$|pru)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) {
      return `git push ${a}는 원격 기록을 덮어쓰거나 여러 브랜치를 한꺼번에 바꿀 수 있어 쓸 수 없습니다. 새 커밋으로 고쳐서 push하세요.`;
    }
    if (/^--del/.test(a) || a === '-d') {
      deleting = true;
      continue;
    }
    if (['--repo', '-o', '--push-option', '--receive-pack', '--exec'].includes(a)) {
      j++;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) {
    return '+ 로 시작하는 refspec은 강제 push라 쓸 수 없습니다.';
  }
  const targets = refspecs.length
    ? refspecs.map((r) => (r.includes(':') ? r.slice(r.indexOf(':') + 1) : r))
    : [currentBranch];
  if (targets.some((t) => isMainRef(t, currentBranch))) {
    return deleting
      ? 'main 브랜치는 지울 수 없습니다.'
      : 'main에 직접 push할 수 없습니다. 작업 브랜치를 만들어(git switch -c <이름>) 그 브랜치를 push하고 PR을 여세요.';
  }
  return null;
}

/** 명령 전체를 보고 막을 이유를 돌려준다. 문제없으면 null. */
export function check(command, currentBranch) {
  for (const rule of RAW_RULES) {
    if (rule.test.test(command)) return rule.reason;
  }
  for (const words of expandShellC(splitSegments(command))) {
    const reason = checkGit(words, currentBranch);
    if (reason) return reason;
  }
  return null;
}

function currentBranchOf(cwd) {
  if (process.env.GUARD_GIT_CURRENT_BRANCH) return process.env.GUARD_GIT_CURRENT_BRANCH;
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // 형식을 모르는 입력은 판단하지 않는다 (최종 방어선은 GitHub 보호)
  }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || typeof command !== 'string') return 0;
  const reason = check(command, currentBranchOf(input.cwd || process.cwd()));
  if (reason) {
    process.stderr.write(`[guard-git] 차단: ${reason}\n명령: ${command}\n`);
    return 2;
  }
  return 0;
}

process.exitCode = main();
