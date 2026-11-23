import { readFileSync, writeFileSync } from 'node:fs';

/**
 * PR 본문 검사기와 자동 수정 도우미 (SPEC 4.9, T20, D-038).
 * - CI(ci.yml의 pr-body job)가 모든 PR의 "지금" 본문을 GitHub에서 읽어 검사한다. 사람이 연 PR도, 자동 수정 PR도 같다.
 * - 화면 파일이 바뀐 PR은 CI(e2e job)가 수정 전후 캡처를 찍어 올린다. 본문에는 이미지, 이 저장소 Actions 캡처 링크,
 *   또는 `CI 캡처 묶음`이라고 쓴다.
 * - 자동 수정 워크플로(auto-fix.yml)는 main 판 이 파일로 캡처 링크를 채우고(fill), 막힌 경로를 확인하고(guard),
 *   미리 채운 PR 만들기 링크를 만든다(link).
 *
 * 쓰는 법 (node --experimental-strip-types tools/pr-body.ts …):
 *   check --body-file f [--changed-files f]   본문 검사. 바뀐 파일 목록은 한 줄에 하나. 저장소는 GITHUB_REPOSITORY
 *   screen --changed-files f                  화면이 바뀌었으면 true, 아니면 false 출력
 *   fill --body-file f --url <캡처 링크>       자리 표시 {{CAPTURES_URL}} 채우기
 *   guard --changed-files f                   자동 수정이 고치면 안 되는 경로가 있으면 목록 출력, 종료 코드 1
 *   link --branch b --title-file f --body-file f   미리 채운 PR 만들기 링크 출력
 */
export const SECTIONS = {
  summary: '쉬운 말 요약',
  captures: '화면 캡처',
  scores: '테스트·시험 점수 변화',
  howToCheck: '확인 방법',
} as const;

/** 자동 수정 PR 본문에서 캡처 묶음 링크가 들어갈 자리 */
export const CAPTURES_PLACEHOLDER = '{{CAPTURES_URL}}';
/** 화면이 바뀐 PR에서 CI(e2e job)가 올리는 캡처 묶음을 가리키는 말 */
export const CI_CAPTURES = 'CI 캡처 묶음';

const SUMMARY_LINES = 3;
const IMAGE = /!\[[^\]]*\]\([^)]+\)|<img\s/i;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Actions 실행의 캡처 묶음(artifact) 링크. repo를 주면 그 저장소만 */
const artifactUrl = (repo?: string) =>
  new RegExp(
    `https://github\\.com/${repo ? escape(repo) : '[\\w.-]+/[\\w.-]+'}/actions/runs/\\d+/artifacts/\\d+`,
  );

/** 화면이 바뀌는 파일인가 (테스트·테스트 도우미·타입 선언 제외) */
export function changesScreen(files: readonly string[]): boolean {
  return files.some(
    (f) =>
      (f.startsWith('apps/web/src/') &&
        !/\.test\.tsx?$/.test(f) &&
        !/\.d\.ts$/.test(f) &&
        !f.startsWith('apps/web/src/test/') &&
        !/\/setupTests?\.tsx?$/.test(f)) ||
      f === 'apps/web/index.html' ||
      f.startsWith('apps/web/public/'),
  );
}

/** 자동 수정이 고치면 안 되는 경로 (워크플로·Claude 설정·보안 규칙·기준 점수·비밀값 설정) */
const FORBIDDEN = [
  /^\.github\//,
  /^\.claude\//,
  /^CLAUDE\.md$/,
  /^firestore\.rules$/,
  /^storage\.rules$/,
  /^evals\/baseline\.json$/,
  /^\.gitleaksignore$/,
  /^functions\/src\/config\/secrets\.ts$/,
  /^tools\/git-hooks\//,
];
export function forbiddenAutoFixChanges(files: readonly string[]): string[] {
  return files.filter((f) => FORBIDDEN.some((r) => r.test(f)));
}

/** `## 제목` 절마다 본문(주석·코드 블록 밖)을 모은다. 같은 제목이 두 번 나오면 dup에 넣는다. */
function sections(body: string): { found: Map<string, string>; dup: Set<string> } {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
  const found = new Map<string, string>();
  const dup = new Set<string>();
  let current: string | null = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1] ?? '';
      if (found.has(current)) dup.add(current);
      else found.set(current, '');
    } else if (current !== null && !dup.has(current)) {
      found.set(current, `${found.get(current)}${line}\n`);
    }
  }
  return { found, dup };
}

