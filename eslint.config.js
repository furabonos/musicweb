import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FUNCTIONS_PROCESS_MESSAGE =
  'functions에서 process(process.env 포함)를 직접 쓰지 않습니다. 비밀값은 functions/src/config/secrets.ts의 secrets.<이름>.value()로, 그 밖의 설정은 functions/src/config/에 읽는 함수를 만들어 쓰세요.';

const FUNCTIONS_NETWORK_MESSAGE =
  '외부 호출은 functions/src/adapters/에서만 합니다(호출마다 budget.reserve()를 거치게 하기 위함). 필요한 호출을 어댑터 함수로 만들고 그 함수를 쓰세요.';

// 테스트와 테스트 도우미(functions/src/testing/, 배포 빌드에서 빠짐)는 실행 코드 제한을 받지 않는다.
const FUNCTIONS_TEST_FILES = ['functions/src/**/*.test.ts', 'functions/src/testing/**'];

// 네트워크를 여는 Node 내장 모듈 (node: 접두어 유무 둘 다 막는다).
const NODE_NETWORK_BUILTINS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'child_process'];
// 네트워크 클라이언트·외부 API SDK. 어댑터(adapters/) 안에서만 쓴다.
const NETWORK_PACKAGES = [
  'undici',
  'axios',
  'node-fetch',
  'got',
  'ky',
  'superagent',
  'googleapis',
  'openai',
];
const NETWORK_PACKAGE_PATTERNS = [
  '@anthropic-ai/*',
  '@googleapis/*',
  '@octokit/*',
  'googleapis/*',
  'openai/*',
];
const NETWORK_SOURCE_REGEX =
  '/^(node:)?(' +
  NODE_NETWORK_BUILTINS.join('|') +
  ')$|^(' +
  NETWORK_PACKAGES.join('|') +
  ')(\\/|$)|^@(anthropic-ai|googleapis|octokit)\\//';

const YOUTUBE_WRITE_MESSAGE =
  'YouTube 재생목록 쓰기는 functions/src/adapters/youtube-write.ts의 createPlaylist·addItems로만 합니다(사용자의 기존 재생목록 보호, SPEC 6.2). 그 두 함수를 쓰세요.';
const YOUTUBE_READ_METHOD_MESSAGE =
  'youtube-read.ts는 읽기(GET)만 합니다. 쓰기는 functions/src/adapters/youtube-write.ts의 createPlaylist·addItems를 쓰세요.';
// YouTube 재생목록 쓰기 주소(playlists, playlistItems). 읽기 어댑터는 playlistItems.list(GET)만 쓸 수 있다.
const YT_PLAYLIST_PATH = '/youtube\\/v3\\/playlist/i';
const YT_PLAYLISTS_PATH = '/youtube\\/v3\\/playlists/i';
// `${API}/playlists?…`처럼 기본 주소를 따로 둔 경우의 경로 조각. Firestore 경로(`playlists/${id}`)와 부딪히므로 adapters에만 건다.
const YT_PLAYLIST_FRAGMENT = '/(^|\\/)playlist(s|Items)(\\?|\\/|$)/i';
const YT_PLAYLISTS_FRAGMENT = '/(^|\\/)playlists(\\?|\\/|$)/i';
const YT_EXPORTS_MESSAGE =
  'ytExports(이 앱이 만든 YouTube 재생목록 기록)는 functions/src/adapters/youtube-write.ts만 씁니다. 여기에 아무 ID나 적으면 addItems가 사용자의 기존 재생목록에 쓰게 됩니다. 정리·계정 삭제처럼 꼭 필요하면 eslint.config.js에 그 파일만 예외로 추가하고 이유를 적으세요.';

