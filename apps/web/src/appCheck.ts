import type { FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

/**
 * App Check (T23, SPEC 6.1). 서버는 실제 배포에서 App Check 토큰이 없는 호출을 모두 거부한다.
 * 에뮬레이터에 붙을 때는 켜지 않는다(서버도 에뮬레이터에서는 강제하지 않음).
 * 사이트 키가 없으면 켤 수 없다: 배포 준비(tools/prepare-deploy.ts)가 키 없는 빌드를 막는다.
 */
export function appCheckSiteKey(siteKey: string | undefined, useEmulators: boolean): string | null {
  if (useEmulators) return null;
  const key = siteKey?.trim();
  return key ? key : null;
}

export function startAppCheck(app: FirebaseApp, siteKey: string | null): void {
  if (!siteKey) {
    console.error(
      '[musicweb] VITE_RECAPTCHA_SITE_KEY가 없어 App Check를 켜지 못했습니다. 서버 호출이 거부됩니다.',
    );
    return;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
