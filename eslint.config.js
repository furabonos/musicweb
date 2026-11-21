import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FUNCTIONS_PROCESS_MESSAGE =
  'functions에서 process(process.env 포함)를 직접 쓰지 않습니다. 비밀값은 functions/src/config/secrets.ts의 secrets.<이름>.value()로, 그 밖의 설정은 functions/src/config/에 읽는 함수를 만들어 쓰세요.';

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
  {
    // 서버 비밀값·설정은 functions/src/config/에서만 읽는다 (SPEC 6.2, T02).
    files: ['functions/src/**/*.ts'],
    ignores: ['functions/src/config/**', 'functions/src/**/*.test.ts'],
    rules: {
      // process를 통째로 막는다: process.env, process['env'], const { env } = process, const p = process 모두 해당.
      'no-restricted-globals': ['error', { name: 'process', message: FUNCTIONS_PROCESS_MESSAGE }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name=/^(globalThis|global)$/][property.name='process']",
          message: FUNCTIONS_PROCESS_MESSAGE,
        },
        {
          selector:
            "MemberExpression[object.name=/^(globalThis|global)$/][property.value='process']",
          message: FUNCTIONS_PROCESS_MESSAGE,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'process', message: FUNCTIONS_PROCESS_MESSAGE },
            { name: 'node:process', message: FUNCTIONS_PROCESS_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
