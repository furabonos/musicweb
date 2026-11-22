import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import {
  ApiError,
  type CreateResult,
  type MusicwebApi,
  type OpenLinkMode,
  type PlayableItem,
  type SharedPlaylist,
} from './api';

/**
 * Firebase로 서버를 부른다 (T14). 클라이언트는 Firestore에 쓰지 않는다: 모든 변경은 callable(SPEC 6.2).
 * VITE_USE_EMULATORS=true면 로컬 에뮬레이터(Auth 9099, Functions 5001)에 붙는다.
 */
// 개발 서버(DEV)에서만 켤 수 있다. 운영 빌드에서는 이 분기가 통째로 빠진다(scan:bundle이 흔적을 검사).
const USE_EMULATORS = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';

export function createFirebaseApi(): MusicwebApi {
  const env = import.meta.env;
  // 에뮬레이터는 가짜 프로젝트(demo-musicweb)와 아무 키나 받는다
  const config = USE_EMULATORS
    ? { apiKey: 'fake-api-key', projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'demo-musicweb' }
    : {
        apiKey: env.VITE_FIREBASE_API_KEY ?? '',
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
        projectId: env.VITE_FIREBASE_PROJECT_ID ?? '',
        appId: env.VITE_FIREBASE_APP_ID ?? '',
      };
  const app = initializeApp(config);
  const auth = getAuth(app);
  const functions = getFunctions(app);
  if (USE_EMULATORS) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    // e2e 전용 로그인: Auth 에뮬레이터는 서명 없는 Google 토큰을 받는다. 운영 빌드에서는 이 분기가 빠진다.
    (window as unknown as { __musicwebE2E?: unknown }).__musicwebE2E = {
      signIn: (email: string) =>
        signInWithCredential(
          auth,
          GoogleAuthProvider.credential(
            JSON.stringify({ sub: `google-${email}`, email, email_verified: true }),
          ),
        ).then(() => syncClaims()),
    };
  }

  const call = async <T>(name: string, data: unknown): Promise<T> => {
    try {
      return (await httpsCallable(functions, name)(data)).data as T;
    } catch (err) {
      const e = err as { code?: string; details?: ApiError['details'] };
      throw new ApiError((e.code ?? 'internal').replace(/^functions\//, ''), e.details ?? {});
    }
  };
  // 로그인 직후 관리자 표시를 목록에 맞춘다(D-022). 실패해도 화면 사용은 계속된다.
  const syncClaims = async () => {
    try {
      const r = await call<{ changed: boolean }>('account-syncClaims', {});
      if (r.changed) await auth.currentUser?.getIdToken(true);
    } catch {
      // 관리자 표시는 보조(서버 함수는 목록으로 직접 확인)
    }
  };

  return {
    onUser: (cb) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid } : null)),
    async signIn() {
      await signInWithPopup(auth, new GoogleAuthProvider());
      await syncClaims();
    },
    signOut: () => signOut(auth),
    create: (text, locale) => call<CreateResult>('playlists-create', { text, locale }),
    update: (id, action, position) =>
      call<{ items: PlayableItem[] }>('playlists-update', { id, action, position }),
    save: (id) => call<{ id: string; state: 'saved' }>('playlists-save', { id }),
    reportEmbedBlocked: async (code) => {
      await call('playback-reportEmbedBlocked', { code });
    },
    getPlaylist: (id) => call<SharedPlaylist>('playlists-get', { id }),
    siteConfig: () => call<{ openLink: OpenLinkMode }>('site-config', {}),
  };
}
