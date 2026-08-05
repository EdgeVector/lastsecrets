#!/usr/bin/env bash
# LastGit merge gate for lastsecrets (private).
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== shell syntax =="
for f in .lastgit/*.sh scripts/*.sh; do
  [ -e "$f" ] || continue
  echo "bash -n $f"
  bash -n "$f"
done

echo "== dependencies =="
bun install --frozen-lockfile

echo "== typecheck / build =="
for f in src/*.ts test/*.ts; do
  [ -e "$f" ] || continue
  echo "bun build $f"
  bun build "$f" --target=bun --outfile=/dev/null
done

echo "== artifact build =="
bun run build

echo "== unit tests =="
bun test

echo "lastgit ci gate PASSED"
