# 운영 절차

실제 Firebase 프로젝트에서 사람이 하는 설정과 대응 절차. 실제 설정은 T23(배포)에서 하고, 그때 화면 문구가 바뀌었으면 이 문서를 고친다.

## 1. 비용 방어선 (D-012)

비용은 아래 순서로 막는다. **예산 알림은 알림만 보내고 결제를 멈추지 않는다.** 그래서 1·2번이 실제 방어선이다.

1. **앱 자체 상한** (`functions/src/core/budget.ts`, T04)
   - 모든 외부 호출은 `reserve()`로 예약한 뒤 한다. 상한은 `config/runtime.limits`(SPEC 6.3)에 있다.
   - 상한에 닿으면 그날(태평양 시간 자정까지) 해당 기능이 거부된다.
2. **Functions 예산 정지 (spend cap budget)**
   - 예산의 100%에 닿으면 그달 동안 Cloud Functions를 멈춘다.
   - 대상은 Cloud Functions·App Hosting·Extensions 등이고, Firestore는 포함되지 않는다.
   - 출처: https://firebase.google.com/docs/projects/billing/avoid-surprise-bills
3. **월 예산 알림 $10**: 50% / 90% / 100%에서 메일을 받는다.
4. **긴급 정지 스위치**: 관리자 callable(T06)·화면(T22) 또는 아래 5번 절차로 기능별로 끈다.

하지 않는 것: 프로젝트 결제를 자동으로 해제하는 함수. 서비스 전체가 멈추고 자원이 삭제될 수 있다(D-012).

## 2. 예산 알림과 Functions 예산 정지 설정 (T23에서 실행)

1. Firebase 콘솔에서 프로젝트를 Blaze 요금제로 바꾼다. 결제 계정을 연결한다.
2. Google Cloud 콘솔 → 결제 → 예산 및 알림 → 예산 만들기:
   - 범위: 이 프로젝트
   - 금액: 월 $10
   - 알림 기준: 50%, 90%, 100% (실제 비용 기준)
   - 받는 사람: 결제 관리자·사용자 메일
3. Firebase 콘솔 → 사용량 및 결제 → 예산 정지(spend cap)를 Cloud Functions에 켠다.
   - 금액은 월 예산과 같게 $10.
   - 위치와 이름은 위 출처 문서를 따른다.
4. 확인: 설정 화면을 캡처해 T23 PR에 첨부한다. 이 문서의 "마지막 확인" 날짜를 고친다.

마지막 확인: 아직 설정 전 (T23)

## 3. 한도 바꾸기

- 관리자 callable `admin-setLimits`·`admin-setKillSwitch`(T06)로 고친다. 변경 기록(`adminAudit`, 운영 일지)이 남는다. 화면은 T22.
- 설정 문서가 깨져 callable이 `failed-precondition`을 돌려줄 때만 Firestore 콘솔에서 `config/runtime`을 직접 고친다.
- 형식 (빠진 값은 SPEC 6.3 기본값):

```json
{
  "killSwitches": { "create": true, "ingest": true, "autoIssue": true },
  "limits": {
    "service": {
      "ytUnits": 9000,
      "ytSearchUser": 80,
      "ytSearchJob": 20,
      "aiCostMicroUsd": 1000000,
      "exports": 5,
      "autoIssues": 5,
      "autoFixes": 3,
      "musicDataCalls": 20000
    },
    "user": { "playlists": 10, "searches": 3, "exports": 1 }
  }
}
```

- 규칙:
  - `ytUnits` ≤ 10,000이어야 한다.
  - `ytSearchUser + ytSearchJob` ≤ 100이어야 한다.
  - 모르는 필드나 잘못된 값이 있으면 **모든 예약과 스위치 확인이 거부된다**(막는 쪽으로 실패). 고친 뒤에는 바로 정상으로 돌아온다.
- `aiCostMicroUsd`는 백만분의 1달러 단위다. $1 = 1,000,000.

## 4. 관리자 추가·빼기

