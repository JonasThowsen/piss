#!/usr/bin/env bash
set -euo pipefail

worker_exe=$(realpath "${1:?worker executable is required}")
agent_exe=$(realpath "${2:?mock agent executable is required}")
control_exe=$(realpath "${3:?control executable is required}")
public_dir=$(realpath "${4:?public directory is required}")
app_js=$(realpath "${5:?browser bundle is required}")
workspace=$(realpath "${6:?workspace is required}")
browser_tests=("${@:7}")
[[ ${#browser_tests[@]} -gt 0 ]] || { echo "browser test is required" >&2; exit 64; }
port=${PISS_TEST_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)}
root=$(mktemp -d /tmp/piss-mention-browser.XXXXXX)
state="$root/state"
runtime="$root/runtime"
mkdir -p "$state/sessions" "$runtime" "$root/pids"
control_pid=

cleanup() {
  if [[ ${PISS_KEEP_TEST_STATE:-0} == 1 ]]; then
    echo "mention browser state retained at $root" >&2
    return
  fi
  [[ -z "$control_pid" ]] || kill "$control_pid" 2>/dev/null || true
  for file in "$root"/pids/*; do
    [[ -e "$file" ]] || continue
    kill "$(cat "$file")" 2>/dev/null || true
  done
  rm -rf "$root"
}
trap cleanup EXIT

cat >"$root/launch" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
root='$root'
mkdir -p "\$root/state/sessions/\$id" "\$root/runtime/\$id"
if [[ -f "\$root/pids/\$id" ]] && kill -0 "\$(cat "\$root/pids/\$id")" 2>/dev/null; then exit 0; fi
harness=\$(tr -d '\n' <"\$root/state/sessions/\$id/harness")
[[ "\$harness" == mock ]] || exit 64
PISS_MOCK_DURATION=5 '$worker_exe' \\
  --socket "\$root/runtime/\$id/worker.sock" \\
  --database "\$root/state/sessions/\$id/worker.sqlite3" \\
  --session "\$id" --worker "worker-\$id" --generation mention-browser \\
  --workspace "\$(tr -d '\n' <"\$root/state/sessions/\$id/workspace")" \\
  --harness '$agent_exe' >"\$root/state/sessions/\$id/worker.log" 2>&1 &
echo \$! >"\$root/pids/\$id"
for _ in \$(seq 1 300); do [[ -S "\$root/runtime/\$id/worker.sock" ]] && exit 0; sleep .02; done
exit 1
EOF
cat >"$root/stop" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
root='$root'
[[ ! -f "\$root/pids/\$id" ]] || kill "\$(cat "\$root/pids/\$id")" 2>/dev/null || true
EOF
chmod +x "$root/launch" "$root/stop"

"$control_exe" --port "$port" --registry "$state/registry.sqlite3" \
  --session-state-root "$state/sessions" --session-runtime-root "$runtime" \
  --session-launcher "$root/launch" --session-stopper "$root/stop" \
  --available-harness mock --default-harness mock \
  --workspace-spec "test-workspace|PISS rewrite|$workspace" \
  --workspace-discovery-root "$workspace" \
  --bootstrap-session s-mention-browser --public "$public_dir" --app-js "$app_js" \
  --generation mention-browser --dev-bypass-auth >"$root/control.log" 2>&1 &
control_pid=$!
for _ in $(seq 1 500); do
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
  kill -0 "$control_pid" 2>/dev/null || { cat "$root/control.log" >&2; exit 1; }
  sleep .02
done

for browser_test in "${browser_tests[@]}"; do
  node "$(realpath "$browser_test")" "http://127.0.0.1:$port" "$workspace"
done
