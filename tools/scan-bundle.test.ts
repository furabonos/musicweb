import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_SECRET_NAMES } from '../functions/src/config/secret-names.ts';
import { SECRET_PATTERNS, scanBundle } from './scan-bundle.ts';

// 가짜 키는 실행 중에 이어 붙여 만든다 (이 파일이 비밀값 검사에 걸리지 않게).
const firebaseWebKey = 'AI' + 'za' + 'SyA' + 'PublicFirebaseWebKey0123456789ab';
const youtubeKey = 'AI' + 'za' + 'SyB' + 'ServerOnlyYoutubeKey0123456789ab';
const anthropicKey = 'sk-' + 'ant-' + 'api03-' + 'a'.repeat(40);
const oauthSecret = 'GOC' + 'SPX-' + 'b'.repeat(28);
const oauthToken = 'ya' + '29.' + 'c'.repeat(40);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musicweb-bundle-'));
  mkdirSync(join(dir, 'assets'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

describe('scanBundle', () => {
  it('정상 번들(허용한 Firebase 웹 키만 있음)은 통과', () => {
    write('index.html', '<script src="/assets/index.js"></script>');
    write('assets/index.js', `const config={apiKey:"${firebaseWebKey}",projectId:"demo"};`);
    expect(scanBundle(dir, { allowedValues: [firebaseWebKey] })).toEqual([]);
  });

  it('허용하지 않은 Google API 키 모양 값은 잡는다', () => {
    write('assets/index.js', `fetch("https://x?key=${youtubeKey}")`);
    const found = scanBundle(dir, { allowedValues: [firebaseWebKey] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'assets/index.js', kind: 'Google API key' });
    expect(JSON.stringify(found)).not.toContain(youtubeKey); // 보고에 값 자체를 싣지 않음
  });

  it.each([
    ['Anthropic API key', `const k="${anthropicKey}"`],
    ['Private key block', '-----BEGIN ' + 'PRIVATE KEY-----\nabc'],
    ['Google OAuth client secret', `const s="${oauthSecret}"`],
    ['Google OAuth access token', `Authorization: "Bearer ${oauthToken}"`],
  ])('%s를 잡는다', (kind, content) => {
    write('assets/a.js', content);
    expect(scanBundle(dir, { allowedValues: [] }).map((f) => f.kind)).toContain(kind);
  });

  it.each(SERVER_SECRET_NAMES)('서버 비밀값 이름 %s가 번들에 있으면 잡는다', (name) => {
    write('assets/a.js', `console.log(import.meta.env.${name})`);
    expect(scanBundle(dir, { allowedValues: [] })).toEqual([
      expect.objectContaining({ file: 'assets/a.js', kind: `서버 비밀값 이름 ${name}` }),
    ]);
  });

  it('Firebase Auth SDK의 오류 코드 INVALID_OAUTH_CLIENT_ID는 비밀값 이름이 아니다(정확히 그 이름만 예외)', () => {
    write('assets/sdk.js', 'var e={INVALID_OAUTH_CLIENT_ID:`invalid-oauth-client-id`};');
    expect(scanBundle(dir, { allowedValues: [] })).toEqual([]);
    write('assets/b.js', 'X_INVALID_OAUTH_CLIENT_ID; VITE_OAUTH_CLIENT_ID; OAUTH_CLIENT_ID');
    expect(scanBundle(dir, { allowedValues: [] })).toEqual([
      { file: 'assets/b.js', kind: '서버 비밀값 이름 OAUTH_CLIENT_ID' },
    ]);
  });

  it('에뮬레이터·e2e 전용 코드(로그인 도우미·에뮬레이터 주소)가 있으면 실패', () => {
    write('assets/a.js', 'window.__musicwebE2E={};connect("http://127.0.0.1:9099")');
    expect(scanBundle(dir, { allowedValues: [] }).map((f) => f.kind)).toEqual([
      '에뮬레이터 전용 코드 __musicwebE2E (VITE_USE_EMULATORS를 비우고 빌드)',
      '에뮬레이터 전용 코드 127.0.0.1:9099 (VITE_USE_EMULATORS를 비우고 빌드)',
    ]);
  });

  it('VITE_ 같은 접두어가 붙은 서버 비밀값 이름도 잡는다', () => {
    write('assets/a.js', 'const x = import.meta.env.VITE_LASTFM_API_KEY;');
    expect(scanBundle(dir, { allowedValues: [] }).map((f) => f.kind)).toEqual([
      '서버 비밀값 이름 LASTFM_API_KEY',
    ]);
  });

  it('비슷하지만 다른 이름(MY_TOKEN_ENC_KEYS)은 잡지 않는다', () => {
    write('assets/a.js', 'const MY_TOKEN_ENC_KEYS = 1;');
    expect(scanBundle(dir, { allowedValues: [] })).toEqual([]);
  });

  it('실제 비밀값 문자열을 찾고, 보고에는 이름만 싣는다', () => {
    const lastfm = '0123456789abcdef0123456789abcdef';
    write('assets/a.js', `fetch("https://ws.audioscrobbler.com/?api_key=${lastfm}")`);
    const found = scanBundle(dir, {
      allowedValues: [],
      secretValues: { LASTFM_API_KEY: lastfm, EMPTY: '' },
    });
    expect(found).toEqual([{ file: 'assets/a.js', kind: '서버 비밀값 LASTFM_API_KEY의 실제 값' }]);
    expect(JSON.stringify(found)).not.toContain(lastfm);
  });

  it('소스맵(.map)과 하위 폴더 파일도 검사한다', () => {
    mkdirSync(join(dir, 'assets/chunks'));
    write('assets/chunks/x.js.map', `{"sourcesContent":["${anthropicKey}"]}`);
    expect(scanBundle(dir, { allowedValues: [] })).toHaveLength(1);
  });

  it('폴더가 없으면 오류 (빌드를 안 하고 검사한 것으로 통과하지 않게)', () => {
    expect(() => scanBundle(join(dir, 'nope'), { allowedValues: [] })).toThrow('빌드');
  });

  it('파일이 하나도 없으면 오류', () => {
    rmSync(join(dir, 'assets'), { recursive: true });
    expect(() => scanBundle(dir, { allowedValues: [] })).toThrow('비어');
  });
});

describe('.secretlintrc.json과 키 패턴이 같다', () => {
  it('커밋 전 검사와 번들 검사의 키 모양 패턴이 정확히 일치한다 (한쪽만 고치지 말 것)', () => {
    const rc = JSON.parse(readFileSync('.secretlintrc.json', 'utf8')) as {
      rules: { id: string; options?: { patterns: { patterns?: string[] }[] } }[];
    };
    const fromRc = rc.rules
      .flatMap((r) => r.options?.patterns ?? [])
      .flatMap((p) => p.patterns ?? [])
      .map((p) => p.replace(/^\/(.*)\/$/, '$1'))
      .sort();
    expect(fromRc).toEqual(SECRET_PATTERNS.map((p) => p.source).sort());
  });
});

describe('scan-bundle 명령줄 실행', () => {
  // 화면 폴더·functions 폴더 기본값은 없는 경로로 둔다 (실제 프로젝트의 .env·.secret.local에 영향받지 않게).
  const cli = (
    target: string,
    apiKey = '',
    webDir = join(target, 'no-web'),
    functionsDir = join(target, 'no-fn'),
  ) =>
    spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        'tools/scan-bundle.ts',
        target,
        webDir,
        functionsDir,
      ],
      { encoding: 'utf8', env: { ...process.env, VITE_FIREBASE_API_KEY: apiKey } },
    );

  it('문제가 있으면 exit 1과 안내 문구, 값은 출력하지 않음', () => {
    write('assets/index.js', `const k="${anthropicKey}"`);
    const r = cli(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('assets/index.js: Anthropic API key');
    expect(r.stderr).toContain('secrets.ts');
    expect(r.stderr + r.stdout).not.toContain(anthropicKey);
  });

  it('VITE_FIREBASE_API_KEY로 준 Firebase 웹 키는 허용하고 exit 0', () => {
    write('assets/index.js', `const config={apiKey:"${firebaseWebKey}"}`);
    const r = cli(dir, firebaseWebKey);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('화면 .env.local의 VITE_FIREBASE_API_KEY를 허용 값으로 읽는다', () => {
    const web = mkdtempSync(join(tmpdir(), 'musicweb-web-'));
    writeFileSync(join(web, '.env.local'), `VITE_FIREBASE_API_KEY="${firebaseWebKey}"\n`);
    write('assets/index.js', `const config={apiKey:"${firebaseWebKey}"}`);
    const r = cli(dir, '', web);
    rmSync(web, { recursive: true, force: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('functions/.secret.local의 실제 값이 번들에 있으면 exit 1', () => {
    const fn = mkdtempSync(join(tmpdir(), 'musicweb-fn-'));
    const value = 'actor-hash-key-value-123456';
    writeFileSync(join(fn, '.secret.local'), `ACTOR_HASH_KEY=${value}\n`);
    write('assets/index.js', `const k="${value}"`);
    const r = cli(dir, '', join(dir, 'no-web'), fn);
    rmSync(fn, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ACTOR_HASH_KEY의 실제 값');
    expect(r.stderr).not.toContain(value);
  });
});
