import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// 원칙을 강제하는 lint 규칙이 너무 넓거나 좁지 않은지 확인한다 (SPEC 6.2).
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleErrors(code: string, filePath: string, ruleId: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === ruleId).map((m) => m.message);
}

describe('apps/web: 서버 코드·서버 전용 패키지 import 금지', () => {
  const file = 'apps/web/src/__lint_fixture__.ts';
  it.each([
    "import { health } from '../../../functions/src/api/health';",
    "import { health } from 'functions';",
    "import { initializeApp } from 'firebase-admin/app';",
    "import { onCall } from 'firebase-functions/v2/https';",
    "import Anthropic from '@anthropic-ai/sdk';",
    "import { google } from 'googleapis';",
    "import x from '../../../functions';",
    "import x from '../../../functions/src';",
    "import pkg from '../../../functions/package.json';",
  ])('막는다: %s', async (code) => {
    const errors = await ruleErrors(
      `${code}\nexport const used = 1;`,
      file,
      'no-restricted-imports',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('packages/shared');
  });

  it.each([
    "import { httpsCallable } from 'firebase/functions';",
    "import { getAuth } from 'firebase/auth';",
    "import { DEFAULT_LOCALE } from '@musicweb/shared';",
  ])('허용한다: %s', async (code) => {
    expect(
      await ruleErrors(`${code}\nexport const used = 1;`, file, 'no-restricted-imports'),
    ).toEqual([]);
  });
});

describe('functions: process는 config 폴더에서만', () => {
  const PROCESS_RULES = ['no-restricted-globals', 'no-restricted-syntax', 'no-restricted-imports'];
  async function processErrors(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId && PROCESS_RULES.includes(m.ruleId))
      .map((m) => m.message);
  }

  it.each([
    'export const k = process.env.YOUTUBE_API_KEY;',
    "export const k = process['env'].YOUTUBE_API_KEY;",
    'export const k = process?.env.YOUTUBE_API_KEY;',
    'const { env } = process;\nexport const k = env.YOUTUBE_API_KEY;',
    'const p = process;\nexport const k = p.env.YOUTUBE_API_KEY;',
    'export const k = globalThis.process.env.YOUTUBE_API_KEY;',
    "export const k = globalThis['process'].env.YOUTUBE_API_KEY;",
    'export const k = global.process.env.YOUTUBE_API_KEY;',
    "import { env } from 'node:process';\nexport const k = env.YOUTUBE_API_KEY;",
    "import proc from 'process';\nexport const k = proc.env.YOUTUBE_API_KEY;",
  ])('막는다: %s', async (code) => {
    for (const file of ['functions/src/core/x.ts', 'functions/src/adapters/youtube.ts']) {
      const errors = await processErrors(code, file);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('config/secrets.ts');
    }
  });

  it.each([
    'functions/src/config/secrets.ts',
    'functions/src/config/runtime.ts',
    'functions/src/core/x.test.ts',
    'functions/src/api/x.int.test.ts',
  ])('허용한다: %s', async (file) => {
    expect(await processErrors('export const k = process.env.YOUTUBE_API_KEY;', file)).toEqual([]);
  });
});
