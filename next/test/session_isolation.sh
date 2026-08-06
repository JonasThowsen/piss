#!/usr/bin/env bash
set -euo pipefail

worker_exe=$(realpath "${1:?worker executable is required}")
agent_exe=$(realpath "${2:?mock agent executable is required}")
control_exe=$(realpath "${3:?control executable is required}")
public_dir=$(realpath "${4:?public directory is required}")
app_js=$(realpath "${5:?browser bundle is required}")
workspace=$(realpath "${6:?workspace is required}")
port=${PISS_TEST_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)}
root=$(mktemp -d /tmp/piss-isolation.XXXXXX)
state="$root/state"
runtime="$root/runtime"
mkdir -p "$state/sessions" "$runtime"
control_pid=

cleanup() {
  if [[ ${PISS_KEEP_TEST_STATE:-0} == 1 ]]; then
    echo "session isolation state retained at $root" >&2
    return
  fi
  [[ -z "$control_pid" ]] || kill "$control_pid" 2>/dev/null || true
  if [[ -d "$root/supervisors" ]]; then
    for file in "$root"/supervisors/*.pid; do
      [[ -e "$file" ]] || continue
      kill "$(cat "$file")" 2>/dev/null || true
    done
  fi
  rm -rf "$root"
}
trap cleanup EXIT

cat >"$root/supervise" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
echo \$\$ >"$root/supervisors/\$id.pid"
child=
trap '[[ -z "\${child:-}" ]] || kill "\$child" 2>/dev/null || true; exit 0' TERM INT
while true; do
  rm -f "$runtime/\$id/worker.sock"
  PISS_MOCK_DURATION=2 '$worker_exe' --socket "$runtime/\$id/worker.sock" \\
    --database "$state/sessions/\$id/worker.sqlite3" --session "\$id" \\
    --worker "worker-\$id" --workspace '$workspace' --harness '$agent_exe' \\
    >>"$root/supervisors/\$id.log" 2>&1 &
  child=\$!
  echo "\$child" >"$root/supervisors/\$id.child"
  wait "\$child" || true
  sleep .1
done
EOF
chmod +x "$root/supervise"

cat >"$root/launch" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
root='$root'
mkdir -p "\$root/supervisors" "\$root/runtime/\$id" "\$root/state/sessions/\$id"
if [[ -f "\$root/supervisors/\$id.pid" ]] && kill -0 "\$(cat "\$root/supervisors/\$id.pid")" 2>/dev/null; then exit 0; fi
setsid -f "\$root/supervise" "\$id" </dev/null >/dev/null 2>&1
for _ in \$(seq 1 100); do [[ -f "\$root/supervisors/\$id.pid" ]] && exit 0; sleep .01; done
exit 1
EOF
chmod +x "$root/launch"

cat >"$root/stop" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
root='$root'
[[ ! -f "\$root/supervisors/\$id.pid" ]] || kill "\$(cat "\$root/supervisors/\$id.pid")" 2>/dev/null || true
[[ ! -f "\$root/supervisors/\$id.child" ]] || kill "\$(cat "\$root/supervisors/\$id.child")" 2>/dev/null || true
rm -f "\$root/supervisors/\$id.pid"
EOF
chmod +x "$root/stop"

control_args=(
  --port "$port"
  --registry "$state/registry.sqlite3"
  --session-state-root "$state/sessions"
  --session-runtime-root "$runtime"
  --session-launcher "$root/launch"
  --session-stopper "$root/stop"
  --available-harness pi
  --available-harness opencode
  --default-harness pi
  --bootstrap-session s-bootstrap
  --public "$public_dir"
  --app-js "$app_js"
  --generation isolation-test
  --dev-bypass-auth
)

start_control() {
  "$control_exe" "${control_args[@]}" >>"$root/control.log" 2>&1 &
  control_pid=$!
  for _ in $(seq 1 500); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return
    kill -0 "$control_pid" 2>/dev/null || { cat "$root/control.log" >&2; exit 1; }
    sleep .02
  done
  cat "$root/control.log" >&2
  exit 1
}

wait_session_count() {
  local expected=$1
  for _ in $(seq 1 500); do
    sessions=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" 2>/dev/null || echo '[]')
    [[ $(jq 'length' <<<"$sessions") == "$expected" ]] &&
      [[ $(jq '[.[] | select(.status == "idle")] | length' <<<"$sessions") == "$expected" ]] && return
    sleep .02
  done
  jq . <<<"${sessions:-[]}" >&2
  cat "$root/control.log" >&2 || true
  for log in "$root"/supervisors/*.log; do
    [[ ! -e "$log" ]] || { echo "--- $log" >&2; tail -40 "$log" >&2; }
  done
  exit 1
}

command_completed() {
  local id=$1 command=$2
  curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0&session=$id" |
    jq -e --arg command "$command" 'any(.[]; .kind == "command.state" and .payload.commandId == $command and .payload.state == "completed")' >/dev/null
}

start_control
wait_session_count 1
first=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r '.[0].id')
second=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"harness":"opencode"}' "http://127.0.0.1:$port/api/v2/sessions" | jq -r .id)
[[ "$first" != "$second" ]]
wait_session_count 2

curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"first-command","text":"work in first"}' \
  "http://127.0.0.1:$port/api/v2/commands?session=$first" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"second-command","text":"work in second"}' \
  "http://127.0.0.1:$port/api/v2/commands?session=$second" >/dev/null
for _ in $(seq 1 400); do
  command_completed "$first" first-command && command_completed "$second" second-command && break
  sleep .02
done
command_completed "$first" first-command
command_completed "$second" second-command

first_worker=$(cat "$root/supervisors/$first.child")
second_worker=$(cat "$root/supervisors/$second.child")
kill -9 "$first_worker"
for _ in $(seq 1 500); do
  replacement=$(cat "$root/supervisors/$first.child" 2>/dev/null || true)
  [[ -n "$replacement" && "$replacement" != "$first_worker" ]] &&
    curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" >/dev/null 2>&1 && break
  sleep .02
done
[[ "$replacement" != "$first_worker" ]]
kill -0 "$second_worker"
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$second" | jq -r .workerPid) == "$second_worker" ]]

old_control=$control_pid
kill -9 "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
start_control
[[ "$control_pid" != "$old_control" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$second" | jq -r .workerPid) == "$second_worker" ]]

curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/$first/archive" >/dev/null
wait_session_count 1
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r '.[0].id') == "$second" ]]
[[ -f "$state/sessions/$first/worker.sqlite3" ]]
archived=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true")
[[ $(jq -r '.[0].id' <<<"$archived") == "$first" ]]
[[ $(jq -r '.[0].status' <<<"$archived") == archived ]]
ledger_before_restore=$(python3 - "$state/sessions/$first/worker.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute("select count(*) from events").fetchone()[0])
PY
)

curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/$first/restore" >/dev/null
wait_session_count 2
restored_worker=$(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .workerPid)
[[ "$restored_worker" != "$replacement" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$second" | jq -r .workerPid) == "$second_worker" ]]
command_completed "$first" first-command
ledger_after_restore=$(python3 - "$state/sessions/$first/worker.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute("select count(*) from events").fetchone()[0])
PY
)
[[ "$ledger_after_restore" -ge "$ledger_before_restore" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true" | jq 'length') == 0 ]]

printf 'session isolation proof passed: first=%s replacement=%s restored=%s second=%s control=%s->%s\n' \
  "$first_worker" "$replacement" "$restored_worker" "$second_worker" "$old_control" "$control_pid"
