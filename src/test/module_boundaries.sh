#!/usr/bin/env bash
set -euo pipefail
root=${1:-.}
while IFS= read -r -d '' dune; do
  if [[ "$dune" == "$root/src/lib/dune" ]]; then
    continue # the compatibility facade is declared only here
  fi
  if grep -Eq '(^|[[:space:]])piss\.core([[:space:]]|$)' "$dune"; then
    echo "ownership bypass in $dune" >&2
    exit 1
  fi
done < <(find "$root/src" -name dune -print0)
if grep -Eq 'piss\.(registry|origin)' "$root/src/worker/dune"; then
  echo "worker depends on a control-owned library" >&2
  exit 1
fi
if grep -Eq 'piss\.(worker-store|workspace-io)' "$root/src/control/dune"; then
  echo "control depends on a worker-owned library" >&2
  exit 1
fi
for seam in piss.persistence piss.worker-store piss.registry piss.workspace-io; do
  grep -Fq "(public_name $seam)" "$root/src/lib/dune" || {
    echo "missing ownership seam $seam" >&2
    exit 1
  }
done
printf 'module ownership boundaries are compiler-enforced\n'
