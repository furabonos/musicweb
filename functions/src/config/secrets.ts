import { defineList, defineSecret, defineString } from 'firebase-functions/params';
import { SERVER_SECRET_NAMES, type ServerSecretName } from './secret-names.js';

/**
 * 서버 비밀값과 설정값을 읽는 유일한 곳 (SPEC 6.2, D-017).
 * - 비밀값은 Secret Manager에 저장되고, 함수마다 `secrets: [...]` 옵션으로 연결해야 실행 중에 읽을 수 있다.
 * - 로컬 에뮬레이터는 functions/.secret.local(gitignore)에서 읽는다. 예시는 .secret.local.example.
 * - 다른 파일에서 process.env로 비밀값을 읽지 않는다 (ESLint no-restricted-properties가 막음).
 */
export const secrets = Object.fromEntries(
  SERVER_SECRET_NAMES.map((name) => [name, defineSecret(name)]),
) as Record<ServerSecretName, ReturnType<typeof defineSecret>>;

/** 관리자 Google 계정 이메일 목록 (비밀 아님, 배포 시 입력). */
export const ADMIN_EMAILS = defineList('ADMIN_EMAILS');

/** MusicBrainz·ListenBrainz User-Agent 연락처 (스킬 music-data-terms). */
export const MB_CONTACT = defineString('MB_CONTACT');

/** 아직 정하지 않은 비밀값에 넣는 자리 표시. Secret Manager는 빈 값을 받지 않을 수 있어 이 글자를 넣는다(T23). */
export const UNSET_SECRET = 'none';

/** 없어도 되는 비밀값(AI·Last.fm·GitHub 토큰): 비었거나 `none`이면 '' (= 없음으로 동작) */
export function optionalValue(raw: string): string {
  const v = raw.trim();
  return v.toLowerCase() === UNSET_SECRET ? '' : v;
}

export type OptionalSecretName = 'ANTHROPIC_API_KEY' | 'LASTFM_API_KEY' | 'GITHUB_ISSUE_TOKEN';

export function optionalSecret(name: OptionalSecretName): string {
  return optionalValue(secrets[name].value());
}