/** YouTube 쓰기 주소·패키지 금지. mode: 'ban'(전부 금지) | 'readOnly'(youtube-read.ts: playlistItems GET만). */
function youtubeWriteBan(mode, { fragments = false } = {}) {
  const readOnly = mode === 'readOnly';
  const pathRegexes = [readOnly ? YT_PLAYLISTS_PATH : YT_PLAYLIST_PATH];
  if (fragments) pathRegexes.push(readOnly ? YT_PLAYLISTS_FRAGMENT : YT_PLAYLIST_FRAGMENT);
  const syntax = [];
  for (const re of pathRegexes) {
    syntax.push(
      { selector: `Literal[value=${re}]`, message: YOUTUBE_WRITE_MESSAGE },
      { selector: `TemplateElement[value.raw=${re}]`, message: YOUTUBE_WRITE_MESSAGE },
    );
  }
  syntax.push({
    selector: 'ImportExpression[source.value=/^(googleapis|@googleapis\\/youtube)(\\/|$)/]',
    message: YOUTUBE_WRITE_MESSAGE,
  });
  if (readOnly) {
    syntax.push({
      selector:
        "Property[key.name='method']:not([value.value='GET']), Property[key.value='method']:not([value.value='GET']), AssignmentExpression[left.property.name='method']:not([right.value='GET'])",
      message: YOUTUBE_READ_METHOD_MESSAGE,
    });
  }
  return {
    syntax,
    paths: [{ name: 'googleapis', message: YOUTUBE_WRITE_MESSAGE }],
    patterns: [
      {
        group: ['googleapis/*', '@googleapis/youtube', '@googleapis/youtube/*'],
        message: YOUTUBE_WRITE_MESSAGE,
      },
    ],
  };
}

const GLOBAL_OBJECT_MESSAGE =
  '전역 객체(globalThis·global)를 직접 쓰지 않습니다. 비밀값·설정은 functions/src/config/secrets.ts 등 config/에서 읽고, 외부 호출은 functions/src/adapters/의 함수를 쓰세요.';

/** functions 묶음별 제한 규칙을 만든다. 같은 규칙을 두 블록에 나눠 쓰면 덮어쓰므로 한 번에 만든다. */
function functionsRules({
  process: banProcess,
  network: banNetwork,
  youtubeWrite = 'ban',
  ytExports = 'ban',
}) {
  // globalThis·global을 통째로 막는다: const g = globalThis; g.process / g.fetch 같은 우회 방지.
  const globalsBan = [
    {
      name: 'globalThis',
      message: GLOBAL_OBJECT_MESSAGE,
    },
    {
      name: 'global',
      message: GLOBAL_OBJECT_MESSAGE,
    },
  ];
  const syntaxBan = [];
  const importPaths = [];
  const importPatterns = [];
  if (banProcess) {
    globalsBan.push({ name: 'process', message: FUNCTIONS_PROCESS_MESSAGE });
    importPaths.push(
      { name: 'process', message: FUNCTIONS_PROCESS_MESSAGE },
      { name: 'node:process', message: FUNCTIONS_PROCESS_MESSAGE },
    );
    syntaxBan.push({
      selector: 'ImportExpression[source.value=/^(node:)?process$/]',
      message: FUNCTIONS_PROCESS_MESSAGE,
    });
  }
  if (banNetwork) {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
      globalsBan.push({ name, message: FUNCTIONS_NETWORK_MESSAGE });
    }
    for (const name of NODE_NETWORK_BUILTINS) {
      importPaths.push(
        { name, message: FUNCTIONS_NETWORK_MESSAGE },
        { name: `node:${name}`, message: FUNCTIONS_NETWORK_MESSAGE },
      );
    }
    for (const name of NETWORK_PACKAGES)
      importPaths.push({ name, message: FUNCTIONS_NETWORK_MESSAGE });
    importPatterns.push({ group: NETWORK_PACKAGE_PATTERNS, message: FUNCTIONS_NETWORK_MESSAGE });
    // no-restricted-imports는 동적 import()를 보지 않으므로 문법 규칙으로 막는다.
    syntaxBan.push(
      {
        selector: `ImportExpression[source.value=${NETWORK_SOURCE_REGEX}]`,
        message: FUNCTIONS_NETWORK_MESSAGE,
      },
      {
        selector: "ImportExpression[source.type!='Literal']",
        message:
          '모듈 이름을 계산해서 import()하지 않습니다(검사를 피할 수 있음). 고정된 이름으로 import하고, 외부 호출 모듈은 functions/src/adapters/에서만 쓰세요.',
      },
    );
  }
  if (youtubeWrite !== 'allow') {
    // 네트워크가 열린 곳(adapters)은 기본 주소를 따로 둔 경로 조각까지 막는다.
    const yt = youtubeWriteBan(youtubeWrite, { fragments: !banNetwork });
    syntaxBan.push(...yt.syntax);
    if (ytExports === 'ban') {
      syntaxBan.push({
        selector: 'Literal[value=/ytExports/], TemplateElement[value.raw=/ytExports/]',
        message: YT_EXPORTS_MESSAGE,
      });
    }
    // 네트워크 금지 묶음은 googleapis를 이미 막으므로 같은 이름을 두 번 넣지 않는다.
    if (!banNetwork) {
      importPaths.push(...yt.paths);
      importPatterns.push(...yt.patterns);
    }
  }
  const rules = { 'no-restricted-globals': ['error', ...globalsBan] };
  if (syntaxBan.length) rules['no-restricted-syntax'] = ['error', ...syntaxBan];
  if (importPaths.length || importPatterns.length) {
    rules['no-restricted-imports'] = ['error', { paths: importPaths, patterns: importPatterns }];
  }
  return rules;
}

