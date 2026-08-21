#!/usr/bin/env bash
set -euo pipefail
worker=$1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
expect_rejected() {
  local label=$1
  shift
  if "$worker" --socket "$tmp/worker.sock" --database "$tmp/worker.sqlite3" \
      --workspace "$PWD" "$@" >"$tmp/out" 2>"$tmp/err"; then
    echo "$label identity unexpectedly started a worker" >&2
    exit 1
  fi
  grep -Eq 'must contain between 1 and 128 characters|must not contain NUL' \
    "$tmp/err" || {
      echo "$label rejection did not report nominal ID validation" >&2
      cat "$tmp/err" >&2
      exit 1
    }
}
expect_rejected session --session '' --worker valid-worker
expect_rejected worker --session valid-session --worker ''
printf 'worker CLI nominal-ID validation passed\n'
