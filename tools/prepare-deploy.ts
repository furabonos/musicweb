/**
 * 배포 준비 (T23, D-053). 실제로 배포하지 않는다. 배포는 사람이 이 뒤에 `firebase deploy --config firebase.deploy.json`로 한다.
 *
 *   node --experimental-strip-types tools/prepare-deploy.ts [별칭(기본 prod)] [--check]
 *
 * 1. 설정 검사: .firebaserc 별칭 → 프로젝트 ID, 화면 설정(apps/web/.env.production.local — 배포 빌드만 읽고 개발 서버·e2e는 읽지 않는다), 서버 매개변수(functions/.env.<프로젝트 ID>)
 * 2. functions·화면 빌드(화면은 scan:bundle로 비밀값 검사까지) 후 .deploy/functions에 배포용 묶음을 만든다.
 *    - functions/package.json의 `workspace:` 개발 의존성은 Cloud Build(npm)가 설치하지 못한다(D-027).
 *      esbuild가 묶지 않은(external) 패키지만, 지금 설치된 정확한 버전으로 적은 package.json을 쓴다.
 * --check는 이 컴퓨터의 Node로 불러온다. 실제 실행은 Node 22(functions engines)라 문법 차이는 esbuild target(node22)이 막는다.
 * 3. firebase.json을 복사해 functions 위치만 .deploy/functions로 바꾼 firebase.deploy.json을 만든다
 *    (에뮬레이터·테스트는 계속 firebase.json과 functions/를 쓴다).
 * --check: 배포 묶음을 임시 폴더에 npm으로 설치하고(실행 의존성만) lib/index.js를 불러 와 깨지지 않는지 본다.
 *
 * 비밀값은 다루지 않는다(Secret Manager, docs/OPERATIONS.md). 이 도구는 값의 내용을 출력하지 않는다.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEPLOY_DIR = '.deploy/functions';
export const DEPLOY_CONFIG = 'firebase.deploy.json';
/** 화면을 올릴 Hosting 사이트(https://tunetrail.web.app). 프로젝트 기본 사이트(aimusicwebs)가 아니다. */
export const HOSTING_SITE = 'tunetrail';
/** 배포 빌드(vite build)만 읽는 화면 설정. 개발 서버는 읽지 않으므로 에뮬레이터 개발·e2e가 실제 프로젝트에 붙지 않는다 */
export const WEB_ENV_FILE = 'apps/web/.env.production.local';

/** 화면 빌드에 꼭 있어야 하는 값 */
export const WEB_REQUIRED = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_RECAPTCHA_SITE_KEY',
] as const;

/** 서버 매개변수(defineList·defineString). 없으면 배포가 입력을 기다리며 멈춘다 */
export const FUNCTIONS_PARAMS = ['ADMIN_EMAILS', 'MB_CONTACT'] as const;

/** KEY=VALUE 줄을 읽는다(따옴표 한 겹 제거, # 주석 무시) */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2] ?? '';
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out.set(m[1] as string, v);
  }
  return out;
}

export function projectIdFor(firebaserc: string, alias: string): string | null {
  const rc = JSON.parse(firebaserc) as { projects?: Record<string, string> };
  const id = rc.projects?.[alias];
  return id && !id.startsWith('demo-') ? id : null;
}

/** 화면 설정의 문제 목록(값은 적지 않는다). 비어 있으면 통과 */
export function checkWebEnv(env: Map<string, string>, projectId: string): string[] {
  const problems: string[] = [];
  for (const k of WEB_REQUIRED) if (!env.get(k)?.trim()) problems.push(`${k}가 비어 있습니다`);
  const pid = env.get('VITE_FIREBASE_PROJECT_ID')?.trim();
  if (pid && pid !== projectId)
    problems.push(`VITE_FIREBASE_PROJECT_ID가 배포할 프로젝트(${projectId})와 다릅니다`);
  if (env.get('VITE_USE_EMULATORS')?.trim())
    problems.push('VITE_USE_EMULATORS는 배포 빌드에서 비워 두세요');
  return problems;
}

