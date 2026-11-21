import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// 화면 코드의 서버 import 차단 규칙이 너무 넓거나 좁지 않은지 확인한다.
const eslint = new ESLint({ cwd: process.cwd() });
const webFile = 'apps/web/src/__lint_fixture__.ts';

async function restrictedImportErrors(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: webFile });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('apps/web 서버 코드 import 금지', () => {
  it.each([
    "import { health } from '../../../functions/src/api/health';",
    "import { health } from 'functions';",
    "import { initializeApp } from 'firebase-admin/app';",
    "import { onCall } from 'firebase-functions/v2/https';",
  ])('막는다: %s', async (code) => {
    const errors = await restrictedImportErrors(`${code}\nexport const used = 1;`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('packages/shared');
  });

  it.each([
    "import { httpsCallable } from 'firebase/functions';",
    "import { getAuth } from 'firebase/auth';",
    "import { DEFAULT_LOCALE } from '@musicweb/shared';",
  ])('허용한다: %s', async (code) => {
    expect(await restrictedImportErrors(`${code}\nexport const used = 1;`)).toEqual([]);
  });
});
