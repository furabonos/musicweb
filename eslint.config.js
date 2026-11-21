import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FUNCTIONS_PROCESS_MESSAGE =
  'functions에서 process(process.env 포함)를 직접 쓰지 않습니다. 비밀값은 functions/src/config/secrets.ts의 secrets.<이름>.value()로, 그 밖의 설정은 functions/src/config/에 읽는 함수를 만들어 쓰세요.';

const FUNCTIONS_NETWORK_MESSAGE =
  '외부 호출은 functions/src/adapters/에서만 합니다(호출마다 budget.reserve()를 거치게 하기 위함). 필요한 호출을 어댑터 함수로 만들고 그 함수를 쓰세요.';

const FUNCTIONS_TEST_FILES = ['functions/src/**/*.test.ts'];

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

const GLOBAL_OBJECT_MESSAGE =
  '전역 객체(globalThis·global)를 직접 쓰지 않습니다. 비밀값·설정은 functions/src/config/secrets.ts 등 config/에서 읽고, 외부 호출은 functions/src/adapters/의 함수를 쓰세요.';

/** functions 묶음별 제한 규칙을 만든다. 같은 규칙을 두 블록에 나눠 쓰면 덮어쓰므로 한 번에 만든다. */
function functionsRules({ process: banProcess, network: banNetwork }) {
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
  {
    files: ['functions/src/**/*.ts'],
    ignores: ['functions/src/config/**', 'functions/src/adapters/**', ...FUNCTIONS_TEST_FILES],
    rules: functionsRules({ process: true, network: true }),
  },
  {
    files: ['functions/src/config/**/*.ts'],
    ignores: FUNCTIONS_TEST_FILES,
    rules: functionsRules({ process: false, network: true }),
  },
  {
    files: ['functions/src/adapters/**/*.ts'],
    ignores: FUNCTIONS_TEST_FILES,
    rules: functionsRules({ process: true, network: false }),
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
