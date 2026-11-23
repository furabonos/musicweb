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

describe('YouTube 재생목록 쓰기는 adapters/youtube-write.ts에서만 (SPEC 6.2, T05)', () => {
  const YT_RULES = ['no-restricted-syntax', 'no-restricted-imports'];
  async function ytErrors(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId && YT_RULES.includes(m.ruleId))
      .map((m) => m.message);
  }
  const OUTSIDE = [
    'functions/src/core/x.ts',
    'functions/src/api/export.ts',
    'functions/src/config/x.ts',
    'functions/src/adapters/other.ts',
    'functions/src/adapters/youtube-read.ts',
    'apps/web/src/__lint_fixture__.ts',
  ];
  const WRITE_CALLS = [
    "export const u = 'https://www.googleapis.com/youtube/v3/playlists?part=snippet';",
    "export const u = 'https://youtube.googleapis.com/YouTube/v3/Playlists';",
    'const id = 1;\nexport const u = `https://www.googleapis.com/youtube/v3/playlists/${id}`;',
  ];

  it.each(WRITE_CALLS)('어댑터 밖에서 playlists 주소를 쓰면 막는다: %s', async (code) => {
    for (const file of OUTSIDE) {
      const errors = await ytErrors(code, file);
      // adapters에서는 전체 주소 규칙과 경로 조각 규칙이 같이 걸릴 수 있다.
      expect(errors.length, file).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('youtube-write.ts');
    }
  });

  it.each([
    "export const u = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet';",
    'export const u = `https://www.googleapis.com/youtube/v3/playlistItems`;',
  ])('playlistItems 주소는 youtube-read.ts 말고는 막는다: %s', async (code) => {
    for (const file of OUTSIDE.filter((f) => !f.endsWith('youtube-read.ts'))) {
      expect((await ytErrors(code, file)).length, file).toBeGreaterThanOrEqual(1);
    }
    expect(await ytErrors(code, 'functions/src/adapters/youtube-read.ts')).toEqual([]);
  });

  it.each([
    "import { youtube } from '@googleapis/youtube';\nexport const y = youtube;",
    "import { google } from 'googleapis';\nexport const y = google;",
    "import y from 'googleapis/build/src/apis/youtube';\nexport const z = y;",
    "export const y = await import('@googleapis/youtube');",
  ])('youtube-write.ts 밖의 어댑터에서 googleapis youtube를 막는다: %s', async (code) => {
    for (const file of [
      'functions/src/adapters/other.ts',
      'functions/src/adapters/youtube-read.ts',
    ]) {
      const errors = await ytErrors(code, file);
      expect(errors.length, file).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('youtube-write.ts');
    }
  });

  it.each([
    "await fetch('https://www.googleapis.com/youtube/v3/playlistItems', { method: 'POST' });",
    "await fetch('https://www.googleapis.com/youtube/v3/playlistItems', { method: 'DELETE' });",
    "const m = 'PUT';\nawait fetch('https://www.googleapis.com/youtube/v3/playlistItems', { method: m });",
    "await fetch('https://www.googleapis.com/youtube/v3/playlistItems', { 'method': 'POST' });",
  ])('youtube-read.ts는 GET 말고는 막는다: %s', async (code) => {
    const errors = await ytErrors(code, 'functions/src/adapters/youtube-read.ts');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('GET');
  });

  it.each([
    "const API = 'https://www.googleapis.com/youtube/v3';\nexport const u = `${API}/playlists?part=snippet`;",
    "const API = 'https://www.googleapis.com/youtube/v3';\nexport const u = API + '/playlists';",
    "export const u = new URL('playlists', 'https://www.googleapis.com/youtube/v3/');",
  ])('adapters에서는 기본 주소를 따로 둔 playlists 경로도 막는다: %s', async (code) => {
    for (const file of [
      'functions/src/adapters/other.ts',
      'functions/src/adapters/youtube-read.ts',
    ]) {
      const errors = await ytErrors(code, file);
      expect(errors.length, file).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('youtube-write.ts');
    }
  });

  it('adapters에서 기본 주소를 따로 둔 playlistItems는 youtube-read.ts만 허용한다', async () => {
    const code =
      "const API = 'https://www.googleapis.com/youtube/v3';\nexport const u = `${API}/playlistItems?part=contentDetails`;";
    expect(await ytErrors(code, 'functions/src/adapters/other.ts')).toHaveLength(1);
    expect(await ytErrors(code, 'functions/src/adapters/youtube-read.ts')).toEqual([]);
  });

  it('core·api의 Firestore 경로 playlists/{id}는 막지 않는다', async () => {
    const code =
      'const id = "x";\nexport const p = `playlists/${id}`;\nexport const q = "playlists";';
    for (const file of ['functions/src/core/x.ts', 'functions/src/api/x.ts']) {
      expect(await ytErrors(code, file), file).toEqual([]);
    }
  });

  it('youtube-read.ts에서 init.method에 GET 말고 대입하면 막는다', async () => {
    const errors = await ytErrors(
      "const init: RequestInit = {};\ninit.method = 'POST';\nexport const i = init;",
      'functions/src/adapters/youtube-read.ts',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('GET');
  });

  it.each([
    "export const r = 'ytExports/abc';",
    'const id = 1;\nexport const r = `ytExports/${id}`;',
    "export const c = 'ytExports';",
  ])('youtube-write.ts 밖의 functions 코드는 ytExports를 쓰지 않는다: %s', async (code) => {
    for (const file of [
      'functions/src/core/x.ts',
      'functions/src/api/export.ts',
      'functions/src/jobs/x.ts',
      'functions/src/adapters/other.ts',
    ]) {
      const errors = await ytErrors(code, file);
      expect(errors, file).toHaveLength(1);
      expect(errors[0]).toContain('ytExports');
    }
    expect(await ytErrors(code, 'functions/src/adapters/youtube-write.ts')).toEqual([]);
  });

  it('30일 정리(jobs/purge.ts)만 ytExports를 쓸 수 있고, 다른 금지는 그대로다', async () => {
    const code = "export const c = 'ytExports';";
    expect(await ytErrors(code, 'functions/src/jobs/purge.ts')).toEqual([]);
    for (const file of ['functions/src/jobs/refresh.ts', 'functions/src/jobs/purge2.ts']) {
      expect(await ytErrors(code, file), file).toHaveLength(1);
    }
    const [r] = await eslint.lintText(
      "await fetch('https://www.googleapis.com/youtube/v3/playlists');\nexport const e = process.env;",
      { filePath: 'functions/src/jobs/purge.ts' },
    );
    const rules = (r?.messages ?? []).map((m) => m.ruleId);
    // fetch·process 전역 금지와 YouTube 쓰기 주소 금지가 모두 걸린다
    expect(rules.filter((id) => id === 'no-restricted-globals')).toHaveLength(2);
    expect(rules).toContain('no-restricted-syntax');
  });

  it('youtube-read.ts에서 GET 읽기는 허용한다', async () => {
    expect(
      await ytErrors(
        "await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails', { method: 'GET' });\nawait fetch('https://www.googleapis.com/youtube/v3/videos?part=status');",
        'functions/src/adapters/youtube-read.ts',
      ),
    ).toEqual([]);
  });

  it('youtube-write.ts 자체에서는 허용하고, process 금지는 그대로다', async () => {
    const file = 'functions/src/adapters/youtube-write.ts';
    expect(await ytErrors(WRITE_CALLS[0] as string, file)).toEqual([]);
    const [result] = await eslint.lintText('export const k = process.env.X;', { filePath: file });
    expect(result?.messages.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('videos·channels 같은 읽기 주소는 어디서든 이 규칙에 걸리지 않는다', async () => {
    expect(
      await ytErrors(
        "export const u = 'https://www.googleapis.com/youtube/v3/videos?part=status';",
        'apps/web/src/__lint_fixture__.ts',
      ),
    ).toEqual([]);
  });
});

describe('callable은 api/callable.ts의 onCall로만 (App Check 강제, T23)', () => {
  it('firebase-functions의 onCall을 직접 쓰면 막고, 대신 쓸 것을 알려 준다', async () => {
    const errors = await ruleErrors(
      "import { onCall } from 'firebase-functions/v2/https';\nexport const f = onCall(() => 1);",
      'functions/src/api/__lint_fixture__.ts',
      'no-restricted-imports',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("import { onCall } from './callable.js'");
  });

  it.each([
    "import { onCall } from 'firebase-functions/https';",
    "import { https } from 'firebase-functions/v2';",
    "import { https } from 'firebase-functions';",
    "import * as v1 from 'firebase-functions/v1';",
    "import { onCall } from 'firebase-functions/v1/https';",
  ])('우회 경로도 막는다: %s', async (code) => {
    const errors = await ruleErrors(
      `${code}\nexport const used = 1;`,
      'functions/src/api/__lint_fixture__.ts',
      'no-restricted-imports',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('callable.ts');
  });

  it('HttpsError 같은 다른 이름은 막지 않는다', async () => {
    expect(
      await ruleErrors(
        "import { HttpsError } from 'firebase-functions/v2/https';\nexport const e = HttpsError;",
        'functions/src/api/__lint_fixture__.ts',
        'no-restricted-imports',
      ),
    ).toEqual([]);
  });

  it('api/callable.ts 자체는 허용한다', async () => {
    expect(
      await ruleErrors(
        "import { onCall } from 'firebase-functions/v2/https';\nexport const f = onCall;",
        'functions/src/api/callable.ts',
        'no-restricted-imports',
      ),
    ).toEqual([]);
  });
});
