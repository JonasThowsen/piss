#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "${1:?integration script is required}")
worker=$(realpath "${2:?worker executable is required}")
agent=$(realpath "${3:?agent executable is required}")
control=$(realpath "${4:?control executable is required}")
shift 4

source_root=$(git rev-parse --show-toplevel)
app_js="$source_root/web/_build/default/main.bc.js"
if [[ ! -f "$app_js" ]]; then
  echo "Bonsai bundle is missing; run 'just build-web' first" >&2
  exit 1
fi

exec bash "$script" "$worker" "$agent" "$control" \
  "$source_root/web/public" "$app_js" "$source_root" "$@"
