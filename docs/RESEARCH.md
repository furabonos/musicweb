# 시작 전 확인 결과 (PLAN.md 17번)

확인일: 2026-11-21. 공식 문서를 직접 받아 확인했다. "미확인"으로 표시한 것은 공식 문서에서 찾지 못한 항목이다.
약관은 바뀔 수 있으므로 관련 작업을 시작할 때 출처를 다시 연다.

## 1. YouTube Data API 할당량

- 기본 할당: "100 search.list calls, 100 videos.insert calls, and 10,000 units per day combined for all other endpoints". 태평양 시간 자정에 초기화.
  — https://developers.google.com/youtube/v3/determine_quota_cost
- 단위: channels.list / playlistItems.list / videos.list = 1, playlists.insert / playlistItems.insert = 50.
- **search.list는 하루 100회 별도 한도** (기획서는 "검색은 단위가 큼"으로 가정 → 실제는 횟수 상한).
- 채널 영상 목록: `channels.list(contentDetails).relatedPlaylists.uploads` → `playlistItems.list`(maxResults 최대 50). 50개당 1단위.
  — https://developers.google.com/youtube/v3/docs/channels , https://developers.google.com/youtube/v3/docs/playlistItems/list
- 할당량 증가: 돈이 아니라 준수 심사(API Compliance Audit). 폼: https://support.google.com/youtube/contact/yt_api_form
  — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- API 클라이언트당 프로젝트는 정확히 1개 ("you must create exactly one (1) API Project for that API Client").

## 2. 받은 데이터의 보관 (설계에 가장 큰 영향)

출처: https://developers.google.com/youtube/terms/developer-policies (III.E.4)

- 로그인 없이 받은 데이터: "not longer than 30 calendar days … After 30 calendar days, the API Client must either delete or refresh the stored data."
- "The API Client must also verify, every 30 days, that the video has not been deleted."
- 영상 ID에 대한 예외 조항은 찾지 못했다 → 영상 ID도 30일 규칙 대상으로 본다.
- 파생 데이터 (III.E.4.h): API 데이터로 "new or derived data or metrics"를 만들지 말 것. YouTube 것이 아닌 정보를 함께 보여 줄 때는 출처가 YouTube가 아님을 분명히 표시.
- 합치기: "Do not aggregate API Data except … YouTube channels that are under the same content owner". 예시는 분석 지표지만 문구상 여러 채널 곡 목록과 충돌 소지(회색지대).
- 사용자 데이터 삭제 요청은 7일 안에 처리 (III.E.4.g). 권한 철회 시 30일 안에 삭제.

## 3. 삽입 플레이어와 공개 서비스 약관

- 최소 기능 요건 — https://developers.google.com/youtube/terms/required-minimum-functionality
  - 플레이어 영역 최소 200×200px (권장 480×270)
  - 플레이어 앞에 오버레이·프레임 등 어떤 요소도 올리지 않음
  - 플레이어가 절반 이상 보일 때만 자동 재생, 동시에 자동 재생하는 플레이어는 1개
  - Referer 헤더를 막지 않음 (Referrer-Policy 주의)
