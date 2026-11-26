# 이어서 하기 (컴퓨터 교체, 2026-11-24)

컴퓨터를 바꾸기 전에 남긴 메모. 새 컴퓨터에서 이 순서대로 하면 이어서 작업할 수 있다.

## 1. 설치

| 무엇             | 명령                                                         | 왜                                                    |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Homebrew         | https://brew.sh 안내대로                                     | 아래 설치용                                           |
| Node 24.12 이상  | `brew install node` (이 컴퓨터는 v26)                        | `package.json`의 `engines`                            |
| pnpm 10          | `npm i -g pnpm@10`                                           | Node 26에는 corepack이 없다                           |
| Java 21          | `brew install openjdk@21`                                    | Firebase 에뮬레이터. `tools/with-java.sh`가 찾아 준다 |
| GitHub CLI       | `brew install gh` → `gh auth login`                          | PR 올리기·검사 보기·합치기(D-025)                     |
| Google Cloud CLI | `brew install --cask google-cloud-sdk` → `gcloud auth login` | 예산·Secret Manager 확인                              |
| Claude Code      | 공식 설치 안내대로                                           | `EVAL_LLM=cli pnpm eval`도 이 구독을 쓴다             |

## 2. 받기와 준비

```sh
git clone https://github.com/furabonos/musicweb.git
cd musicweb
git switch fix/local-trial-ui          # 작업 중인 브랜치 (main에는 아직 없음, 4절)
pnpm install
pnpm --filter web exec playwright install chromium   # e2e용 브라우저
pnpm exec firebase login                # 배포·설정 확인용 (에뮬레이터만 쓰면 필요 없음)
```

확인: `pnpm lint && pnpm typecheck && pnpm test` (지금 unit 1065개 통과).

## 3. git에 없는 파일 — 새 컴퓨터에서 꼭 다시 만든다

비밀·개인 설정이라 저장소에 없다. 값은 이 문서에 적지 않는다.

**필수**: 위 2절을 마친 뒤 아래 표의 앞 두 파일(`apps/web/.env.production.local`, `functions/.env.aimusicwebs`)을 만든다. 없으면 배포 준비 검사(`pnpm deploy:prepare prod --check`)가 실패하고 배포할 수 없다. 에뮬레이터·테스트만 쓸 때는 없어도 된다.

| 파일                             | 내용                                                                     | 다시 만드는 법                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/.env.production.local` | 배포용 웹 설정(공개값): `VITE_FIREBASE_*` 4개, `VITE_RECAPTCHA_SITE_KEY` | `apps/web/.env.example` 형식대로. Firebase 웹 설정은 `pnpm exec firebase apps:sdkconfig web --project prod`, reCAPTCHA 키는 Firebase 콘솔 → App Check |
| `functions/.env.aimusicwebs`     | `ADMIN_EMAILS=["관리자 이메일"]`, `MB_CONTACT=연락용 이메일`             | 손으로 작성                                                                                                                                           |
| `functions/.env.demo-musicweb`   | 에뮬레이터용                                                             | `pnpm test:int`·`pnpm emulators`가 `tools/emulator-env.sh`로 자동 생성                                                                                |
| `functions/.secret.local`        | 로컬 비밀값(필요할 때만)                                                 | `functions/.secret.local.example` 참고                                                                                                                |

서버 비밀값 5개(YOUTUBE_API_KEY 등)는 Google Cloud Secret Manager에 있어서 다시 넣을 필요가 없다.

## 4. 어디까지 했나

- **T23(배포 준비)**: 설정은 끝났고 **아직 배포하지 않았다**. 배포는 사람이 직접 한다(`docs/OPERATIONS.md` 7절).
  - 끝난 것: App Check(reCAPTCHA) 등록, 비밀값 5개, 관리자 이메일, 예산 알림과 Functions 지출 상한(월 ₩14,000), 이름 Tunetrail과 주소 `tunetrail.web.app`(D-054), 로그인 허용 도메인 추가
  - T23 체크박스는 배포 후 확인(`node --experimental-strip-types tools/smoke.ts aimusicwebs`와 수동 확인)까지 끝나야 `[x]`로 바꾼다
- **브랜치 `fix/local-trial-ui`**: 로컬 체험에서 찾은 문제를 고친 커밋들(Google 로그인, 버튼 문구, 메뉴 깜빡임, 이름 변경)과 이 메모. 아직 PR을 올리지 않았다.

## 5. 다음에 할 차례

1. **"로그인하세요" 안내가 화면 밖에 뜨는 문제 고치기**: 로그아웃 상태에서 "Make the set" 등을 누르면 안내 문구가 화면 아래에 나와 아무 반응이 없는 것처럼 보인다. 버튼 근처에 보이게 하거나 그 위치로 스크롤한다.
2. **PR 올리고 합치기** (D-025 순서): 깨끗한 새 사본에서 lint·format·typecheck·unit·rules·int·e2e·eval·번들 검사 → `gh pr checks --watch` → `gh pr merge --merge --match-head-commit <sha>` → main 받기. e2e·int는 이 브랜치에서 아직 안 돌렸다(e2e 버튼 이름을 'Make it'·'만들어 줘'로 바꿈).
3. **정할 것**: 지금 배포해서 `tunetrail.web.app`에서 써 볼지(배포하면 누구나 들어올 수 있음, 만들기는 관리자만 — D-015), 아니면 배포 없이 T24부터 할지. 배포한다면 검색 노출을 막는 noindex를 넣을지도.
4. 그다음 **T24 Google 로그인과 사용자별 한도** (`docs/TASKS.md`). 위 메뉴의 "My playlists"는 T24에서 다시 넣는다.
5. `docs/OPERATIONS.md` 2절 "마지막 확인" 날짜를 2026-11-24(예산·상한 설정한 날)로 고친다.

## 6. 참고

- 맥에서는 AirPlay가 5000번 포트를 써서 Hosting 에뮬레이터를 5050번으로 옮겼다.
- 화면을 가짜 데이터로 보기: `pnpm emulators` → `pnpm emulators:seed` → `pnpm --filter web dev:emulators` (관리자 admin@example.com)
- 예전에 대화창에 Google OAuth 클라이언트 비밀값이 노출된 적이 있다. 아직 안 바꿨다면 Google Cloud 콘솔에서 새로 발급(회전)한다.
