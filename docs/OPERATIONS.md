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
4. **긴급 정지 스위치**: 관리자 화면(T22) 또는 아래 4번 절차로 기능별로 끈다.

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

- 관리자 화면(T22)이 생기기 전에는 Firestore 콘솔에서 `config/runtime` 문서를 직접 고친다. 관리자 화면이 생긴 뒤에는 화면에서만 고친다(변경 기록이 남음).
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
      "autoIssues": 5
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

## 4. 긴급 정지

| 상황                             | 할 일                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| AI·YouTube 비용이 갑자기 늘어남  | `killSwitches.create = false` (재생목록 만들기·내 계정에 넣기 정지) |
| 수집 작업이 할당량을 이상하게 씀 | `killSwitches.ingest = false`                                       |
| 자동 이슈가 쏟아짐               | `killSwitches.autoIssue = false`                                    |

- 스위치는 매 요청마다 새로 읽으므로, 저장하면 다음 요청부터 바로 적용된다.
- 원인을 고친 뒤 `true`로 되돌린다. 바꾼 사실은 운영 일지에 남긴다(T22 이후 자동).