export function checkFunctionsEnv(env: Map<string, string> | null, projectId: string): string[] {
  const file = `functions/.env.${projectId}`;
  if (!env) return [`${file}이 없습니다 (ADMIN_EMAILS, MB_CONTACT, docs/OPERATIONS.md 7절)`];
  const problems: string[] = [];
  for (const k of FUNCTIONS_PARAMS)
    if (!env.get(k)?.trim()) problems.push(`${file}에 ${k}가 없습니다`);
  const admins = env.get('ADMIN_EMAILS')?.trim();
  if (admins) {
    try {
      const list = JSON.parse(admins) as unknown;
      if (
        !Array.isArray(list) ||
        !list.length ||
        !list.every((e) => typeof e === 'string' && e.includes('@'))
      )
        throw new Error('형식');
    } catch {
      problems.push(`${file}의 ADMIN_EMAILS는 JSON 배열이어야 합니다 (예: ["a@example.com"])`);
    }
  }
  // 에뮬레이터 표시가 들어가면 가짜 외부 서비스·App Check 꺼짐으로 이어질 수 있다
  for (const k of ['MUSICWEB_FAKE_EXTERNAL', 'FUNCTIONS_EMULATOR'])
    if (env.has(k)) problems.push(`${file}에 ${k}를 넣지 마세요`);
  return problems;
}

