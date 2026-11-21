---
name: youtube-policy
description: YouTube Data API·IFrame 플레이어 약관과 할당량 규칙. YouTube API를 호출하거나, YouTube 데이터를 저장·갱신·삭제하거나, 플레이어 화면·약관 문구·내보내기 권한을 건드릴 때 읽는다.
---

# YouTube 약관과 할당량 (musicweb)

확인일 2026-11-21. 약관이 바뀌었을 수 있으니, 새 정책을 판단해야 하면 원문을 다시 연다.
- 개발자 정책: https://developers.google.com/youtube/terms/developer-policies
- 최소 기능 요건: https://developers.google.com/youtube/terms/required-minimum-functionality
- 할당량: https://developers.google.com/youtube/v3/determine_quota_cost

## 할당량

| 호출 | 비용 | 메모 |
|---|---|---|
| search.list | **하루 100회 별도 한도** | 단위가 아니라 횟수. 사용자 80 + 야간 20 (D-007) |
| channels.list, playlistItems.list, videos.list | 1단위 | playlistItems·videos는 50개씩 |
| playlists.insert, playlistItems.insert | 50단위 | 재생목록 10곡 = 550단위 |
| 기본 할당 | 하루 10,000단위 | 태평양 시간 자정 초기화. 앱 상한 9,000 |

- 채널 영상은 `channels.list(part=contentDetails)`의 `relatedPlaylists.uploads`에서 `playlistItems.list`로 받는다. search로 받지 않는다.
- 할당량은 사지 못한다. 증가는 준수 심사로만 받는다. 프로젝트는 1개뿐이다. 프로젝트를 여러 개 쓰거나 비공식 수집 도구를 쓰는 것은 금지다.
- 모든 호출은 `budget.reserve('yt_units' | 'yt_search', n)`을 먼저 거친다.

## 저장 (가장 자주 틀리는 부분)

- YouTube에서 받은 모든 것(영상 ID, 제목, 채널 ID, embeddable, madeForKids)은 **30일 안에 재확인하거나 삭제**한다.
  - 25일째 재확인, 30일째 무조건 삭제 (D-004).
  - 재확인할 때 영상이 삭제됐는지 확인하고, 바뀐 메타데이터는 갱신한다.
- 영상 ID도 예외가 아니다.
- 곡 정보(아티스트·제목·장르·연도)는 음악 데이터를 원천으로 한다. YouTube 제목에서 뽑은 값은 "연결 확인"에만 쓰고 곡 정보로 저장하지 않는다.
- 화면에 곡 정보를 보여 줄 때 출처(MusicBrainz 등)를 표시한다. YouTube에서 온 것이 아님을 알린다.
- 음원·영상·썸네일 파일은 저장하지 않는다. 썸네일은 YouTube 주소를 그대로 표시한다.
- 사용자 삭제 요청은 7일 안에 처리한다. 권한 철회 시 관련 데이터는 30일 안에 지운다(우리는 즉시 지운다).

## 플레이어

- 공식 IFrame 플레이어만 쓴다. 크기는 480×270 이상(최소 200×200).
- 다음은 금지다:
  - 플레이어 위에 요소를 겹치는 것
  - 플레이어를 숨기거나 변형하는 것
  - 광고나 플레이어 안 링크를 막거나 가리는 것
  - 중첩 iframe
  - 소리만 분리해 재생하는 것
  - 백그라운드 재생
- 자동 재생은 플레이어가 절반 이상 보일 때만 한다. 동시에 1개만 자동 재생한다. 첫 재생은 사용자 클릭으로 시작한다.
- Referer를 막지 않는다. 전체 사이트 Referrer-Policy를 `no-referrer`로 두지 않는다.
- 아동용(madeForKids) 영상은 추적 없이 재생한다.
- 오류 101/150은 퍼가기 불가다. 다음 곡으로 넘어가고 `embed_blocked` 이벤트를 남긴다. `status.embeddable`만으로는 부족하다.
- 콘텐츠 출처가 YouTube임을 표시한다.
- YouTube를 대신하는 서비스가 되지 않게 한다. 핵심 가치는 추천이다. YouTube 화면을 흉내 내지 않는다.

## 약관 문구에 반드시 들어가는 것

- YouTube 이용약관 링크 https://www.youtube.com/t/terms 와 "이 서비스를 쓰면 YouTube 이용약관에 동의하는 것" 문구
- 개인정보 처리방침에:
  - YouTube API Services 사용 사실
  - Google 개인정보처리방침 링크 http://www.google.com/policies/privacy
  - 쿠키
  - 수집·보관·삭제
  - 권한 철회 방법(https://security.google.com/settings/security/permissions)
- YouTube 데이터가 있는 화면에서 광고를 팔지 않는다(우리는 비상업).

## 내 계정에 넣기 (OAuth)

- 권한은 `https://www.googleapis.com/auth/youtube.force-ssl`이다. 처음 쓸 때만 추가로 요청한다.
- 재생목록 전용 좁은 권한은 없다. 그래서 **기존 재생목록 보호는 코드 책임**이다.
  - `youtube-write.ts`의 `createPlaylist`·`addItems`만 쓴다.
  - `addItems`는 `ytExports`에 기록된 내 재생목록에만 쓴다.
  - 수정·삭제 API는 만들지 않는다.
- 심사 전(테스트 상태): 테스트 사용자 최대 100명, 동의가 7일 뒤 만료된다.
- 연결 정보는 AES-256-GCM으로 암호화해 `secrets_oauth`에만 둔다. 이 컬렉션은 규칙으로 클라이언트 접근을 전부 막는다.

## "YouTube에서 열기"

- `https://www.youtube.com/watch_videos?video_ids=ID1,ID2,…`는 비공식 링크다(D-006).
  - 매일 `jobs/linkHealth.ts`가 303·`list=TL` 응답을 확인한다.
  - 깨지면 곡별 링크 목록으로 대체한다.
- 응답 헤더만 확인하고 페이지 본문을 긁지 않는다.
