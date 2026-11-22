# CLAUDE.md

## 프로젝트

말로 요청하면 비슷한 곡 재생목록을 만들어 YouTube 삽입 플레이어로 틀어 주는 PC 전용 공개 웹사이트 (Firebase + Vite/React + Cloud Functions, pnpm 모노레포).
기준 문서는 `docs/SPEC.md`이므로 기능 작업 전에 해당 장을 먼저 읽는다. 작업은 `docs/TASKS.md`, 결정은 `docs/DECISIONS.md`, 어디를 고칠지는 `docs/FEATURE_MAP.md`에서 찾는다.

## 작업 방식

- 기능 요청 시 `docs/SPEC.md`와 `docs/TASKS.md`를 확인하고 먼저 계획을 제시한다
- 구현 후 반드시 테스트와 린트를 실행한다
- 테스트가 통과하기 전까지 완료라고 하지 않는다
- 새 기능에는 테스트를 함께 작성한다
- 중요한 설계 결정은 `docs/DECISIONS.md`에 이유와 함께 기록한다
- YouTube 호출·저장·플레이어를 건드리면 `youtube-policy`, 음악 데이터는 `music-data-terms`, 곡 연결 규칙은 `song-matching` 스킬을 먼저 읽는다

## 명령

pnpm 10(`npm i -g pnpm@10`, Node 26에는 corepack이 없음). 에뮬레이터는 Java 21(`brew install openjdk@21`) 필요하며 `tools/with-java.sh`가 경로를 찾아 준다.

- lint: `pnpm lint`
- format 검사 / 고치기: `pnpm format:check` / `pnpm format`
- typecheck: `pnpm typecheck`
- unit test: `pnpm test` (`*.int.test.ts` 제외)
- 단일 테스트: `pnpm vitest run <파일>`
- functions 빌드: `pnpm --filter functions build` (tsc 타입 검사 + esbuild로 `lib/index.js` 한 파일, `@musicweb/shared` 포함, D-027)
- 통합: `pnpm test:int` (functions 빌드 → `tools/emulator-env.sh`로 에뮬레이터 매개변수 파일 생성 → 에뮬레이터 띄움 → `*.int.test.ts` 실행 → 종료)
- 에뮬레이터만 띄우기: `pnpm emulators` (프로젝트 `demo-musicweb`, 실제 Firebase에 연결 안 됨)
- 화면 개발 서버: `pnpm --filter web dev`, 빌드: `pnpm --filter web build`
- 화면 빌드에 서버 비밀값이 섞였는지 검사: `pnpm scan:bundle` (빌드 포함, Firebase 웹 키는 `VITE_FIREBASE_API_KEY` 값만 허용)
- 보안 규칙: `pnpm test:rules` (Firestore·Storage 에뮬레이터 띄움 → `tests/rules/*.test.ts` 실행 → 종료)
- 음악 데이터 녹화 응답 다시 받기: `node --experimental-strip-types tools/record-music-fixtures.ts [파일 이름]` (실제 공개 API에 요청, 초당 1회 이하)
- 요청 해석 실제 모델 시험: `ANTHROPIC_API_KEY=… pnpm eval:parse` (실제 AI 호출 — 돈이 들므로 사용자 승인 후. 결과는 `evals/parse/baseline.json`)
- e2e: `pnpm test:e2e` (functions 빌드 → 에뮬레이터(가짜 AI·음악 데이터, D-031) → 화면 개발 서버 → `apps/web/e2e/*.spec.ts`, Playwright). 처음 한 번 `pnpm --filter web exec playwright install chromium`
- 화면을 가짜 데이터로 직접 보기: `pnpm emulators` → 다른 창에서 `pnpm emulators:seed`(가짜 곡 16곡) → `pnpm --filter web dev:emulators` (관리자 admin@example.com으로 로그인, Auth 에뮬레이터 창에서 입력)
- 아직 없음: `pnpm eval`(T17). 생기면 이 절을 고친다.

## 아키텍처 규칙 (SPEC 6.2 요약, 위반은 lint·테스트·규칙이 막는다)

- 클라이언트는 Firestore에 직접 쓰지 않는다. 모든 쓰기는 Functions를 거친다. 보안 규칙은 기본적으로 전부 거부한다.
- 외부 호출은 `functions/src/adapters/`에서만 한다. 모든 호출은 `budget.reserve()`를 먼저 거친다.
- YouTube 쓰기는 `youtube-write.ts`의 두 함수로만 한다. 이 앱이 만든 재생목록에만 쓴다.
- 비밀값은 `functions/src/config/secrets.ts`(`defineSecret`)로만 읽는다. `apps/web`은 서버 패키지를 import하지 않는다.
- 이벤트 로그·이슈·현황판에 검색 문장, 재생목록 이름, 이메일, uid 원문을 넣지 않는다.
- 사용자 입력과 외부 텍스트는 AI에 데이터로만 넘긴다(도구 없음, 구조화 출력). 결과는 후보 목록 안의 곡으로만 받는다.
- YouTube 데이터는 30일 안에 재확인하거나 삭제한다. 음원·영상 파일은 저장하지 않는다.
- main에 직접 push하지 않는다. 브랜치를 만들어 PR로 올린다.
- 작업(T##)이 끝나 커밋하면 Claude가 PR을 올리고 검증해 합친다(D-025): 깨끗한 새 사본에서 설치·lint·format·typecheck·unit·rules·int·번들 검사 → GitHub 필수 검사 통과 → 검증한 커밋 그대로일 때만(`--match-head-commit`) merge commit으로 합침 → main을 받아 옴. 하나라도 실패하면 합치지 않고 보고한다.

## 환경 변수

- 목록과 위치는 SPEC 8장에 있다.
- 서버 비밀값은 `defineSecret`으로 읽고, 로컬 값은 `functions/.secret.local`(gitignore)에 둔다. 웹 설정은 `apps/web/.env.local`에 둔다.
- 변수를 추가하면 SPEC 8장, `functions/src/config/secrets.ts`, CI 워크플로를 같이 고친다.