interface Pkg {
  name?: string;
  type?: string;
  main?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** build 스크립트의 esbuild `--external:<이름>` (묶지 않고 실행 때 설치해야 하는 패키지) */
export function externalPackages(buildScript: string): string[] {
  const names = [...buildScript.matchAll(/--external:'?([^'\s]+)'?/g)].map((m) => m[1] as string);
  // 'firebase-admin/*' 같은 하위 경로는 같은 패키지
  return [
    ...new Set(
      names.map((n) =>
        (n.startsWith('@') ? n.split('/').slice(0, 2) : n.split('/').slice(0, 1)).join('/'),
      ),
    ),
  ];
}

/**
 * 배포용 package.json: esbuild가 묶지 않은(external) 패키지만, 지금 설치돼 테스트한 정확한 버전으로.
 * Cloud Build가 범위(^)로 그날의 다른 버전을 받지 않게 한다. external이 dependencies에 없거나 workspace:면 던진다.
 */
export function deployPackageJson(pkg: Pkg, installedVersion: (name: string) => string): Pkg {
  const deps = pkg.dependencies ?? {};
  const externals = externalPackages(pkg.scripts?.build ?? '');
  if (!externals.length)
    throw new Error('functions build 스크립트에서 --external 패키지를 찾지 못했습니다');
  const missing = externals.filter((n) => !deps[n] || /^(workspace|link|file):/.test(deps[n]));
  if (missing.length)
    throw new Error(
      `실행 때 설치할 패키지가 functions dependencies에 없거나 npm이 설치하지 못하는 형식입니다: ${missing.join(', ')} (D-027)`,
    );
  return {
    name: pkg.name ?? 'functions',
    type: pkg.type ?? 'module',
    main: pkg.main ?? 'lib/index.js',
    ...(pkg.engines ? { engines: pkg.engines } : {}),
    dependencies: Object.fromEntries(externals.sort().map((n) => [n, installedVersion(n)])),
  };
}

function installedVersion(name: string): string {
  const v = (
    JSON.parse(readFileSync(join('functions/node_modules', name, 'package.json'), 'utf8')) as {
      version?: string;
    }
  ).version;
  if (!v) throw new Error(`${name}의 설치 버전을 찾지 못했습니다`);
  return v;
}

interface FirebaseJson {
  functions?: { source: string; predeploy?: string[]; ignore?: string[]; codebase?: string }[];
  emulators?: unknown;
  [k: string]: unknown;
}

/**
 * firebase.json → 배포용: functions 위치를 바꾸고 에뮬레이터 설정은 뺀다.
 * 빌드(functions·화면)는 이 도구가 검사와 함께 이미 했으므로 predeploy를 모두 뺀다
 * (배포 순간 다시 빌드하면 검사하지 않은 설정으로 빌드될 수 있고, 배포 키가 있는 단계에서 빌드 도구가 돈다).
 */
export function deployFirebaseJson(fj: FirebaseJson): FirebaseJson {
  const rest = { ...fj };
  delete rest.emulators;
  if (rest.hosting && typeof rest.hosting === 'object') {
    const hosting = { ...(rest.hosting as Record<string, unknown>) };
    delete hosting.predeploy;
    rest.hosting = { ...hosting, site: HOSTING_SITE };
  }
  return {
    ...rest,
    functions: (fj.functions ?? []).map((f) => {
      const keep = { ...f };
      delete keep.predeploy;
      return { ...keep, source: DEPLOY_DIR, ignore: ['node_modules', '*.log'] };
    }),
  };
}

function readIf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function fail(problems: string[]): never {
  console.error('배포 준비를 멈춥니다:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const alias = args.find((a) => !a.startsWith('--')) ?? 'prod';

  const projectId = projectIdFor(readFileSync('.firebaserc', 'utf8'), alias);
  if (!projectId) fail([`.firebaserc에 별칭 "${alias}"의 실제 프로젝트(demo- 아님)가 없습니다`]);

  const webEnv = readIf(WEB_ENV_FILE);
  const fnEnv = readIf(`functions/.env.${projectId}`);
  const problems = [
    ...(webEnv
      ? checkWebEnv(parseDotenv(webEnv), projectId)
      : [`${WEB_ENV_FILE}이 없습니다 (apps/web/.env.example 참고)`]),
    ...checkFunctionsEnv(fnEnv ? parseDotenv(fnEnv) : null, projectId),
  ];
  if (problems.length) fail(problems);

  execFileSync('pnpm', ['--filter', 'functions', 'build'], { stdio: 'inherit' });
  // 화면 빌드 + 서버 비밀값이 섞였는지 검사(scan:bundle이 빌드까지 한다). 배포는 이 결과(apps/web/dist)를 그대로 올린다.
  execFileSync('pnpm', ['scan:bundle'], { stdio: 'inherit' });

  rmSync(DEPLOY_DIR, { recursive: true, force: true });
  mkdirSync(DEPLOY_DIR, { recursive: true });
  cpSync('functions/lib', join(DEPLOY_DIR, 'lib'), { recursive: true });
  const pkg = deployPackageJson(
    JSON.parse(readFileSync('functions/package.json', 'utf8')) as Pkg,
    installedVersion,
  );
  writeFileSync(join(DEPLOY_DIR, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  cpSync(`functions/.env.${projectId}`, join(DEPLOY_DIR, `.env.${projectId}`));
  const fj = JSON.parse(readFileSync('firebase.json', 'utf8')) as FirebaseJson;
  writeFileSync(DEPLOY_CONFIG, `${JSON.stringify(deployFirebaseJson(fj), null, 2)}\n`);
  console.log(`배포 묶음: ${DEPLOY_DIR}, 설정: ${DEPLOY_CONFIG} (프로젝트 ${projectId})`);

  if (check) {
    const tmp = mkdtempSync(join(tmpdir(), 'musicweb-deploy-check-'));
    try {
      cpSync(DEPLOY_DIR, tmp, { recursive: true });
      execFileSync(
        'npm',
        ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        {
          cwd: tmp,
          stdio: 'inherit',
        },
      );
      // 실행 의존성만으로 묶음이 불러와지는지(빠진 패키지가 없는지). 함수를 실행하지는 않는다.
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(pathToFileURL(join(tmp, 'lib/index.js')).href)})`,
        ],
        { cwd: tmp, stdio: 'inherit', env: { ...process.env, GCLOUD_PROJECT: projectId } },
      );
      console.log('확인: 실행 의존성만으로 functions 묶음을 불러왔습니다');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(
    `다음(사람이 직접): pnpm exec firebase deploy --config ${DEPLOY_CONFIG} --project ${alias}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
