#!/usr/bin/env bash
# Stop 훅: Claude가 작업을 끝내려 할 때 빠른 검사(lint, unit test)를 돌려
# 실패하면 종료를 막는다(exit 2 → stderr가 Claude에게 전달됨).
# 같은 세션에서 연속 3번 막으면 무한 루프를 피하려고 종료를 허용한다.
# package.json이 아직 없으면(T00 전) 검사를 건너뛴다.

set -u

LINT_CMD="pnpm -s lint"
TEST_CMD="pnpm -s test"
max_blocks=3

input="$(cat)"
session_id="unknown"
if command -v jq >/dev/null 2>&1; then
  session_id="$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)"
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$project_dir" || exit 0

# T00(모노레포 뼈대) 전에는 검사할 코드가 없다.
[ -f package.json ] || exit 0

counter_dir="${TMPDIR:-/tmp}/claude-stop-hook-$(basename "$project_dir")"
mkdir -p "$counter_dir"
counter_file="$counter_dir/$session_id"

failed=""
log="$(mktemp)"

run_check() {
  local name="$1" cmd="$2" lines="$3"
  [ -z "$cmd" ] && return 0
  if ! bash -c "$cmd" >"$log.$name" 2>&1; then
    failed="${failed:+$failed, }$name"
    tail -n "$lines" "$log.$name" >>"$log"
  fi
  rm -f "$log.$name"
}

run_check lint "$LINT_CMD" 40
run_check test "$TEST_CMD" 60

if [ -z "$failed" ]; then
  rm -f "$counter_file" "$log"
  exit 0
fi

count=$(( $(cat "$counter_file" 2>/dev/null || echo 0) + 1 ))

if [ "$count" -gt "$max_blocks" ]; then
  rm -f "$counter_file" "$log"
  echo "[stop-check] $failed 실패가 ${max_blocks}번 연속 이어져 종료를 허용합니다. 사용자에게 실패 내용을 보고하세요." >&2
  exit 0
fi

echo "$count" >"$counter_file"
{
  echo "[stop-check] 종료 차단 (${count}/${max_blocks}): $failed 실패. 고친 뒤 다시 끝내세요."
  echo "----"
  cat "$log"
} >&2
rm -f "$log"
exit 2