/** 번호·글머리표를 뗀 뒤 글이 있는 줄 (코드 블록 울타리 제외) */
const contentLines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s*/, ''))
    .filter((l) => l.length > 0 && !/^(```|~~~)/.test(l));

/** 빠지거나 잘못된 것을 고치는 방법과 함께 돌려준다. 빈 배열이면 통과. */
export function checkPrBody(
  body: string,
  changedFiles: readonly string[] = [],
  opts: { repo?: string | undefined } = {},
): string[] {
  const errors: string[] = [];
  const { found, dup } = sections(body);
  const get = (title: string) => {
    if (dup.has(title)) {
      errors.push(`'## ${title}' 절이 두 번 있습니다. 하나로 합치세요.`);
      return null;
    }
    const s = found.get(title);
    if (s === undefined) {
      errors.push(
        `'## ${title}' 절이 없습니다. .github/pull_request_template.md의 절 제목을 그대로 쓰세요.`,
      );
      return null;
    }
    if (contentLines(s).length === 0) {
      errors.push(`'${title}' 절이 비어 있습니다. 안내 주석을 지우고 내용을 채우세요.`);
      return null;
    }
    return s;
  };

  const summary = get(SECTIONS.summary);
  if (summary !== null && contentLines(summary).length !== SUMMARY_LINES) {
    errors.push(
      `'${SECTIONS.summary}'는 코드 용어 없이 정확히 ${SUMMARY_LINES}줄로 쓰세요 (지금 ${contentLines(summary).length}줄). ` +
        '1) 무엇을 했나 2) 어디서 어떻게 보이나 3) 다음에 할 일.',
    );
  }

  const captures = get(SECTIONS.captures);
  if (captures !== null) {
    if (captures.includes(CAPTURES_PLACEHOLDER)) {
      errors.push(
        `'${SECTIONS.captures}'에 채우지 않은 자리 표시 ${CAPTURES_PLACEHOLDER}가 남아 있습니다. 캡처 링크로 바꾸거나 '해당 없음'으로 쓰세요.`,
      );
    } else if (
      changesScreen(changedFiles) &&
      !IMAGE.test(captures) &&
      !artifactUrl(opts.repo).test(captures) &&
      !captures.includes(CI_CAPTURES)
    ) {
      errors.push(
        `화면 파일(apps/web/src 등)이 바뀐 PR입니다. '${SECTIONS.captures}'에 수정 전후 캡처 이미지나 ` +
          `이 저장소 Actions 캡처 링크를 넣거나, CI가 찍어 올리는 캡처를 쓰려면 '${CI_CAPTURES}'라고 쓰세요.`,
      );
    }
  }

  get(SECTIONS.scores);
  get(SECTIONS.howToCheck);
  return errors;
}

/** 자리 표시를 Actions 캡처 링크로 바꾼다. 다른 주소는 받지 않는다. */
export function fillCapturesUrl(body: string, url: string, repo?: string): string {
  if (!new RegExp(`^${artifactUrl(repo).source}$`).test(url)) {
    throw new Error(`캡처 링크가 이 저장소 Actions 캡처 묶음 주소가 아닙니다: ${url}`);
  }
  return body.split(CAPTURES_PLACEHOLDER).join(url);
}

/** 주소 길이 한도. 넘으면 본문 없이 링크를 만들고 본문은 따로 붙여 넣게 한다. */
export const MAX_LINK_LENGTH = 8000;

/** 제목·본문을 미리 채운 PR 만들기 링크 (관리자가 눌러 PR을 연다, D-038) */
export function prCreateLink(o: { repo: string; branch: string; title: string; body: string }): {
  url: string;
  bodyIncluded: boolean;
} {
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`저장소 이름이 이상합니다: ${o.repo}`);
  if (!/^[\w./-]+$/.test(o.branch) || o.branch.includes('..')) {
    throw new Error(`브랜치 이름이 이상합니다: ${o.branch}`);
  }
  const title = o.title.split('\n')[0]?.trim().slice(0, 100) ?? '';
  const base = `https://github.com/${o.repo}/compare/main...${o.branch}`;
  const withBody = `${base}?${new URLSearchParams({ quick_pull: '1', title, body: o.body })}`;
  if (withBody.length <= MAX_LINK_LENGTH) return { url: withBody, bodyIncluded: true };
  return { url: `${base}?${new URLSearchParams({ quick_pull: '1', title })}`, bodyIncluded: false };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const readLines = (f: string | undefined) =>
  f
    ? readFileSync(f, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function main(argv: string[], env: NodeJS.ProcessEnv, io: Io): number {
  const [cmd] = argv;
  const bodyFile = arg(argv, '--body-file');
  const changed = readLines(arg(argv, '--changed-files'));
  const repo = env.GITHUB_REPOSITORY || undefined;
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new Error(`${cmd}에는 ${name}이 필요합니다`);
    return v;
  };

  switch (cmd) {
    case 'check': {
      const errors = checkPrBody(readFileSync(need(bodyFile, '--body-file'), 'utf8'), changed, {
        repo,
      });
      if (errors.length) {
        io.err('PR 본문이 템플릿을 따르지 않습니다:');
        for (const e of errors) io.err(`- ${e}`);
        io.err('본문을 고친 뒤 실패한 검사를 다시 실행하세요(gh run rerun <실행 번호> --failed).');
        return 1;
      }
      io.out('PR 본문 검사 통과');
      return 0;
    }
    case 'screen':
      io.out(String(changesScreen(changed)));
      return 0;
    case 'fill': {
      const f = need(bodyFile, '--body-file');
      writeFileSync(
        f,
        fillCapturesUrl(readFileSync(f, 'utf8'), need(arg(argv, '--url'), '--url'), repo),
      );
      return 0;
    }
    case 'guard': {
      const bad = forbiddenAutoFixChanges(changed);
      for (const f of bad) io.out(f);
      return bad.length ? 1 : 0;
    }
    case 'link': {
      const { url, bodyIncluded } = prCreateLink({
        repo: need(repo, 'GITHUB_REPOSITORY'),
        branch: need(arg(argv, '--branch'), '--branch'),
        title: readFileSync(need(arg(argv, '--title-file'), '--title-file'), 'utf8'),
        body: readFileSync(need(bodyFile, '--body-file'), 'utf8'),
      });
      io.out(url);
      if (!bodyIncluded) io.err('본문이 길어 링크에 넣지 못했습니다');
      return 0;
    }
    default:
      throw new Error('쓰는 법: pr-body.ts check|screen|fill|guard|link …');
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2), process.env, {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  });
}
