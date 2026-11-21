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
