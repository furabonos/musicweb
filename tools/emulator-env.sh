#!/usr/bin/env bash
# 에뮬레이터 전용 설정값 파일을 만든다: functions/.env.demo-musicweb
# - Functions 에뮬레이터는 defineList·defineString 값을 셸 환경 변수가 아니라 functions/.env* 파일에서만 읽고,
#   값이 없으면 함수 로딩이 실패한다.
# - 이 파일은 가짜 프로젝트 demo-musicweb에만 적용되고(실제 배포에 안 쓰임), 비밀값이 없다.
#   .env* 는 커밋하지 않는 규칙(gitignore)이라 실행할 때마다 만든다 (D-022).
# - defineList 값은 실행 중에 JSON 배열로 읽힌다(firebase-functions ListParam). 쉼표 목록이 아니다.
set -euo pipefail
cd "$(dirname "$0")/.."
cat > functions/.env.demo-musicweb <<'ENV'
# tools/emulator-env.sh가 만든 파일. 고치지 말고 그 스크립트를 고친다.
ADMIN_EMAILS=["admin@example.com"]
MB_CONTACT=emulator@example.invalid
ENV
