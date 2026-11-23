import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPTURES_PLACEHOLDER,
  CI_CAPTURES,
  MAX_LINK_LENGTH,
  SECTIONS,
  changesScreen,
  checkPrBody,
  fillCapturesUrl,
  forbiddenAutoFixChanges,
  main,
  prCreateLink,
} from './pr-body.ts';

/** PR 본문 검사기 (SPEC 4.9, T20, D-038). CI의 pr-body job이 모든 PR에 돌린다. */
const good = (captures = '해당 없음 (화면 변화 없음)') => `
## ${SECTIONS.summary}

1. 곡 연결 규칙이 라이브 영상을 공식 음원으로 잘못 고르던 문제를 고쳤습니다.
2. 사이트에서 재생목록을 만들면 라이브 대신 공식 음원이 나옵니다.
3. 다음은 매일 시험 점수로 같은 문제가 다시 생기는지 봅니다.

## ${SECTIONS.captures}

${captures}

## ${SECTIONS.scores}

- unit 790 → 792 (+2)
- 곡 연결 시험 0.98 → 0.98

## ${SECTIONS.howToCheck}

\`pnpm vitest run packages/shared/src/matching\`
`;

const IMAGE = '![전](https://github.com/user-attachments/assets/1.png)';
const ARTIFACT =
  '[전후 캡처](https://github.com/furabonos/musicweb/actions/runs/123/artifacts/456)';

describe('checkPrBody', () => {
  it('필수 절이 모두 있으면 통과', () => {
    expect(checkPrBody(good())).toEqual([]);
  });

  it.each(Object.values(SECTIONS))('"%s" 절이 없으면 실패하고 무엇을 넣을지 알려 준다', (title) => {
    const body = good().replace(`## ${title}`, '## 다른 제목');
    const errors = checkPrBody(body);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(`## ${title}`);
  });

  it.each(Object.values(SECTIONS))('"%s" 절이 비어 있으면 실패', (title) => {
    const lines = good().split('\n');
    const start = lines.indexOf(`## ${title}`);
    let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    if (end < 0) end = lines.length;
    const body = [...lines.slice(0, start + 1), '', ...lines.slice(end)].join('\n');
    expect(checkPrBody(body).join('\n')).toContain(title);
  });

  it('쉬운 말 요약은 정확히 3줄', () => {
    const two = good().replace(/^3\. .*$/m, '');
    expect(checkPrBody(two).join('\n')).toMatch(/3줄/);
    const four = good().replace(/^(3\. .*)$/m, '$1\n4. 하나 더');
    expect(checkPrBody(four).join('\n')).toMatch(/3줄/);
  });

  it('번호·글머리표만 있고 글이 없는 줄은 요약으로 세지 않는다', () => {
    const body = good().replace(/^3\. .*$/m, '3.');
    expect(checkPrBody(body).join('\n')).toMatch(/3줄/);
  });

  it('템플릿 안내 주석만 남아 있으면 빈 절로 본다', () => {
    const body = good().replace(/^`pnpm vitest.*`$/m, '<!-- 직접 확인하는 방법을 적는다 -->');
    expect(checkPrBody(body).join('\n')).toContain(SECTIONS.howToCheck);
  });

  it('캡처 자리 표시(채우지 않은 링크)가 남아 있으면 실패', () => {
    const body = good(`[전후 캡처](${CAPTURES_PLACEHOLDER})`);
    expect(checkPrBody(body).join('\n')).toContain(CAPTURES_PLACEHOLDER);
  });

  describe('화면 파일이 바뀐 PR', () => {
    const files = ['apps/web/src/pages/Home.tsx'];
    it('캡처가 "해당 없음"이면 실패', () => {
      expect(checkPrBody(good(), files).join('\n')).toMatch(/화면.*캡처/);
    });
    it('이미지가 있으면 통과', () => {
      expect(checkPrBody(good(IMAGE), files)).toEqual([]);
    });
    it('Actions 캡처 묶음 링크가 있으면 통과', () => {
      expect(checkPrBody(good(ARTIFACT), files)).toEqual([]);
    });
    it(`'${CI_CAPTURES}'라고 쓰면 통과(CI e2e job이 찍어 올림)`, () => {
      expect(checkPrBody(good(`${CI_CAPTURES} (Actions 실행의 screen-captures)`), files)).toEqual(
        [],
      );
    });
    it('저장소를 정하면 다른 저장소의 캡처 링크는 인정하지 않는다', () => {
      expect(checkPrBody(good(ARTIFACT), files, { repo: 'furabonos/musicweb' })).toEqual([]);
      expect(checkPrBody(good(ARTIFACT), files, { repo: 'someone/else' })).not.toEqual([]);
    });
    it('다른 사이트 링크는 캡처로 인정하지 않는다', () => {
      expect(checkPrBody(good('[캡처](https://example.com/a.png)'), files)).not.toEqual([]);
    });
  });
});

describe('본문 해석의 틈', () => {
  it('코드 블록 안의 ## 제목은 절로 보지 않는다', () => {
    const body = good().replace(`## ${SECTIONS.howToCheck}`, '## 다른 제목');
    const fenced = `${body}\n\`\`\`\n## ${SECTIONS.howToCheck}\n가짜\n\`\`\`\n`;
    expect(checkPrBody(fenced).join('\n')).toContain(SECTIONS.howToCheck);
  });
  it('같은 절 제목이 두 번 있으면 실패', () => {
    const body = `${good()}\n## ${SECTIONS.summary}\n\n1. a\n2. b\n3. c\n`;
    expect(checkPrBody(body).join('\n')).toMatch(/두 번/);
  });
});