- `ADMIN_EMAILS` 매개변수를 고쳐 다시 배포한다. 배포 질문에는 쉼표 목록(`a@gmail.com,b@gmail.com`)으로 답해도 된다. CLI가 JSON 배열로 바꿔 저장한다. `.env` 파일에 직접 쓸 때는 JSON 배열(`["a@gmail.com"]`)로 쓴다.
- 관리자는 Google 계정 이메일로 판단한다. 계정 이메일과 연결된 Google 계정 이메일이 같아야 한다.
- 서버 함수는 목록을 직접 보므로, 배포가 끝나면 뺀 계정의 관리자 함수 호출은 바로 거부된다.
- 보안 규칙(관리자만 읽는 `usage`·`artists`·`adminAudit`)은 클레임을 본다. 뺀 계정의 클레임은 그 계정의 화면이 `account-syncClaims`를 부를 때만 저절로 지워진다. 악의적인 전 관리자는 부르지 않으므로 **무기한 남을 수 있다**. 그래서 빼고 나면 반드시 아래 중 하나를 한다:
  - 다른 관리자가 `admin-syncUserClaims`에 그 계정 uid(`adminAudit.adminUid`에서 찾음)를 넣어 호출한다. 클레임을 지우고 로그인 토큰을 끊는다.
  - Firebase 콘솔 → Authentication에서 그 계정을 사용 중지한다.
- 둘 다 이미 발급된 ID 토큰은 최대 1시간 동안 규칙 읽기에 쓰일 수 있다. 관리자 함수는 끊긴 토큰·사용 중지 계정을 매번 확인하므로 바로 거부된다.
- 목록에 남은 관리자 계정이 탈취됐으면: 목록에서 빼고 다시 배포한 뒤, 콘솔에서 계정을 사용 중지한다.

## 5. 긴급 정지

| 상황                             | 할 일                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| AI·YouTube 비용이 갑자기 늘어남  | `killSwitches.create = false` (재생목록 만들기·내 계정에 넣기 정지) |
| 수집 작업이 할당량을 이상하게 씀 | `killSwitches.ingest = false`                                       |
| 자동 이슈가 쏟아짐               | `killSwitches.autoIssue = false`                                    |

- 스위치는 매 요청마다 새로 읽으므로, 저장하면 다음 요청부터 바로 적용된다.
- 원인을 고친 뒤 `true`로 되돌린다. 관리자 callable로 바꾸면 운영 일지·`adminAudit`에 자동으로 남는다(T06). 콘솔에서 직접 고쳤으면 그 사실을 손으로 남긴다.

## 6. Last.fm 데이터

- Last.fm 응답은 `lastfmCache`에만 HTTP 캐시 기간 동안 두고, 매일 정리 작업이 기간 지난 것을 지운다(D-024). 전체 100MB 상한.
- **Last.fm 사용을 그만두면** `lastfmCache` 컬렉션을 전부 지운다(Firestore 콘솔 또는 `firebase firestore:delete lastfmCache --recursive`). 이용 조건상 종료 후 남겨 두지 않는다.

## 7. 첫 배포 (T23, D-053)

배포는 사람이 마지막 명령을 직접 친다. 아래 1~6은 한 번만 한다. 값은 채팅·PR에 붙이지 않는다.

**프로젝트**: `.firebaserc`의 `prod` 별칭(`aimusicwebs`). 기본(`default`)은 에뮬레이터용 가짜 프로젝트라 실수로 실제 프로젝트에 쓰지 않는다.

1. **콘솔에서 켤 것** (확인 2026-11-24)
   - Blaze 요금제, Firestore(Native, Standard, `nam5`), Storage, Authentication의 Google 로그인
   - 예산 알림·Functions 예산 정지: 위 2절
2. **App Check (reCAPTCHA Enterprise)**
   - Firebase 콘솔 → App Check → 앱 `musicweb` → reCAPTCHA Enterprise로 등록한다. 도메인은 `aimusicwebs.web.app`, `aimusicwebs.firebaseapp.com`.
   - 받은 사이트 키(공개값)를 `apps/web/.env.production.local`의 `VITE_RECAPTCHA_SITE_KEY`에 넣는다.
   - 서버 함수는 코드에서 App Check를 강제한다(`functions/src/api/callable.ts`). 콘솔의 Firestore·Storage "적용"은 켜지 않아도 된다(화면은 Firestore·Storage를 직접 쓰지 않음).
