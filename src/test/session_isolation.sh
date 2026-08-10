#!/usr/bin/env bash
set -euo pipefail

worker_exe=$(realpath "${1:?worker executable is required}")
agent_exe=$(realpath "${2:?mock agent executable is required}")
control_exe=$(realpath "${3:?control executable is required}")
public_dir=$(realpath "${4:?public directory is required}")
app_js=$(realpath "${5:?browser bundle is required}")
workspace=$(realpath "${6:?workspace is required}")
session_mcp_exe=$(realpath "${7:?session MCP executable is required}")
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
  --workspace-spec "test-workspace|Test workspace|$workspace"
  --workspace-spec "configured-empty|Configured empty|$root/configured-empty"
  --workspace-discovery-root "$root"
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

targeted_for() {
  local id=$1 body=$2 target
  target=$(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$id" |
    jq -c '{sessionId,workerId,runtimeGeneration}')
  jq -c --argjson target "$target" '. + {target:$target}' <<<"$body"
}

mkdir -p "$root/configured-empty"
start_control
wait_session_count 1
workspaces=$(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces")
[[ $(jq -r '.[0].id' <<<"$workspaces") == test-workspace ]]
[[ $(jq -r '.[0].root' <<<"$workspaces") == "$workspace" ]]
[[ $(jq --arg id configured-empty 'any(.[]; .id==$id)' <<<"$workspaces") == true ]]
curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/workspaces/configured-empty/delete" >/dev/null
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces" | jq --arg id configured-empty 'any(.[]; .id==$id)') == false ]]
mkdir -p "$root/local-project"
printf 'outside the selected session workspace\n' >"$root/local-project/OnlyOtherWorkspace.txt"
first=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r '.[0].id')
scoped_mentions=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/file-mentions?session=$first&query=OnlyOtherWorkspace")
[[ $(jq 'length' <<<"$scoped_mentions") == 0 ]]
directories=$(curl -fsS "http://127.0.0.1:$port/api/v2/workspace-directories?query=local-project")
[[ $(jq -r '.[0].path' <<<"$directories") == "$root/local-project" ]]
registered=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"path\":\"$root/local-project\"}" \
  "http://127.0.0.1:$port/api/v2/workspaces")
[[ $(jq -r .root <<<"$registered") == "$root/local-project" ]]
outside_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data '{"path":"/tmp"}' \
  "http://127.0.0.1:$port/api/v2/workspaces")
[[ "$outside_status" == 403 ]]
second=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"harness":"opencode","workspaceId":"test-workspace","title":"Review agent"}' "http://127.0.0.1:$port/api/v2/sessions" | jq -r .id)
third=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"harness":"pi","workspaceId":"test-workspace","title":"Implementation agent"}' "http://127.0.0.1:$port/api/v2/sessions" | jq -r .id)
[[ "$first" != "$second" && "$first" != "$third" && "$second" != "$third" ]]
wait_session_count 3
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/workspaces/test-workspace/delete") == 409 ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r --arg id "$second" '.[]|select(.id==$id)|.title') == "Review agent" ]]
[[ $(cat "$state/sessions/$second/workspace") == "$workspace" ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"title":"OpenCode reviewer"}' \
  "http://127.0.0.1:$port/api/v2/sessions/$second/rename" >/dev/null
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r --arg id "$second" '.[]|select(.id==$id)|.title') == "OpenCode reviewer" ]]

curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(targeted_for "$first" '{"commandId":"first-command","text":"work in first"}')" \
  "http://127.0.0.1:$port/api/v2/commands?session=$first" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(targeted_for "$second" '{"commandId":"second-command","text":"work in second"}')" \
  "http://127.0.0.1:$port/api/v2/commands?session=$second" >/dev/null
for _ in $(seq 1 400); do
  command_completed "$first" first-command && command_completed "$second" second-command && break
  sleep .02
done
command_completed "$first" first-command
command_completed "$second" second-command

first_token=$(tr -d '\n' <"$state/sessions/$first/broker-token")
peer_body=$(jq -nc --arg target "$second" \
  '{requestId:"peer-isolation",targetSessionId:$target,prompt:"review the isolation proof"}')
peer_response=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$peer_body" \
  "http://127.0.0.1:$port/api/v2/broker/ask")
[[ $(jq -r .response <<<"$peer_response") == \
  "The worker retained ownership while the control plane was replaceable." ]]
[[ $(jq -r .duplicate <<<"$peer_response") == false ]]
peer_duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$peer_body" \
  "http://127.0.0.1:$port/api/v2/broker/ask")
