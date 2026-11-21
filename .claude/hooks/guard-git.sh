#!/usr/bin/env bash
# PreToolUse(Bash) 훅 진입점. 판단 로직은 guard-git.mjs (의존성 없는 Node 스크립트).
exec node "$(dirname "$0")/guard-git.mjs"