3. **화면 설정** `apps/web/.env.production.local`(gitignore): 배포 빌드만 읽는다. Firebase 웹 설정은 `pnpm exec firebase apps:sdkconfig WEB --project prod`로 받는다.
4. **서버 매개변수** `functions/.env.aimusicwebs`(gitignore):

   ```
   ADMIN_EMAILS=["관리자@gmail.com"]
   MB_CONTACT=https://aimusicwebs.web.app
   ```

5. **비밀값** (Secret Manager). 함수가 연결하는 5개는 모두 있어야 배포된다. 아직 안 쓰는 것은 `none`을 넣는다(코드가 없음으로 다룬다).

   ```
   ! pnpm exec firebase functions:secrets:set YOUTUBE_API_KEY --project prod
   ! openssl rand -base64 32 | tr -d '\n' | pnpm exec firebase functions:secrets:set ACTOR_HASH_KEY --project prod --data-file -
   ! printf none | pnpm exec firebase functions:secrets:set ANTHROPIC_API_KEY --project prod --data-file -
   ! printf none | pnpm exec firebase functions:secrets:set LASTFM_API_KEY --project prod --data-file -
   ! printf none | pnpm exec firebase functions:secrets:set GITHUB_ISSUE_TOKEN --project prod --data-file -
   ```

   - YouTube 키는 Google Cloud 콘솔 → API 및 서비스에서 "YouTube Data API v3"를 사용 설정하고 만든다. **API 제한을 YouTube Data API v3 하나로** 건다.
   - `ACTOR_HASH_KEY`는 한 번 정하면 바꾸지 않는다(바꾸면 이벤트 로그의 사용자 묶음이 끊김).
   - AI 키를 나중에 넣으면 같은 명령으로 값을 바꾸고 다시 배포한다(D-039: 그 전에는 AI 없는 방식).

6. **배포 준비**: `pnpm deploy:prepare prod --check`
   - 설정 검사 → functions 빌드 → 화면 빌드와 비밀값 검사(`scan:bundle`) → `.deploy/functions`(묶지 않은 패키지만 정확한 버전으로 적은 package.json) → `firebase.deploy.json`(빌드 단계 없음)
   - 설정을 바꿨으면 배포 전에 이 명령을 다시 돌린다(배포는 이때 만든 결과를 그대로 올린다).
   - `--check`는 그 묶음을 임시 폴더에 npm으로 설치해 불러와 본다. 배포하지 않는다.
7. **배포** (사람이 직접): `pnpm exec firebase deploy --config firebase.deploy.json --project prod`
   - 처음 배포는 API 사용 설정·권한 질문이 나올 수 있다. 읽고 답한다.
   - `--force`(코드에 없는 함수 지우기)는 쓰지 않는다.
8. **배포 뒤 확인**
   - `node --experimental-strip-types tools/smoke.ts aimusicwebs`: 모든 callable이 App Check 없는 호출을 거부(401)해야 한다.
   - 손 확인:
     - `https://aimusicwebs.web.app` 접속, `/status`
     - 관리자로 로그인해 재생목록 만들기
     - 관리자 아닌 계정은 만들기 거부(D-015)
     - 실제 YouTube 플레이어로 재생·다음 곡·오류 건너뛰기(D-032)
   - 다음 날: 야간 작업 결과가 운영 일지에 남았는지, `linkHealthNightly` 결과
9. **GitHub 배포**(`.github/workflows/deploy.yml`): 지금은 손으로만 돌고, main에서만 돈다.
   - 저장소 Settings → Environments에서 `production`을 만들고 "Required reviewers"(관리자)와 "Deployment branches: main"을 건다.
   - `FIREBASE_SERVICE_ACCOUNT`, `WEB_ENV_PRODUCTION`, `FUNCTIONS_ENV`는 **그 환경의 Secrets에만** 넣는다. 저장소 Secrets에 넣으면 다른 워크플로·같은 저장소 PR 실행이 읽을 수 있다.
   - 서비스 계정 키 대신 Workload Identity Federation을 쓰면 더 낫다(키 파일 없음). 바꾸면 D-053에 적는다.