[[ $(jq -r .duplicate <<<"$peer_duplicate") == true ]]
mcp_input=$(jq -nc --arg second "$second" --arg third "$third" '[
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}},
  {jsonrpc:"2.0",id:2,method:"tools/list",params:{}},
  {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"piss_send_session",arguments:{targetSessionId:$second,prompt:"answer the first fan-out request"}}},
  {jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"piss_send_session",arguments:{targetSessionId:$third,prompt:"answer the second fan-out request"}}}
] | .[]')
fanout_started=$(date +%s%3N)
mcp_output=$(printf '%s\n' "$mcp_input" | env \
  PISS_BROKER_URL="http://127.0.0.1:$port" \
  PISS_SESSION_TOKEN="$first_token" PISS_CURL="$(command -v curl)" \
  "$session_mcp_exe")
[[ $(jq -r 'select(.id==2)|.result.tools|map(.name)|join(",")' <<<"$mcp_output") == \
  "piss_list_sessions,piss_ask_session,piss_send_session,piss_subscribe_responses,piss_collect_responses" ]]
first_async=$(jq -r 'select(.id==3)|.result.content[0].text|fromjson|.requestId' <<<"$mcp_output")
second_async=$(jq -r 'select(.id==4)|.result.content[0].text|fromjson|.requestId' <<<"$mcp_output")
collect_any_input=$(jq -nc --arg first "$first_async" --arg second "$second_async" '[
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"piss_collect_responses",arguments:{requestIds:[$first,$second],waitFor:"any",timeoutSeconds:10}}}
] | .[]')
collect_any_output=$(printf '%s\n' "$collect_any_input" | env \
  PISS_BROKER_URL="http://127.0.0.1:$port" \
  PISS_SESSION_TOKEN="$first_token" PISS_CURL="$(command -v curl)" \
  "$session_mcp_exe")
collect_any_json=$(jq -r 'select(.id==2)|.result.content[0].text|fromjson' <<<"$collect_any_output")
[[ $(jq '.responses|length >= 1' <<<"$collect_any_json") == true ]]
collect_all_input=$(jq -nc --arg first "$first_async" --arg second "$second_async" '[
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"piss_collect_responses",arguments:{requestIds:[$first,$second],waitFor:"all",timeoutSeconds:10}}}
] | .[]')
collect_all_output=$(printf '%s\n' "$collect_all_input" | env \
  PISS_BROKER_URL="http://127.0.0.1:$port" \
  PISS_SESSION_TOKEN="$first_token" PISS_CURL="$(command -v curl)" \
  "$session_mcp_exe")
