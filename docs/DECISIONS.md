# 설계 결정 기록

중요한 설계 결정과 그 이유. 새 결정은 아래에 번호를 이어 붙인다. 외부 조건의 출처는 `docs/RESEARCH.md`.

## D-001 작업 방식: /spec · /feature · code-reviewer · Stop 훅 (2026-11-21)

- 요구사항은 `docs/SPEC.md`, 작업은 `docs/TASKS.md`(T## 번호)로 관리한다.
- `/feature T##`로 작업 하나를 계획 → 테스트·구현 → 검증 → 리뷰 → 커밋까지 처리한다.
- `.claude/hooks/stop-check.sh` Stop 훅:
  - 종료할 때 `pnpm -s lint`와 `pnpm -s test`를 돌리고, 실패하면 종료를 막는다.
  - 같은 세션에서 연속 3번 막은 뒤에는 종료를 허용한다.
  - `package.json`이 없으면(T00 전) 검사를 건너뛴다.
- **이유**: 작업마다 같은 품질 게이트를 강제하고, 고칠 수 없는 실패에서는 무한 루프 대신 사용자에게 보고하게 하기 위함. 느린 검사(typecheck·rules·e2e·eval)는 훅에서 빼고 `/feature`와 CI에서 돌린다.

## D-002 Vite + React SPA + Firebase Hosting + Cloud Functions (2026-11-21)

- **이유**:
  - PC 전용이고 검색엔진 노출이 중요하지 않다.
  - 정적 Hosting이 가장 싸고 단순하다.
  - Next.js용 App Hosting은 GA지만 비용·구조가 더 복잡하다. Hosting의 프레임워크 자동 배포는 아직 실험 단계다.
- **대가**: 공유 링크 미리보기(OG 태그)가 필요하면 함수 하나로 따로 처리해야 한다.

## D-003 pnpm 모노레포 + Vitest + 에뮬레이터 + Playwright (2026-11-21)

- `apps/web`, `functions`, `packages/shared`로 나눈다.
- **이유**: 곡 연결 규칙·스키마·`MusicService` 인터페이스를 화면·서버·시험 문제가 함께 쓴다. 보안 규칙은 에뮬레이터로만 제대로 시험할 수 있다.

## D-004 YouTube 데이터 30일 규칙과 곡 목록 구조 (2026-11-21)

- YouTube에서 받은 데이터는 영상 ID 포함 전부 30일 안에 재확인하거나 삭제한다. 25일째 재확인, 30일째 무조건 삭제.
- 곡 정보(아티스트·제목·장르·연도)는 음악 데이터(MusicBrainz·Wikidata)가 원천이다. YouTube에서는 "이 곡을 틀 영상 ID"만 연결한다. 화면에 곡 정보의 출처를 표시한다.
- **이유**:
  - 개발자 정책 III.E.4의 30일 조항
  - "파생 데이터 금지"·"여러 채널 합치기 금지" 조항의 위험을 줄이기 위함
- **대가**: 할당량 증가 심사에서 여전히 질문받을 수 있다(SPEC 10장).

## D-005 비상업, 무료 음악 데이터 우선 (2026-11-21)

- 비슷한 곡은 ListenBrainz Labs가 주 재료, Last.fm `getSimilar`가 보조다.
- 곡·연도·YouTube 링크는 MusicBrainz 핵심 데이터(CC0)와 Wikidata(CC0)에서 가져온다.
- 장르는 Wikidata P136을 먼저 쓰고, MusicBrainz 태그(CC BY-NC-SA)는 출처를 표시하고 쓴다.
- Spotify는 쓰지 않는다.
- **이유**: Last.fm은 비상업 전용이고 저장 상한(100MB)과 표시 의무가 있다. 그래서 오래 쌓아 두는 주 재료로는 맞지 않는다.

## D-006 "YouTube에서 열기"는 비공식 링크 + 매일 확인 (2026-11-21)

- `watch_videos?video_ids=` 링크를 쓴다. 매일 303·`list=` 응답을 확인하고, 깨지면 자동 이슈를 만들고 곡별 링크 목록으로 바꾼다.
- **이유**: 로그인 없이 YouTube에 여러 곡을 넘기는 공식 방법이 없다. 2026-11-21에 실제로 동작하는 것을 확인했다.
- 이 확인 요청은 "웹 페이지 긁기 금지"의 유일한 예외다. 응답 헤더만 보고, 본문은 읽지 않는다.

## D-007 검색 하루 100회 배분 (2026-11-21)

- 사용자 요청 80회(사용자별 3회) + 야간 작업 20회.
- **이유**: search.list는 단위가 아니라 하루 100회로 따로 묶여 있다.

## D-008 자동 수정은 Claude Code GitHub Action (2026-11-21)

- `auto-fix` 라벨이 붙은 이슈에서 실행한다. 하루 3회 상한. 자동 합침은 하지 않는다.
- **이유**: PC가 꺼져 있어도 돌아가고, 기록이 GitHub에 남아 현황판에서 집계하기 쉽다.

## D-009 공개 GitHub 저장소 + main 보호 (2026-11-21)

- 저장소 `musicweb`은 공개다. main은 PR과 CI가 있어야 합칠 수 있고, 비밀값 push 보호를 켠다.
- **이유**: 현황판의 PR 링크를 누구나 열 수 있어야 한다. 공개 저장소에서는 무료로 보호 규칙을 쓸 수 있다.
- **대가**: 비밀값이 한 번이라도 커밋되면 노출된다. 그래서 T01을 앞쪽에 둔다.

## D-010 직접 소유 도메인 (2026-11-21)

- 도메인을 새로 구입해 T27에서 연결한다. 그 전까지는 `*.web.app`을 쓴다.
- **이유**: Google 민감 권한 심사는 소유 확인된 도메인의 홈페이지와 개인정보 처리방침을 요구한다. `web.app` 주소로 소유 확인이 되는지는 확인하지 못했고, 안전하게 직접 소유 도메인을 쓴다.

## D-011 "내 계정에 바로 넣기"를 1단계에 테스트 사용자 전용으로 구현 (2026-11-21)

- **이유**: 심사에는 동의 화면부터 기능 끝까지 보여 주는 시연 영상이 필요하다.
- 권한은 `youtube.force-ssl`이다. 재생목록 전용 좁은 권한이 없으므로 "기존 재생목록을 바꾸지 않는다"는 쓰기 어댑터(T05)로 보장한다.

## D-012 한도와 비용 차단 방식 (2026-11-21)

- 초기 한도는 SPEC 6.3의 보수적 값이다.
- 예산을 넘으면 앱 자체 상한으로 기능을 끈다. Functions에는 예산 정지를 걸고, 월 $10 알림을 둔다.
- 프로젝트 결제 자동 해제는 하지 않는다.
- **이유**: 예산 알림은 결제를 멈추지 않는다. 결제 자동 해제는 서비스 전체가 멈추고 자원이 삭제될 위험이 있다.

## D-013 화면 언어: 기본 영어 + 언어 버튼 (2026-11-21)

- **[PLAN 변경]** 브라우저 언어·접속 국가 판별을 하지 않는다. 기본은 영어이고, 상단 언어 버튼으로 바꾸며 선택을 기억한다.
- **이유**: 사용자 결정. 접속 국가 판별은 바로 쓸 수 있는 방법이 없다.

## D-014 AI 모델: Claude Haiku 5.5 (2026-11-21)

- 요청 해석, 곡 고르기·정렬·이유, 애매한 제목 판정에 `claude-haiku-5-5`를 쓴다. 출력은 구조화 출력이고 도구는 없다.
- **이유**: PLAN 12의 "가벼운 모델"이다. 입력 100만 토큰당 $0.10, 출력 $0.50으로 1회 약 $0.0015(추정).

## D-015 로그인 전 배포 기간에는 만들기를 관리자에게만 (2026-11-21)

- **이유**: 작업 순서상 배포(T23)가 로그인(T24)보다 앞선다. 그 사이 공개 주소에서 누구나 AI·YouTube 비용을 쓰지 못하게 하기 위함이다.

## D-016 개발 도구 버전: pnpm 전역 설치, TypeScript 6, Java 21 (T00, 2026-11-21)

- pnpm은 `npm i -g pnpm@10`으로 설치한다. 루트 `packageManager`에 버전을 적는다.
- TypeScript는 `^6`으로 고정한다. TS 7로 올리는 조건은 typescript-eslint가 TS 7을 공식 지원하는 것이다.
- Firebase 에뮬레이터용 Java 21은 Homebrew `openjdk@21`로 설치한다. `tools/with-java.sh`가 시스템 경로를 바꾸지 않고, 실행할 때만 21 이상인 Java를 찾아 붙인다.
- 로컬 Node는 26, Functions 런타임은 22(`functions/package.json` engines)다. 에뮬레이터는 "버전 불일치" 경고만 내고 동작한다(T00에서 확인).
- `firebase-tools`는 루트 devDependency로 두어 버전을 고정한다(전역 설치 안 함).
- **이유**:
  - Node 26에는 corepack이 포함되어 있지 않다.
  - typescript-eslint 8.73은 TS 7에서 "does not support TS 7.0" 오류로 시작하지 않는다.
- **나중에 할 일**: functions가 `@musicweb/shared`(workspace 의존)를 쓰기 시작하면 Cloud Functions 원격 설치가 이를 풀지 못한다. 그 작업에서 번들링(esbuild 등)을 정한다.

## D-017 비밀값·main 보호를 여러 겹으로 (T01, 2026-11-21)

- **로컬 커밋 전 검사** (`tools/git-hooks/pre-commit.sh`, simple-git-hooks로 설치):
  - 스테이징된 내용을 꺼내 secretlint로 검사한다.
  - 같은 커밋의 `.gitignore`·`.secretlintignore`가 검사를 줄이지 못하게 gitignore 따르기를 끄고, 꺼낸 폴더의 ignore 파일을 지운다.
  - 비밀 파일 이름(`.env*`, `.secret.local`, `*.pem`, `*.key`, 서비스 계정 JSON)은 내용과 상관없이 막는다.
- **로컬 push 전 검사** (`tools/git-hooks/pre-push.sh`): `refs/heads/main`으로 가는 push를 거부한다.
- **Claude PreToolUse 훅** (`.claude/hooks/guard-git.mjs`): 다음을 막는다.
  - main push, 강제 push(`--force`·`+refspec`·`--mirror`·`--all`·`--prune`)
  - `--no-verify`·`-n`(줄여 쓴 형태 포함)
  - 훅 경로 변경, 훅을 끄는 환경 변수 대입
  - `env`/`sudo`/`bash -c`/`eval`로 감싼 형태
- **CI** (`secret-scan.yml`, job `gitleaks`): gitleaks 8.30.1 바이너리를 체크섬으로 고정해 전체 git 기록을 검사한다. PR·main push·매주·수동으로 실행한다.
- **GitHub**: main 보호(PR 필수, 필수 검사 `gitleaks`, 최신 상태 필수, 관리자 포함, 강제 push·삭제 금지, 대화 해결 필수). 비밀값 스캔·push 보호를 켠다.
  - 혼자 개발하므로 PR 승인 인원은 0명이다. 자기 PR은 승인할 수 없기 때문이다.
- **이유**:
  - 공개 저장소라 한 번 올라간 비밀값은 되돌릴 수 없다.
  - 로컬 훅은 `--no-verify` 등으로 건너뛸 수 있고, Claude 훅은 셸을 완벽히 해석할 수 없다.
  - 그래서 우회 가능한 앞 단계는 실수를 줄이는 용도로 두고, 최종 방어선은 서버 쪽(GitHub 보호 + CI)에 둔다.
- **gitleaks-action 대신 바이너리를 쓰는 이유**: 버전·체크섬을 고정할 수 있다. 액션의 Node 런타임 폐기 일정과 PR 댓글 권한 문제에 묶이지 않는다. 이벤트 범위가 아니라 항상 전체 기록을 검사한다.
- **알려진 한계**:
  - Claude 훅은 Bash만 본다. 파일 쓰기 도구로 `.git/hooks`를 고치는 것은 막지 않는다.
  - secretlint 규칙 패키지 최신이 13.1.0이라 본체 14와 버전이 섞인다(테스트로 동작 확인).
- **작업 흐름 변화**: 이제 main에 직접 push할 수 없다. 작업은 브랜치에서 커밋하고 PR로 합친다.

## D-018 서버 비밀값 관리와 연결 정보 암호화 (T02, 2026-11-21)

- **비밀값 정의**:
  - 서버 비밀값 이름은 `functions/src/config/secret-names.ts` 한 곳에 둔다.
  - `secrets.ts`가 이 목록으로 `defineSecret`을 만들고, 번들 검사기도 같은 목록을 쓴다.
  - `ADMIN_EMAILS`는 쉼표로 구분한 목록이라 `defineList`로 받는다(SPEC 8장 수정).
- **process 사용 제한**:
  - functions 코드에서 `process`는 `functions/src/config/`와 테스트에서만 쓴다.
  - ESLint는 전역 `process`, `globalThis.process`·`global.process`, `process`·`node:process` import를 막는다.
- **암호화**: 사용자 연결 정보는 AES-256-GCM으로 암호화한다.
  - IV 12바이트를 매번 무작위로 만들고, 인증 태그 16바이트를 검증한다.
  - 암호문 형식은 `<키 버전>.<iv>.<tag>.<암호문>`(base64url)이다.
  - 문맥(AAD, 예: `secrets_oauth:<uid>`)에 묶는다. 다른 사용자 문서로 옮긴 암호문은 열리지 않는다.
  - `TOKEN_ENC_KEY`는 `"v2:<b64>,v1:<b64>"` 형식이고 첫 항목이 현재 키다. 키를 교체해도 예전 암호문을 열 수 있다.
- **화면 빌드 검사** (`pnpm scan:bundle`): 다음을 찾는다.
  - 키 모양(커밋 전 검사와 같은 패턴, 테스트로 일치 확인)
  - 서버 비밀값 이름(`VITE_` 접두어 포함)
  - `functions/.secret.local`의 실제 값
- Firebase 웹 API 키는 공개값이지만 YouTube 키와 모양(`AIza…`)이 같다. 그래서 화면 `.env*`와 환경 변수의 `VITE_FIREBASE_API_KEY` 값만 허용한다.
- **이유**:
  - 비밀값을 읽는 길을 하나로 모아야 "서버에만 둔다"를 lint로 강제할 수 있다.
  - 사용자별로 묶지 않은 암호문은 DB 안에서 다른 계정 문서로 옮겨 쓰일 수 있다.
  - YouTube 키를 모양만으로 구분할 수 없어서, 허용 목록을 정확한 값으로 둔다.
- **알려진 한계**: 동적 `import('firebase-admin')`가 lint에 걸리는지는 확인하지 않았다. 번들 검사가 2차 방어다.

## D-019 보안 규칙: 쓰기 없음, 공유 재생목록은 한 건 읽기만 (T03, 2026-11-21)

- `firestore.rules`는 기본 전부 거부이고, SPEC 5장 표의 읽기만 연다. 클라이언트 쓰기 허용은 한 줄도 없다.
  - 에뮬레이터 테스트(모든 컬렉션 쓰기 시도)와 정적 검사(`tools/firestore-rules-static.test.ts`, allow 문장 단위)로 고정한다.
- 서버 전용(`secrets_oauth`, `events`, `issueFingerprints`)은 match 자체를 두지 않는다. 관리자도 클라이언트로는 읽지 못한다.
- 관리자 판별은 사용자 정의 클레임 `admin == true`(불리언)만 인정한다. 관리자도 남의 draft·비공개 문서·ytExports는 읽지 못한다(SPEC 4.11).
- **재생목록 읽기를 get/list로 나눈다**:
  - 공유(`saved`) 재생목록은 공유 주소로 한 건 읽기(get)만 누구나 할 수 있다.
  - 목록 조회(list)는 소유자 자기 것만 된다.
  - **이유**: `saved` 전체나 특정 사용자의 공유 목록을 한 번에 긁어 가는 것을 막는다. `/p/:id`(T16)는 한 건 읽기, `/me`(T14·T24)는 소유자 목록만 쓰므로 기능에는 영향이 없다.
- `playlists/{id}/private`는 SPEC대로 `request` 문서 하나만 연다. 부모 문서가 없으면 거부된다(`get()` 실패).
- Storage는 쓰지 않으므로 전부 거부한다. `firebase.json`에 storage 블록이 있어, T23에서 대상 없이 `firebase deploy`를 하면 기본 버킷이 필요하다. 배포 때 `--only`로 대상을 지정하거나 버킷을 만든다.
- 루트 Node 하한을 `>=24.12`로 올린다. `@firebase/rules-unit-testing` 6과 firebase 13이 요구한다. Functions 런타임(22)과는 별개다.
- **화면 작업 메모(T16)**: draft나 없는 재생목록을 열면 not-found가 아니라 권한 거부가 온다. 화면은 둘 다 "찾을 수 없음"으로 보여 준다.

## D-020 비용·호출 상한 API와 데이터 (T04, 2026-11-21)

- **API**: TASKS의 `reserve(kind, amount, {uid})` 대신 `reserve(db, { service: {...}, user: { uid, counters: {...} }, feature? })`를 쓴다.
  - 여러 카운터를 한 트랜잭션에서 한 번에 예약한다. 예: 검색 1회 = 서비스 `ytSearchUser` + 사용자 `searches`.
  - `feature`를 주면 같은 트랜잭션에서 긴급 정지 스위치도 확인한다.
  - 보통은 `withBudget(db, req, fn)`으로 감싼다. fn이 실제 사용량을 돌려주면 정산하고, 실패하면 0으로 정산한 뒤 오류를 다시 던진다.
- **카운터**:
  - 서비스(`usage/{day}`): `ytUnits`, `ytSearchUser`, `ytSearchJob`, `aiCostMicroUsd`, `exports`, `autoIssues`, `autoFixes`
    - 검색은 사용자 80회와 야간 작업 20회로 나눈다(SPEC 6.3). 서로 다 써 버리지 못하게 하기 위함이다.
    - `autoFixes`(하루 3회)는 지금 한도만 정의하고, 실제 차감은 T20에서 연결한다.
    - 설정 형식이 엄격해서 나중에 필드를 추가하면 이전 배포본이 거부한다. 그래서 미리 넣었다.
  - 사용자(`users/{uid}/usage/{day}`): `playlists`, `searches`, `exports`
- **예약 기록**: `usage/{day}/reservations/{id}`에 둔다. 보안 규칙에 match가 없어 서버 전용이다(규칙 테스트로 확인).
  - 정산하면 uid를 지운다. 정산 안 된 예약의 uid는 계정 삭제(T24) 때 지운다.
  - 정산 안 된 예약은 예약한 양을 계속 차지한다(막는 쪽).
- **막는 쪽으로 실패**: `config/runtime`이 깨졌거나 모르는 필드가 있으면 모든 예약과 스위치 확인이 거부된다. 저장된 카운터 값이 숫자가 아니어도 거부된다.
- **정산 규칙**:
  - 실제가 예약보다 많아도 기록한다(이미 쓴 비용).
  - 돌려줄 때는 0 아래로 내리지 않고, 지워진 카운터 문서를 다시 만들지 않는다.
  - 사용자 경로는 예약 문서에 저장된 uid로 정한다.
  - 같은 예약을 두 번 정산하면 `AlreadySettledError`다. 응답이 유실돼 재시도한 경우 호출자는 이 오류를 성공으로 봐도 된다.
- **긴급 정지 스위치**: `killSwitches.<기능>`이 true면 동작, false면 정지다. 문서가 없으면 전부 동작(SPEC 기본값)한다.
- **오류**: `BudgetExceededError`에 `scope`·`counter`·`limit`·`used`·`resetAt`(다음 태평양 자정)을 담는다. 메시지는 서버 로그용이다. 화면 문구는 api 계층이 언어에 맞게 만든다(SPEC 4.7 "남은 시간 안내", D-013).
- **트랜잭션 재시도**: 30회로 둔다. 서비스 카운터 문서 하나에 요청이 몰리기 때문이다. 동시 20개 시험에서 정확히 상한만큼 성공하는 것을 확인했다.
- **lint**: functions의 core·api·jobs·config에서 외부 호출을 막는다.
  - `fetch` 등 전역, `http`·`https`·`net`·`child_process` 등 내장 모듈
  - 네트워크·외부 API SDK
  - 동적 `import()`, 이름을 계산하는 `import()`, `globalThis`
  - 이 호출들은 `adapters/`에서만 쓴다.
- **이유**: 외부 호출이 한도 확인을 건너뛰는 길을 코드 구조와 lint로 없애기 위함이다. 비용 사고는 알림이 아니라 앱 자체 상한으로 막는다(D-012).

## D-021 YouTube 쓰기 어댑터 (T05, 2026-11-21)

- **공개 함수 두 개**: `createPlaylist(ctx, uid, title, items)`, `addItems(ctx, uid, ytExportId, items)`.
  - `ctx`는 `db`와 `getAccessToken(uid)`(T26이 `secrets_oauth`에서 복호화해 넘김)다. 테스트에서는 가짜 `fetch`를 넣는다.
  - 오류·상수는 `youtube-write-types.ts`로 뺐다. 그래야 "실행 시점에 내보내는 것이 두 함수뿐"을 테스트로 확인할 수 있다.
- **기존 재생목록 보호**: `addItems`는 호출자가 준 YouTube 재생목록 ID를 받지 않는다. `ytExports/{id}`를 읽어 `ownerUid`가 같을 때만 그 문서의 `youtubePlaylistId`에 쓴다. 없는 문서와 남의 문서는 같은 오류다(존재 여부를 드러내지 않음).
- **할당량**: insert 1회 = 50단위를 미리 예약한다. YouTube는 실패한 요청에도 할당량을 쓰므로, 보낸 요청 수만큼 정산한다.
  - `createPlaylist`는 서비스·사용자 `exports`도 1씩 예약한다. 재생목록이 안 만들어지면 돌려준다.
  - 둘 다 긴급 정지 `create`를 확인한다. "YouTube 비용이 늘면 create를 끈다"(OPERATIONS 4)에 내보내기도 포함하기 위함이다.
- **재생목록 상태**: 새 재생목록은 비공개(`private`)로 만든다. 공개 여부는 사용자가 YouTube에서 바꾼다.
- **곡 수**: 재생목록당 30곡(SPEC 6.3). `ytExports.itemCount`를 트랜잭션으로 먼저 잡고, 실패한 곡만큼 돌려준다.
- **실패 처리**: 영상 하나의 문제(404 `videoNotFound` 등)는 건너뛴다. 남은 곡을 보내지 않는 경우:
  - 401·403·429·5xx·연결 실패
  - 재생목록 단위 오류(`playlistNotFound`, `playlistContainsMaximumNumberOfVideos`, `playlistOperationUnsupported`). 이름은 YouTube 문서 기준이고, T26 실제 확인 때 다시 본다.
  - 재생목록이 만들어진 뒤 곡이 실패해도 `ytExports` 기록은 남긴다(addItems로 이어 넣기 위함).
- **마무리 순서**: 정산을 먼저 하고 곡 수 자리를 돌려준다. 둘 다 실패해도 오류를 삼키고 기록만 남긴다. 그래야 이미 들어간 곡의 결과가 오류로 바뀌어 다시 시도하다 중복으로 들어가는 일이 없다. 실패하면 할당량·자리가 남는 쪽(막는 쪽)이다.
- **ytExports 쓰기 제한**: 여기에 아무 ID나 적히면 addItems가 기존 재생목록에 쓰게 된다. 그래서 functions에서 `ytExports` 문자열은 `youtube-write.ts`만 쓸 수 있다(lint). 정리(T11)·계정 삭제(T24)는 그 파일만 예외로 추가한다. 화면(apps/web)은 읽기 전용 규칙이라 제외했다.
- **addItems 사용자 한도**: 지금은 서비스 YouTube 단위 한도만 건다. 화면에서 부르게 할 때(T26 이후) 사용자 한도를 먼저 붙인다.
- **lint**: 어댑터 밖(functions 전체, apps/web)에서 `youtube/v3/playlist…` 주소 문자열과 `googleapis`·`@googleapis/youtube`를 막는다. adapters 안에서는 `${API}/playlists`처럼 기본 주소를 따로 둔 경로 조각(`/playlists`, `/playlistItems`)도 막는다. core·api에서는 Firestore 경로 `playlists/{id}`와 부딪혀서 걸지 않는다(그곳은 네트워크 자체가 막혀 있다). 앞으로 만들 `youtube-read.ts`는 `playlistItems` 주소를 쓸 수 있지만 `method`는 `GET`만 된다. 문자열을 쪼개 붙이는 우회는 lint로 못 막는다. 토큰을 받는 곳이 이 어댑터뿐이라는 점이 2차 방어다.
- **테스트 종류 변경**: TASKS는 unit 테스트였지만, 소유 확인·예약이 Firestore 트랜잭션이라 가짜 DB로는 동시성·정산을 제대로 확인할 수 없다. 그래서 소유 확인·기록·할당량은 에뮬레이터 통합 테스트로, 함수 목록·입력 검사는 unit으로 나눴다. 통합 테스트 파일이 둘이 되어 `vitest.int.config.ts`에 `fileParallelism: false`를 넣었다(같은 에뮬레이터를 지우며 쓰므로).
- **남은 것**: `ytExports.youtubePlaylistId`도 YouTube 데이터라 30일 규칙(D-004) 대상인지 T11(재확인·정리)에서 정한다(TASKS T11에 적어 둠).
- **이유**: 좁은 YouTube 권한이 없어서(youtube-policy 스킬) 기존 재생목록 보호를 코드 구조로 강제해야 한다. 쓸 대상 ID를 서버 기록에서만 가져오면 호출자 실수나 조작으로 남의·기존 재생목록에 쓸 길이 없다.
