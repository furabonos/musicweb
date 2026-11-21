#!/usr/bin/env bash
# Firebase 에뮬레이터는 Java 21 이상이 필요하다.
# 지금 java가 없거나 21 미만이면 Homebrew openjdk 경로를 붙여 실행한다.
set -euo pipefail

java_major() {
  "$1" -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print v[1]; exit }'
}

ok_java() {
  local bin="$1" major
  major="$(java_major "$bin" 2>/dev/null || true)"
  [ -n "$major" ] && [ "$major" -ge 21 ] 2>/dev/null
}

if ! ok_java java; then
  for dir in /opt/homebrew/opt/openjdk@21/bin /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk@21/bin /usr/local/opt/openjdk/bin; do
    if [ -x "$dir/java" ] && ok_java "$dir/java"; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

if ! ok_java java; then
  echo "[with-java] Java 21 이상을 찾지 못했습니다. 'brew install openjdk@21'로 설치하세요 (Firebase 에뮬레이터에 필요)." >&2
  exit 1
fi
exec "$@"