- 개발자 정책 III.I: 소리·영상 분리 금지, 백그라운드 재생 금지, 플레이어 변형·광고 차단·링크 가리기 금지, 중첩 iframe 금지
- III.I.1: YouTube를 대신하는 서비스 금지. "significant independent value"가 있어야 함 → 추천이 독자적 가치
- III.A: YouTube 이용약관 링크(https://www.youtube.com/t/terms)와 사용자 동의 문구, 개인정보 처리방침에 YouTube API 사용 사실, Google 개인정보처리방침 링크(http://www.google.com/policies/privacy), 쿠키 안내
- III.F.2.a: 콘텐츠 출처가 YouTube임을 표시
- III.G.1: YouTube API 데이터가 있는 화면의 광고 판매 제한
- 아동용 영상(Made for Kids)은 추적 끔
- IFrame API — https://developers.google.com/youtube/iframe_api_reference
  - `YT.PlayerState.ENDED`(0)에서 다음 곡 `loadVideoById`. `loadPlaylist`/`cuePlaylist`는 ID 배열
  - 브라우저가 소리 있는 자동 재생을 막을 수 있음 (`onAutoplayBlocked`). 첫 재생은 사용자 클릭으로
  - 오류 101/150 = 퍼가기 불가 → 건너뜀. `status.embeddable`만으로는 부족 (Content ID 등으로 막힐 수 있음)

## 4. 로그인 없이 여러 영상을 재생목록으로 여는 링크

- `https://www.youtube.com/watch_videos?video_ids=ID1,ID2,…`
  - 2026-11-21 직접 실행: `HTTP/2 303`, `location: https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=TLGG2ygyGf2t5wQyMTExMjAyNg`. 로그아웃 상태에서 "Untitled List"(2개)로 열림
  - **공식 문서에 없음.** 예고 없이 바뀔 수 있음. 목록 ID에 날짜가 들어 있어 임시 목록으로 추정
  - 미확인: 로그인한 사용자가 이 목록을 "저장"할 수 있는지, 최대 ID 개수
- 공식 대안: 삽입 플레이어 `playlist` 매개변수(쉼표로 구분한 ID) — 우리 사이트 재생용이며 YouTube에 저장되지 않음
  — https://developers.google.com/youtube/player_parameters

## 5. 사용자 YouTube 계정에 재생목록 만들기와 Google 앱 심사

- playlists.insert / playlistItems.insert 권한: `youtube`, `youtube.force-ssl`, `youtubepartner` 중 하나. **재생목록만 허락하는 좁은 권한은 없다** → "기존 재생목록 안 건드림"은 코드로만 보장
- 비용: 재생목록 1개 = 50 + 곡 수 × 50 단위 (10곡 = 550단위)
- 테스트 상태: 테스트 사용자 최대 100명, **동의가 7일 뒤 만료**, 경고 화면 표시
  — https://support.google.com/cloud/answer/15549945
- 민감 권한 심사 준비물: 소유 확인된 도메인의 홈페이지(로그인 화면만이면 안 됨), 같은 도메인의 개인정보 처리방침, Search Console 도메인 확인, 영어 시연 영상(동의 화면~기능 끝까지, 앱 이름·클라이언트 ID 보이게), 권한별 사유, 브랜드 확인. 최대 10일
  — https://support.google.com/cloud/answer/13464321 , https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- 기본 로그인(openid, email, profile)은 민감 권한이 아님 → 민감 권한 심사 불필요 (브랜드 확인은 필요)
- 미확인: YouTube 권한이 "민감"인지 "제한"인지 공식 표기를 찾지 못함 (포럼에서는 민감으로 승인 사례). Cloud Console에서 확인
- 미확인: `*.web.app` 주소로 도메인 소유 확인이 불가능한지. 직접 소유 도메인을 쓰는 것으로 결정 (D-009)

## 6. 공개 음악 데이터

| 출처              | 데이터                                           | 조건                                                                                                 | 출처                                                                                                       |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ListenBrainz Labs | 비슷한 곡·아티스트, 태그 조회                    | 공개 데이터 CC0 계열(원문 직접 확인 못 함), 초당 1회, 실험 서비스(SLA 없음)                          | https://labs.api.listenbrainz.org/ , https://listenbrainz.readthedocs.io/en/latest/users/api/index.html    |
| MusicBrainz       | 아티스트·녹음·발매일·URL 관계(YouTube 링크 포함) | 핵심 데이터 CC0. 태그·장르 연결은 CC BY-NC-SA 3.0. 초당 1회, 연락처 든 User-Agent 필수               | https://musicbrainz.org/doc/About/Data_License , https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting |
| Wikidata          | YouTube 영상 ID(P1651), 장르(P136), 발매일(P577) | CC0. 인기곡 위주                                                                                     | https://www.wikidata.org/wiki/Wikidata:Licensing                                                           |
| Last.fm           | 비슷한 곡(유사도 점수), 태그                     | **비상업 전용**, Last.fm 표시와 링크 의무, HTTP 헤더에 맞춘 캐시, 저장 상한 100MB, 이용 종료 시 삭제 | https://www.last.fm/api/tos                                                                                |
| Discogs           | 장르·스타일                                      | 공식 페이지 403으로 원문 미확인. Restricted Data 상업 금지                                           | —                                                                                                          |
| Spotify           | —                                                | 2024-11-27부터 신규 앱 추천·관련 아티스트 차단, 데이터베이스 구축 금지 → **사용 안 함**              | https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api                                       |

## 7. Firebase 요금제

- Cloud Functions는 Blaze(종량제)에서만 쓸 수 있다 — https://firebase.google.com/pricing
- 무료 사용량(Blaze):
  - Functions: 호출 월 200만 회, 400,000 GB-초, 200,000 CPU-초, 외부 전송 5GB
  - Cloud Scheduler: 결제 계정당 월 3개 작업 무료, 이후 작업당 월 $0.10 — https://cloud.google.com/scheduler/pricing
  - Firestore: 1GiB 저장, 하루 읽기 5만·쓰기 2만·삭제 2만 건
  - Hosting: 10GB 저장, 하루 360MB 전송
  - Auth: 월 활성 사용자 5만 명
  - Secret Manager: 비밀 버전 6개, 조회 월 1만 회
- 예산 알림은 "do not pause services". Functions 등에 한해 "spend cap budgets"(100% 도달 시 그 서비스를 그달 동안 정지). 프로젝트 결제 자동 해제는 Pub/Sub + 함수로 만들 수 있으나 자원 삭제 위험
  — https://firebase.google.com/docs/projects/billing/avoid-surprise-bills
- App Check(reCAPTCHA Enterprise): 월 1만 회 평가 무료. callable 함수와 Firestore에 적용 — https://firebase.google.com/docs/app-check
- API 키는 `defineSecret()`(Secret Manager)로. `.env`는 비밀값용으로 안전하지 않다고 명시 — https://firebase.google.com/docs/functions/config-env

## 8. 예상 비용 (추정, 측정 아님)

- AI: Claude Haiku 5.5, 입력 100만 토큰당 $0.10, 출력 $0.50 (Anthropic 가격표, 2026-11-03 기준)
  - 재생목록 1회: 해석 + 고르기, 입력 약 5천·출력 약 2천 토큰 → 약 $0.0015
  - 사용자 1명 하루 10회 → 약 $0.015
- YouTube:
  - 곡 목록에 있는 곡만 쓰면 0단위
  - 곡 목록에 없는 곡은 1곡당 search 1회(서비스 전체 하루 100회 공용)
  - 확인된 링크가 음악 데이터에 있으면 videos.list 1단위
- 매일 밤:
  - 아티스트 1,000명의 최신 영상 확인 ≈ 1,000단위
  - 30일 재확인은 곡 10만 개 기준 하루 약 70단위
- **병목은 비용이 아니라 search 하루 100회**다. 구현 뒤 이벤트 로그로 실제 값을 잰다.
