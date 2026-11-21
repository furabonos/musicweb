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
    'const g = globalThis;\nexport const k = g.process.env.YOUTUBE_API_KEY;',
    "export const k = (await import('node:process')).env.YOUTUBE_API_KEY;",
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

describe('functions: 외부 호출(fetch·http)은 adapters/에서만', () => {
  const NETWORK_RULES = ['no-restricted-globals', 'no-restricted-syntax', 'no-restricted-imports'];
  async function networkErrors(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId && NETWORK_RULES.includes(m.ruleId))
      .map((m) => m.message);
  }

  it.each([
    "export const r = fetch('https://example.com');",
    "export const r = globalThis.fetch('https://example.com');",
    "export const r = globalThis['fetch']('https://example.com');",
    'const f = fetch;\nexport const r = f;',
    "import https from 'node:https';\nexport const r = https;",
    "import { request } from 'http';\nexport const r = request;",
    "import { fetch as f } from 'undici';\nexport const r = f;",
    "import axios from 'axios';\nexport const r = axios;",
    'export const r = new WebSocket("wss://x");',
    "export const r = await import('node:http');",
    "export const r = await import('undici');",
    "const name = 'https';\nexport const r = await import(name);",
    "import { exec } from 'node:child_process';\nexport const r = exec;",
    "import { spawn } from 'child_process';\nexport const r = spawn;",
    "import Anthropic from '@anthropic-ai/sdk';\nexport const r = Anthropic;",
    "import { google } from 'googleapis';\nexport const r = google;",
    "import { Octokit } from '@octokit/rest';\nexport const r = Octokit;",
    "import OpenAI from 'openai';\nexport const r = OpenAI;",
    'const g = globalThis;\nexport const r = g.fetch;',
  ])('막는다: %s', async (code) => {
    for (const file of [
      'functions/src/core/x.ts',
      'functions/src/api/x.ts',
      'functions/src/jobs/x.ts',
      'functions/src/config/x.ts',
    ]) {
      const errors = await networkErrors(code, file);
      expect(errors.length, file).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('adapters/');
    }
  });

  it('adapters/에서는 fetch를 쓸 수 있다', async () => {
    expect(
      await networkErrors(
        "export const r = fetch('https://example.com');",
        'functions/src/adapters/youtube.ts',
      ),
    ).toEqual([]);
  });

  it('adapters/에서도 process는 여전히 금지 (규칙이 서로 덮어쓰지 않음)', async () => {
    const errors = await networkErrors(
      'export const k = process.env.X;',
      'functions/src/adapters/youtube.ts',
    );
    expect(errors[0]).toContain('config/secrets.ts');
  });

  it('core에서 process와 fetch를 함께 쓰면 둘 다 잡는다', async () => {
    const errors = await networkErrors(
      "export const r = fetch(process.env.URL ?? '');",
      'functions/src/core/x.ts',
    );
    expect(errors.some((m) => m.includes('adapters/'))).toBe(true);
    expect(errors.some((m) => m.includes('config/secrets.ts'))).toBe(true);
  });

  it('테스트 파일에서는 fetch를 쓸 수 있다 (에뮬레이터 정리 등)', async () => {
    expect(
      await networkErrors(
        "export const r = fetch('http://127.0.0.1');",
        'functions/src/core/budget.int.test.ts',
      ),
    ).toEqual([]);
  });
});
