#!/usr/bin/env bash
# pre-push 훅: main(refs/heads/main)으로 가는 push를 거부한다.
# git이 stdin으로 "<local ref> <local sha> <remote ref> <remote sha>" 줄을 넘긴다.
set -u
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${remote_ref:-}" ] && continue
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "[pre-push] main에 직접 push할 수 없습니다. 작업 브랜치를 만들어 push하고 PR을 여세요: git switch -c <브랜치 이름>" >&2
    status=1
  fi
done
exit $status
