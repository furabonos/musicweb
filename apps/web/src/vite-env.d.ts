/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_RECAPTCHA_SITE_KEY?: string;
  /** "true"면 로컬 에뮬레이터에 붙는다(개발·e2e 전용) */
  readonly VITE_USE_EMULATORS?: string;
}
