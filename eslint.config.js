import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WEB_SERVER_IMPORT_MESSAGE =
  '화면 코드(apps/web)는 서버 코드를 import하지 않습니다. 필요한 타입·규칙은 packages/shared로 옮겨 쓰고, 서버 호출은 firebase/functions의 httpsCallable을 쓰세요.';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/lib/**', '**/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Node 전역(process, Buffer 등)은 서버·도구·설정 파일에만 허용한다.
    files: ['functions/**/*.ts', 'tools/**/*.ts', 'packages/**/*.ts', '*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 화면 코드는 서버 코드를 가져오지 않는다 (SPEC 6.2). 세부 규칙은 T02에서 확장.
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'functions', message: WEB_SERVER_IMPORT_MESSAGE }],
          patterns: [
            {
              group: [
                '**/functions/src/**',
                '**/functions/lib/**',
                'firebase-admin',
                'firebase-admin/*',
                'firebase-functions',
                'firebase-functions/*',
              ],
              message: WEB_SERVER_IMPORT_MESSAGE,
            },
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
