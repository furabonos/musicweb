/**
 * 서버에만 있어야 하는 비밀값 이름 (SPEC 8장). 값은 Secret Manager(defineSecret)에만 둔다.
 * 이 목록은 화면 빌드 결과 검사(tools/scan-bundle.ts)에서도 쓴다. 이름이 번들에 보이면 실패.
 * 비밀값을 추가하면: 여기, secrets.ts, SPEC 8장, functions/.secret.local.example, CI를 같이 고친다.
 */
export const SERVER_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'YOUTUBE_API_KEY',
  'LASTFM_API_KEY',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'TOKEN_ENC_KEY',
  'ACTOR_HASH_KEY',
  'GITHUB_ISSUE_TOKEN',
] as const;

export type ServerSecretName = (typeof SERVER_SECRET_NAMES)[number];
