#!/usr/bin/env bash
# pre-commit 훅: 스테이징된 내용(작업 폴더 아님)을 secretlint로 검사한다.
# 커밋 안에 함께 들어온 .gitignore·.secretlintignore가 검사를 줄이지 못하게,
# gitignore 따르기를 끄고(--no-gitignore) 꺼낸 폴더의 .secretlintignore를 지운 뒤 검사한다.
set -euo pipefail
hooks_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$hooks_dir/../.." && pwd)"
secretlint="$project_root/node_modules/.bin/secretlint"
config="$project_root/.secretlintrc.json"

if [ ! -x "$secretlint" ]; then
  echo "[pre-commit] secretlint가 없습니다. 프로젝트 폴더에서 'pnpm install'을 먼저 실행하세요." >&2
  exit 1
fi

tmp="$(mktemp -d)"
out="$(mktemp)"
trap 'rm -rf "$tmp" "$out"' EXIT

# 추가·복사·수정·이름 변경·종류 변경된 파일의 스테이징 내용을 임시 폴더로 꺼낸다.
files_count="$(git diff --cached --name-only --diff-filter=ACMRT -z | tr -cd '\0' | wc -c | tr -d ' ')"
if [ "$files_count" = "0" ]; then
  exit 0
fi
if ! git diff --cached --name-only --diff-filter=ACMRT -z | xargs -0 git checkout-index --prefix="$tmp/" --; then
  echo "[pre-commit] 스테이징된 파일을 꺼내지 못해 비밀값 검사를 할 수 없습니다. 커밋을 막습니다." >&2
  exit 1
fi
find "$tmp" -name .secretlintignore -type f -delete

if ! (cd "$tmp" && "$secretlint" --secretlintrc "$config" --secretlintignore /dev/null --no-gitignore "**/*" >"$out" 2>&1); then
  sed "s#$tmp/##g" "$out" >&2
  echo "[pre-commit] 비밀값으로 보이는 내용이 있어 커밋을 막았습니다. 해당 값을 지우고 Secret Manager(defineSecret)나 functions/.secret.local로 옮긴 뒤 다시 커밋하세요." >&2
  exit 1
fi
