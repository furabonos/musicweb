---
name: song-matching
description: 곡(MusicBrainz 녹음) ↔ YouTube 영상 연결 규칙 — 제목 정규화, 공식 음원·뮤직비디오·라이브·커버·리믹스 판별, 후보 점수, AI에 넘기는 기준. packages/shared/src/matching/, 수집 작업, 곡 연결 시험 문제를 건드릴 때 읽는다.
---

# 곡 연결 규칙 (musicweb)

목표: 곡마다 "틀기 좋은 공식 영상" 하나를 연결한다. 우선순위는 `official_audio` > `official_mv` > 나머지다. 라이브·커버·리믹스는 요청 조건이 있을 때만 쓴다.
규칙이 먼저다. AI는 **애매함 판정**에 걸린 것만 본다. 규칙을 바꾸면 `evals/matching` 점수가 떨어지지 않아야 한다.

## 1. 정규화 (비교용, 저장하지 않음)

1. 유니코드 NFKC, 소문자, 전각→반각, 따옴표·대시 통일 (`–—―` → `-`)
2. 꼬리말 제거 (괄호·대괄호 안, 대소문자 무시):
   - `official (music )?video`, `official audio`, `official visualizer`, `lyric(s)? video`
   - `mv`, `m/v`, `audio`, `visualizer`, `hd`, `4k`, `remastered( \d{4})?`, `explicit`, `clean`
   - 한국어 `뮤직비디오`, `공식`, 일본어 `公式`, `ミュージックビデオ`
3. 피처링 분리: `feat.`, `ft.`, `featuring`, `with` 뒤는 참여 아티스트 목록으로 떼어 낸다(곡 일치 판단에서는 무시).
4. `아티스트 - 제목` / `제목 - 아티스트` / `아티스트 「제목」` 형태를 분리한다. 채널 이름이 아티스트와 같으면 제목 전체를 곡 제목 후보로 본다.
5. 다국어 제목 `한글제목 (English Title)`은 둘 다 후보로 남긴다. MusicBrainz 별칭(alias)과 비교한다.

## 2. 종류 판별 (먼저 맞는 것)

| 신호                                                                             | 종류                 |
| -------------------------------------------------------------------------------- | -------------------- |
| 채널 이름이 `<아티스트> - Topic` 이거나 설명이 `Provided to YouTube by` 로 시작  | `official_audio`     |
| 공식 채널(MB URL 관계/Wikidata P2397와 일치) + `official audio`                  | `official_audio`     |
| 공식 채널 + `official (music )?video` / `mv` / `뮤직비디오`                      | `official_mv`        |
| 제목에 `live`, `concert`, `라이브`, `ライブ`, `session`, `tiny desk`, `@ <장소>` | `live`               |
| 제목에 `cover`, `커버`, `歌ってみた` 또는 채널이 아티스트와 무관                 | `cover`              |
| 제목에 `remix`, `rmx`, `edit`, `bootleg`, `sped up`, `slowed`, `nightcore`, `8d` | `remix`              |
| 그 외 공식 채널 영상 (티저·인터뷰·비하인드 등)                                   | `other` (연결 안 함) |

- `sped up`·`slowed`·`nightcore`·`8d` 같은 변형은 공식 채널이라도 `remix`로 본다.
- 변형(리믹스·라이브·커버) 표시는 Topic·Provided보다 **먼저** 본다. Topic 채널의 `(Live)` 트랙은 `live`다(D-026).
- Topic은 **그 곡 아티스트의 Topic**일 때만 `official_audio`다. 다른 가수의 Topic은 `cover`다.
- `Provided to YouTube by` 설명은 **공식 채널 ID와 함께일 때만** 인정한다(재업로드가 설명을 복사함).
- 변형 순서: 리믹스 → 커버 → 라이브. 남이 라이브로 부른 커버는 커버다.
- 원곡과 다른 판(`Inst.`, `Instrumental`, `MR`, `Karaoke`, `Acoustic`, `Demo`, `Japanese ver.` 등)은 연결하지 않는다.
- 제목이 그 곡과 맞지 않으면(완전 일치도 비율 ≥ 0.9도 아님) 후보가 아니다.
- 곡 제목·아티스트 이름에 든 단어는 신호로 보지 않는다(`Live Forever`, `Cover Me`, 밴드 `Live`). 단어 단위로만 지운다(`Up (Sped Up)`은 리믹스).
- 공식 채널이지만 표시(`official audio`/`mv` 등)가 없는 영상은 `other`(연결 안 함)다. 놓치는 경우가 있으면 시험 문제(T17) 점수로 판단해 바꾼다.
- `teaser`, `trailer`, `behind`, `making`, `interview`, `reaction`, `shorts`는 연결하지 않는다.
- 길이 60초 미만은 연결하지 않는다(Shorts·티저).

## 3. 후보 점수

| 항목                                           | 점수      |
| ---------------------------------------------- | --------- |
| 정규화한 제목이 곡 제목(또는 별칭)과 완전 일치 | +50       |
| 편집 거리 비율 ≥ 0.9                           | +30       |
| 공식 채널·Topic 채널                           | +30       |
| 영상 길이가 MB 녹음 길이 ±10초 안              | +15       |
| 아티스트명이 제목이나 채널에 있음              | +10       |
| 종류가 요청과 맞지 않음                        | 후보 제외 |

**애매함 판정**: 다음 중 하나면 AI에게 넘긴다(구조화 출력, 후보 ID 중 하나 또는 "없음"만 받는다).

- 구현: `packages/shared/src/matching/` (`decideLink`, 판정 함수 `Judge`는 후보 ID 또는 null만, 후보는 최대 5개)
- 1등 점수 < 70
- 1등과 2등의 차이 < 10 (같은 우선순위 종류끼리만. 공식 음원 vs 공식 MV는 우선순위로 정함)
- 제목 분리 실패

## 4. 시험 문제와 예시

- `evals/matching/cases.json`: 정답 50곡. 곡 MBID, 녹화한 영상 후보들, 정답 videoId·종류.
- 단위 테스트 예시는 최소 40개다. 한·영·일 제목, Topic 채널, `Provided to YouTube by`, 라이브·커버·리믹스 함정, 피처링, 다국어 제목을 포함한다.
- 관리자가 연결을 고치면(관리자 화면) 그 사례를 시험 문제에 추가하는 PR을 만든다.
- 규칙 변경 PR에는 `pnpm eval` 전후 점수를 적는다.
