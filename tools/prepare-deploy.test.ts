import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkFunctionsEnv,
  checkWebEnv,
  DEPLOY_DIR,
  deployFirebaseJson,
  deployPackageJson,
  externalPackages,
  parseDotenv,
  projectIdFor,
} from './prepare-deploy';

const WEB_OK = parseDotenv(
  [
    '# 주석',
    'VITE_FIREBASE_API_KEY=AIza-test',
    'VITE_FIREBASE_AUTH_DOMAIN=p.firebaseapp.com',
    'VITE_FIREBASE_PROJECT_ID="p"',
    'VITE_FIREBASE_APP_ID=1:2:web:3',
    'VITE_RECAPTCHA_SITE_KEY=site',
    'VITE_USE_EMULATORS=',
  ].join('\n'),
);

describe('배포 준비 검사 (T23)', () => {
  it('parseDotenv: 주석·따옴표·빈 값', () => {
    expect(WEB_OK.get('VITE_FIREBASE_PROJECT_ID')).toBe('p');
    expect(WEB_OK.get('VITE_USE_EMULATORS')).toBe('');
    expect(WEB_OK.has('# 주석')).toBe(false);
  });

  it('별칭은 실제 프로젝트만(demo- 거부)', () => {
    const rc = JSON.stringify({ projects: { default: 'demo-musicweb', prod: 'p' } });
    expect(projectIdFor(rc, 'prod')).toBe('p');
    expect(projectIdFor(rc, 'default')).toBeNull();
    expect(projectIdFor(rc, 'nope')).toBeNull();
  });

  it('저장소의 .firebaserc: 기본은 가짜 프로젝트(에뮬레이터), prod는 실제 프로젝트', () => {
    const rc = readFileSync('.firebaserc', 'utf8');
    expect(projectIdFor(rc, 'default')).toBeNull();
    expect(projectIdFor(rc, 'prod')).toMatch(/^[a-z0-9-]+$/);
  });

  it('화면 설정: 다 있으면 통과', () => {
    expect(checkWebEnv(WEB_OK, 'p')).toEqual([]);
  });

  it('화면 설정: App Check 키 없음·다른 프로젝트·에뮬레이터 켜짐을 막는다', () => {
    const env = new Map(WEB_OK);
    env.set('VITE_RECAPTCHA_SITE_KEY', ' ');
    env.set('VITE_USE_EMULATORS', 'true');
    const p = checkWebEnv(env, 'other');
    expect(p.join('\n')).toContain('VITE_RECAPTCHA_SITE_KEY');
    expect(p.join('\n')).toContain('VITE_FIREBASE_PROJECT_ID가 배포할 프로젝트(other)');
    expect(p.join('\n')).toContain('VITE_USE_EMULATORS');
  });

  it('서버 매개변수: 파일 없음·빠진 값·형식 오류·가짜 스위치를 막는다', () => {
    expect(checkFunctionsEnv(null, 'p')[0]).toContain('functions/.env.p');
    const ok = new Map([
      ['ADMIN_EMAILS', '["a@example.com"]'],
      ['MB_CONTACT', 'https://p.web.app'],
    ]);
    expect(checkFunctionsEnv(ok, 'p')).toEqual([]);
    expect(checkFunctionsEnv(new Map([['ADMIN_EMAILS', 'a@example.com']]), 'p').join('\n')).toMatch(
      /MB_CONTACT[\s\S]*JSON 배열/,
    );
    for (const k of ['MUSICWEB_FAKE_EXTERNAL', 'FUNCTIONS_EMULATOR'])
      expect(checkFunctionsEnv(new Map([...ok, [k, 'true']]), 'p').join('\n'), k).toContain(k);
  });

  it('external 패키지 이름: 하위 경로·따옴표·scope', () => {
    expect(
      externalPackages(
        "esbuild x --external:firebase-admin --external:'firebase-admin/*' --external:@scope/pkg/sub --external:zod",
      ),
    ).toEqual(['firebase-admin', '@scope/pkg', 'zod']);
  });

  it('배포용 package.json: 묶지 않은 패키지만 설치된 정확한 버전으로, workspace:·묶인 패키지는 빠진다', () => {
    const pkg = JSON.parse(readFileSync('functions/package.json', 'utf8')) as Parameters<
      typeof deployPackageJson
    >[0];
    const out = deployPackageJson(pkg, (n) => `9.9.9-${n}`);
    expect(out.devDependencies).toBeUndefined();
    expect(Object.keys(out.dependencies ?? {}).sort()).toEqual(
      ['firebase-admin', 'firebase-functions', 'zod'].sort(),
    );
    expect(out.dependencies?.zod).toBe('9.9.9-zod');
    expect(JSON.stringify(out)).not.toMatch(/workspace:|link:|file:|\^/);
    expect(out.engines).toEqual(pkg.engines);
  });

  it('배포용 package.json: 실행 때 필요한 패키지가 workspace:거나 없으면 멈춘다', () => {
    const build = 'esbuild --external:@musicweb/shared --external:zod';
    expect(() =>
      deployPackageJson(
        { scripts: { build }, dependencies: { '@musicweb/shared': 'workspace:*', zod: '^4' } },
        () => '1.0.0',
      ),
    ).toThrow(/@musicweb\/shared/);
    expect(() =>
      deployPackageJson({ scripts: { build }, dependencies: {} }, () => '1.0.0'),
    ).toThrow(/zod/);
  });

  it('배포용 firebase 설정: functions 위치만 바꾸고 규칙·호스팅·헤더는 그대로', () => {
    const fj = JSON.parse(readFileSync('firebase.json', 'utf8')) as Parameters<
      typeof deployFirebaseJson
    >[0];
    const out = deployFirebaseJson(fj);
    expect(out.functions?.[0]?.source).toBe(DEPLOY_DIR);
    expect(out.functions?.[0]?.predeploy).toBeUndefined();
    expect(out.emulators).toBeUndefined();
    const hostingRest = { ...(fj.hosting as Record<string, unknown>) };
    delete hostingRest.predeploy;
    expect(out.hosting).toEqual(hostingRest);
    expect((out.hosting as Record<string, unknown>).predeploy).toBeUndefined();
    expect(out.firestore).toEqual(fj.firestore);
    expect(out.storage).toEqual(fj.storage);
  });
});
