import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_SECRET_NAMES } from '../functions/src/config/secret-names.ts';

/**
 * 화면 빌드 결과(apps/web/dist)에 서버 비밀값이 섞였는지 검사한다 (SPEC 6.2, T02, D-018).
 * 세 가지를 본다.
 * 1. 키 모양(SECRET_PATTERNS). Firebase 웹 API 키는 공개값이지만 YouTube 키와 모양(AIza…)이 같아서,
 *    화면 설정(.env*)의 VITE_FIREBASE_API_KEY 값만 허용한다.
 * 2. 서버 비밀값 이름(SERVER_SECRET_NAMES). VITE_ 같은 접두어가 붙어도 잡는다.
 * 3. functions/.secret.local에 있는 실제 비밀값 문자열.
 * 보고에는 값 자체를 싣지 않는다.
 */
export interface Finding {
  file: string;
  kind: string;
}

/** 키 모양 패턴. .secretlintrc.json의 pattern 규칙과 같아야 한다(tools/scan-bundle.test.ts가 확인). */
export const SECRET_PATTERNS: { kind: string; source: string }[] = [
  { kind: 'Google API key', source: 'AIza[0-9A-Za-z_\\-]{35}' },
  { kind: 'Google OAuth client secret', source: 'GOCSPX-[A-Za-z0-9_\\-]{20,}' },
  { kind: 'Google OAuth access token', source: 'ya29\\.[A-Za-z0-9_\\-]{20,}' },
  { kind: 'Anthropic API key', source: 'sk-ant-[A-Za-z0-9_\\-]{20,}' },
  { kind: 'GitHub token', source: '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}' },
  { kind: 'GitHub token', source: 'github_pat_[A-Za-z0-9_]{40,}' },
  { kind: 'Private key block', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
];

const MIN_SECRET_VALUE_LENGTH = 8;

export interface ScanOptions {
  /** 번들에 있어도 되는 공개값 (Firebase 웹 API 키). */
  allowedValues: string[];
  /** 번들에 있으면 안 되는 실제 비밀값 (이름 → 값). */
  secretValues?: Record<string, string>;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

export function scanBundle(
  dir: string,
  { allowedValues, secretValues = {} }: ScanOptions,
): Finding[] {
  if (!existsSync(dir))
    throw new Error(`${dir}가 없습니다. 먼저 화면을 빌드하세요 (pnpm --filter web build).`);
  const files = listFiles(dir);
  if (files.length === 0) throw new Error(`${dir}가 비어 있습니다. 빌드가 실패했는지 확인하세요.`);
  const allowed = new Set(allowedValues.filter(Boolean));
  const values = Object.entries(secretValues).filter(
    ([, v]) => v.length >= MIN_SECRET_VALUE_LENGTH,
  );
  const findings: Finding[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file = relative(dir, path);
    const kinds = new Set<string>();
    for (const { kind, source } of SECRET_PATTERNS) {
      for (const match of text.matchAll(new RegExp(source, 'g'))) {
        if (!allowed.has(match[0])) {
          kinds.add(kind);
          break;
        }
      }
    }
    for (const name of SERVER_SECRET_NAMES) {
      if (new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`).test(text))
        kinds.add(`서버 비밀값 이름 ${name}`);
    }
    for (const [name, value] of values) {
      if (text.includes(value)) kinds.add(`서버 비밀값 ${name}의 실제 값`);
    }
    for (const kind of kinds) findings.push({ file, kind });
  }
  return findings;
}

/** KEY=VALUE 형식 파일을 읽는다. 없으면 빈 객체. 따옴표는 벗긴다. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Vite가 production 빌드에서 읽는 것과 같은 파일들에서 화면 설정값을 모은다. */
export function readWebEnv(webDir: string): Record<string, string> {
  return ['.env', '.env.local', '.env.production', '.env.production.local']
    .map((f) => readEnvFile(join(webDir, f)))
    .reduce((acc, cur) => ({ ...acc, ...cur }), {});
}

// CLI: node --experimental-strip-types tools/scan-bundle.ts [dist 폴더] [화면 폴더] [functions 폴더]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir = 'apps/web/dist', webDir = 'apps/web', functionsDir = 'functions'] =
    process.argv.slice(2);
  const webEnv = readWebEnv(webDir);
  const allowed = [webEnv.VITE_FIREBASE_API_KEY ?? '', process.env.VITE_FIREBASE_API_KEY ?? ''];
  const findings = scanBundle(dir, {
    allowedValues: allowed,
    secretValues: readEnvFile(join(functionsDir, '.secret.local')),
  });
  if (findings.length) {
    for (const f of findings) console.error(`[scan-bundle] ${f.file}: ${f.kind}`);
    console.error(
      '[scan-bundle] 화면 빌드에 서버 비밀값으로 보이는 내용이 있습니다. 서버 비밀값은 functions/src/config/secrets.ts에서만 읽고, 화면에서는 callable 함수로 결과만 받으세요.',
    );
    process.exit(1);
  }
  console.log(`[scan-bundle] ${dir}: 문제 없음`);
}