describe('changesScreen', () => {
  it('화면 소스·스타일·index.html이 바뀌면 화면 변경', () => {
    expect(changesScreen(['apps/web/src/App.tsx'])).toBe(true);
    expect(changesScreen(['apps/web/src/styles/app.css'])).toBe(true);
    expect(changesScreen(['apps/web/index.html'])).toBe(true);
  });
  it('테스트·e2e·서버·문서만 바뀌면 화면 변경 아님', () => {
    expect(
      changesScreen([
        'apps/web/src/test/render.tsx',
        'apps/web/src/setupTests.ts',
        'apps/web/src/env.d.ts',
        'apps/web/src/App.test.tsx',
        'apps/web/e2e/core-flow.spec.ts',
        'functions/src/index.ts',
        'docs/SPEC.md',
      ]),
    ).toBe(false);
  });
});

describe('fillCapturesUrl', () => {
  it('자리 표시를 Actions 캡처 링크로 바꾼다', () => {
    const url = 'https://github.com/furabonos/musicweb/actions/runs/1/artifacts/2';
    const out = fillCapturesUrl(good(`[전후 캡처](${CAPTURES_PLACEHOLDER})`), url);
    expect(out).toContain(url);
    expect(out).not.toContain(CAPTURES_PLACEHOLDER);
  });
  it('github.com Actions 링크가 아니면 바꾸지 않는다', () => {
    expect(() => fillCapturesUrl(`x ${CAPTURES_PLACEHOLDER}`, 'https://evil.example/a')).toThrow();
  });
});

describe('PR 템플릿', () => {
  const template = readFileSync('.github/pull_request_template.md', 'utf8');
  it('필수 절 제목을 모두 담고 있다', () => {
    for (const title of Object.values(SECTIONS)) expect(template).toContain(`## ${title}`);
  });
  it('채우지 않은 템플릿 그대로는 통과하지 않는다', () => {
    expect(checkPrBody(template)).not.toEqual([]);
  });
});

describe('forbiddenAutoFixChanges', () => {
  it('워크플로·Claude 설정·보안 규칙·기준 점수·비밀값 설정을 골라낸다', () => {
    const files = [
      '.github/workflows/ci.yml',
      '.claude/settings.json',
      'CLAUDE.md',
      'firestore.rules',
      'storage.rules',
      'evals/baseline.json',
      '.gitleaksignore',
      'functions/src/config/secrets.ts',
      'tools/git-hooks/pre-push.sh',
      'packages/shared/src/matching/classify.ts',
    ];
    expect(forbiddenAutoFixChanges(files)).toEqual(files.slice(0, -1));
  });
});

describe('prCreateLink', () => {
  const o = {
    repo: 'furabonos/musicweb',
    branch: 'claude/issue-7-20261123',
    title: 'fix: a (#7)\nx',
    body: 'b & c',
  };
  it('제목(첫 줄)과 본문을 미리 채운 비교 링크', () => {
    const { url, bodyIncluded } = prCreateLink(o);
    expect(bodyIncluded).toBe(true);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      'https://github.com/furabonos/musicweb/compare/main...claude/issue-7-20261123',
    );
    expect(u.searchParams.get('title')).toBe('fix: a (#7)');
    expect(u.searchParams.get('body')).toBe('b & c');
  });
  it('본문이 너무 길면 본문 없이', () => {
    const r = prCreateLink({ ...o, body: 'x'.repeat(MAX_LINK_LENGTH) });
    expect(r.bodyIncluded).toBe(false);
    expect(r.url.length).toBeLessThan(MAX_LINK_LENGTH);
  });
  it.each(['a b', 'x;rm', '../main', 'a$(b)'])('이상한 브랜치 이름(%s)은 거부', (branch) => {
    expect(() => prCreateLink({ ...o, branch })).toThrow();
  });
});

describe('명령줄 (CI가 쓰는 경로)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out, err };
  };
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it('check: 통과 0, 실패 1과 고치는 방법', () => {
    const changed = file('changed.txt', 'apps/web/src/App.tsx\n');
    expect(
      run(['check', '--body-file', file('ok.md', good(IMAGE)), '--changed-files', changed]).code,
    ).toBe(0);
    const bad = run(['check', '--body-file', file('bad.md', good()), '--changed-files', changed]);
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toMatch(/캡처/);
  });
  it('check: GITHUB_REPOSITORY로 다른 저장소 캡처 링크를 막는다', () => {
    const changed = file('changed2.txt', 'apps/web/src/App.tsx\n');
    const body = file('art.md', good(ARTIFACT));
    expect(
      run(['check', '--body-file', body, '--changed-files', changed], { GITHUB_REPOSITORY: 'x/y' })
        .code,
    ).toBe(1);
  });
  it('screen·guard', () => {
    expect(run(['screen', '--changed-files', file('s.txt', 'apps/web/index.html\n')]).out).toEqual([
      'true',
    ]);
    expect(run(['screen', '--changed-files', file('n.txt', 'docs/SPEC.md\n')]).out).toEqual([
      'false',
    ]);
    const g = run([
      'guard',
      '--changed-files',
      file('g.txt', '.github/workflows/ci.yml\nREADME.md\n'),
    ]);
    expect(g).toMatchObject({ code: 1, out: ['.github/workflows/ci.yml'] });
  });
  it('fill: 자리 표시를 채운다', () => {
    const p = file('fill.md', `x ${CAPTURES_PLACEHOLDER}`);
    const url = 'https://github.com/o/r/actions/runs/1/artifacts/2';
    expect(run(['fill', '--body-file', p, '--url', url], { GITHUB_REPOSITORY: 'o/r' }).code).toBe(
      0,
    );
    expect(readFileSync(p, 'utf8')).toBe(`x ${url}`);
  });
});