fanout_elapsed=$(( $(date +%s%3N) - fanout_started ))
collect_json=$(jq -r 'select(.id==2)|.result.content[0].text|fromjson' <<<"$collect_all_output")
[[ $(jq '.responses|length' <<<"$collect_json") == 2 ]]
[[ $(jq '.pendingRequestIds|length' <<<"$collect_json") == 0 ]]
[[ $(jq '[.responses[].response|select(.=="The worker retained ownership while the control plane was replaceable.")]|length' <<<"$collect_json") == 2 ]]
[[ "$fanout_elapsed" -lt 3800 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(targeted_for "$first" '{"commandId":"source-still-active","text":"finish the original orchestrator turn"}')" \
  "http://127.0.0.1:$port/api/v2/commands?session=$first" >/dev/null
idle_subscription=$(jq -nc --arg first "$first_async" --arg second "$second_async" \
  '{subscriptionId:"wake-until-source-idle",requestIds:[$first,$second],waitFor:"all"}')
curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$idle_subscription" \
  "http://127.0.0.1:$port/api/v2/broker/subscribe" >/dev/null
idle_wake_command=$(python3 - <<'PY'
import hashlib
print("peer-wake-" + hashlib.md5(b"wake-until-source-idle").hexdigest())
PY
)
for _ in $(seq 1 600); do
  command_completed "$first" "$idle_wake_command" && break
  sleep .02
done
command_completed "$first" source-still-active
command_completed "$first" "$idle_wake_command"
first_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$first")
source_completed_sequence=$(jq '[.[]|select(.kind=="command.state" and .payload.commandId=="source-still-active" and .payload.state=="completed")][0].sequence' <<<"$first_events")
wake_accepted_sequence=$(jq --arg command "$idle_wake_command" '[.[]|select(.kind=="command.accepted" and .payload.commandId==$command)][0].sequence' <<<"$first_events")
[[ "$wake_accepted_sequence" -gt "$source_completed_sequence" ]]
[[ $(jq --arg command "$idle_wake_command" '[.[]|select(.kind=="command.accepted" and .payload.commandId==$command)]|length' <<<"$first_events") == 1 ]]
first_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$first")
second_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$second")
[[ $(jq '[.[]|select(.kind=="session.ask.sent" and .payload.requestId=="peer-isolation")]|length' <<<"$first_events") == 1 ]]
[[ $(jq '[.[]|select(.kind=="session.ask.completed" and .payload.requestId=="peer-isolation")]|length' <<<"$first_events") == 1 ]]
[[ $(jq '[.[]|select(.kind=="session.ask.received" and .payload.requestId=="peer-isolation")]|length' <<<"$second_events") == 1 ]]

first_worker=$(cat "$root/supervisors/$first.child")
second_worker=$(cat "$root/supervisors/$second.child")
third_worker=$(cat "$root/supervisors/$third.child")
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

wake_first_body=$(jq -nc --arg target "$second" \
  '{requestId:"wake-control-first",targetSessionId:$target,prompt:"finish the first durable wake request"}')
wake_second_body=$(jq -nc --arg target "$third" \
  '{requestId:"wake-control-second",targetSessionId:$target,prompt:"finish the second durable wake request"}')
curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$wake_first_body" \
  "http://127.0.0.1:$port/api/v2/broker/send" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$wake_second_body" \
  "http://127.0.0.1:$port/api/v2/broker/send" >/dev/null
wake_subscription=$(jq -nc \
  '{subscriptionId:"wake-control-restart",requestIds:["wake-control-first","wake-control-second"],waitFor:"all"}')
subscription_response=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$wake_subscription" \
  "http://127.0.0.1:$port/api/v2/broker/subscribe")
[[ $(jq -r .state <<<"$subscription_response") == pending ]]
sleep .3
old_control=$control_pid
kill -9 "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
start_control
[[ "$control_pid" != "$old_control" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces" | jq --arg id configured-empty 'any(.[]; .id==$id)') == false ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$second" | jq -r .workerPid) == "$second_worker" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$third" | jq -r .workerPid) == "$third_worker" ]]
wake_command=$(python3 - <<'PY'
import hashlib
print("peer-wake-" + hashlib.md5(b"wake-control-restart").hexdigest())
PY
)
for _ in $(seq 1 600); do
  command_completed "$first" "$wake_command" && break
  sleep .02
done
command_completed "$first" "$wake_command"
first_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$first")
[[ $(jq --arg command "$wake_command" '[.[]|select(.kind=="command.accepted" and .payload.commandId==$command)]|length' <<<"$first_events") == 1 ]]
wake_prompt=$(jq -r --arg command "$wake_command" '[.[]|select(.kind=="command.accepted" and .payload.commandId==$command)][0].payload.text' <<<"$first_events")
[[ "$wake_prompt" == *wake-control-first* && "$wake_prompt" == *wake-control-second* ]]
[[ $(grep -o 'The worker retained ownership while the control plane was replaceable.' <<<"$wake_prompt" | wc -l) == 2 ]]
wake_state=$(python3 - "$state/registry.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute("select state from peer_subscriptions where id = 'wake-control-restart'").fetchone()[0])
PY
)
[[ "$wake_state" == delivered ]]
second_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$second")
third_events=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?recent=500&session=$third")
[[ $(jq '[.[]|select(.kind=="command.accepted" and .payload.commandId=="peer-4e241a043f8b1499264cea36590a39d4")]|length' <<<"$second_events") == 1 ]]
[[ $(jq '[.[]|select(.kind=="command.accepted" and .payload.commandId=="peer-fd4ac6c02d97bb22f38918c9dc354468")]|length' <<<"$third_events") == 1 ]]

curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/$first/archive" >/dev/null
wait_session_count 2
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq --arg id "$second" 'any(.[]; .id==$id)') == true ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq --arg id "$third" 'any(.[]; .id==$id)') == true ]]
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
wait_session_count 3
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
recent_page=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?session=$first&recent=2")
[[ $(jq 'length' <<<"$recent_page") == 2 ]]
before=$(jq -r '.[0].sequence' <<<"$recent_page")
older_page=$(curl -fsS \
  "http://127.0.0.1:$port/api/v2/events?session=$first&before=$before&limit=2")
[[ $(jq 'length' <<<"$older_page") == 2 ]]
[[ $(jq -r '.[-1].sequence' <<<"$older_page") -lt "$before" ]]
[[ $(jq -r '.[0].sequence' <<<"$older_page") -lt $(jq -r '.[-1].sequence' <<<"$older_page") ]]

# Archiving the final active session is valid, and an empty registry must remain
# empty when the replaceable control plane starts again.
for id in "$first" "$second" "$third"; do
  curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
    "http://127.0.0.1:$port/api/v2/sessions/$id/archive" >/dev/null
done
wait_session_count 0
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true" | jq 'length') == 3 ]]
empty_control=$control_pid
kill "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
start_control
[[ "$control_pid" != "$empty_control" ]]
wait_session_count 0
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true" | jq 'length') == 3 ]]

printf 'session isolation proof passed: first=%s replacement=%s restored=%s second=%s third=%s fanout_ms=%s control=%s->%s final_archive=preserved\n' \
  "$first_worker" "$replacement" "$restored_worker" "$second_worker" "$third" "$fanout_elapsed" "$old_control" "$control_pid"