const WEB_SERVER_IMPORT_MESSAGE =
  '화면 코드(apps/web)는 서버 코드를 import하지 않습니다. 필요한 타입·규칙은 packages/shared로 옮겨 쓰고, 서버 호출은 firebase/functions의 httpsCallable을 쓰세요.';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/lib/**', '**/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Node 전역(process, Buffer 등)은 서버·도구·설정 파일에만 허용한다.
    files: [
      'functions/**/*.ts',
      'tools/**/*.ts',
      'packages/**/*.ts',
      '*.{js,ts}',
      '.claude/hooks/**/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 화면 코드는 YouTube 재생목록 쓰기 주소를 쓰지 않는다 (SPEC 6.2).
      'no-restricted-syntax': ['error', ...youtubeWriteBan('ban').syntax],
      // 화면 코드는 서버 코드·서버 전용 패키지를 가져오지 않는다 (SPEC 6.2).
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'functions', message: WEB_SERVER_IMPORT_MESSAGE }],
          patterns: [
            {
              group: [
                'firebase-admin',
                'firebase-admin/*',
                'firebase-functions',
                'firebase-functions/*',
                '@anthropic-ai/sdk',
                '@anthropic-ai/sdk/*',
                'googleapis',
                'googleapis/*',
                '@googleapis/*',
              ],
              message: WEB_SERVER_IMPORT_MESSAGE,
            },
            {
              // ../../functions, ../../functions/src, ../../functions/package.json 같은 상대 경로
              regex: '^(\\.{1,2}/)+functions(/|$)',
              message: WEB_SERVER_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // functions 코드 제한 (SPEC 6.2). ESLint는 같은 규칙이 여러 블록에 있으면 뒤의 것으로 덮으므로,
  // 파일 묶음을 겹치지 않게 나누고 필요한 제한만 합쳐 넣는다.
  //   core·api·jobs 등: process 금지 + 네트워크 금지
  //   config/:          네트워크 금지 (process 허용)
  //   adapters/:        process 금지 (네트워크 허용)
  // YouTube 재생목록 쓰기는 adapters/youtube-write.ts에서만, youtube-read.ts는 GET 읽기만.
  {
    files: ['functions/src/**/*.ts'],
    ignores: [
      'functions/src/config/**',
      'functions/src/adapters/**',
      'functions/src/jobs/purge.ts',
      ...FUNCTIONS_TEST_FILES,
    ],
    rules: functionsRules({ process: true, network: true }),
  },
  {
    // 30일 정리(T11, D-028)는 만든 지 30일 지난 ytExports 기록을 지운다. 예외는 이 파일 전체에 걸리므로
    // 지우기 말고 쓰기를 넣지 않는다(리뷰로 확인). 다른 금지(process·네트워크·YouTube 쓰기)는 그대로다.
    files: ['functions/src/jobs/purge.ts'],
    rules: functionsRules({ process: true, network: true, ytExports: 'allow' }),
  },
  {
    files: ['functions/src/config/**/*.ts'],
    ignores: FUNCTIONS_TEST_FILES,
    rules: functionsRules({ process: false, network: true }),
  },
  {
    files: ['functions/src/adapters/**/*.ts'],
    ignores: [
      'functions/src/adapters/youtube-write.ts',
      'functions/src/adapters/youtube-read.ts',
      ...FUNCTIONS_TEST_FILES,
    ],
    rules: functionsRules({ process: true, network: false }),
  },
  {
    files: ['functions/src/adapters/youtube-write.ts'],
    rules: functionsRules({ process: true, network: false, youtubeWrite: 'allow' }),
  },
  {
    files: ['functions/src/adapters/youtube-read.ts'],
    rules: functionsRules({ process: true, network: false, youtubeWrite: 'readOnly' }),
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
