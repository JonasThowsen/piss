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
echo "\$id" >>"\$root/launch-invocations"
mkdir -p "\$root/supervisors" "\$root/runtime/\$id" "\$root/state/sessions/\$id"
if [[ -f "\$root/launch-delay" ]]; then
  echo "start \$id" >>"\$root/launch-events"
  sleep "\$(cat "\$root/launch-delay")"
  echo "finish \$id" >>"\$root/launch-events"
fi
if [[ -f "\$root/supervisors/\$id.pid" ]] && kill -0 "\$(cat "\$root/supervisors/\$id.pid")" 2>/dev/null; then exit 0; fi
setsid -f "\$root/supervise" "\$id" </dev/null >/dev/null 2>&1
for _ in \$(seq 1 100); do
  if [[ -f "\$root/supervisors/\$id.pid" ]]; then
    [[ ! -f "\$root/force-launch-failure" ]] || exit 1
    exit 0
  fi
  sleep .01
done
exit 1
EOF
chmod +x "$root/launch"

cat >"$root/stop" <<EOF
#!/usr/bin/env bash
set -euo pipefail
id=\${1:?}
root='$root'
if [[ -f "\$root/stop-delay" ]]; then
  echo "\$id" >"\$root/stop-started"
  sleep "\$(cat "\$root/stop-delay")"
fi
if [[ -f "\$root/force-stop-failure" ]]; then
  rm -f "\$root/force-stop-failure"
  exit 1
fi
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
  --max-active-sessions 4
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
session_creation=$(curl -fsS "http://127.0.0.1:$port/api/v2/session-creation")
[[ $(jq -c .availableHarnesses <<<"$session_creation") == '["pi","opencode"]' ]]
[[ $(jq -r .defaultHarness <<<"$session_creation") == pi ]]
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
# A launcher may fail after supervision has already started. The failed
# session must be archived and its worker stopped rather than left hidden.
touch "$root/force-launch-failure"
failed_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' \
  --data '{"harness":"pi","workspaceId":"test-workspace","title":"Failing launcher"}' \
  "http://127.0.0.1:$port/api/v2/sessions")
rm -f "$root/force-launch-failure"
[[ "$failed_status" == 409 ]]
failed_id=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true" |
  jq -r '.[] | select(.title == "Failing launcher") | .id')
[[ -n "$failed_id" ]]
[[ ! -e "$root/supervisors/$failed_id.pid" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq 'length') == 1 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"ids\":[\"$failed_id\"]}" \
  "http://127.0.0.1:$port/api/v2/sessions/delete-archived" >/dev/null
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

# An active agent can register only an existing canonical directory under an
# approved discovery root. Repeated request identities and canonical roots are
# durable and do not create duplicate workspace rows.
mkdir -p "$root/agent-project"
ln -s /tmp "$root/agent-project-escape"
agent_workspace_body=$(jq -nc --arg path "$root/agent-project" \
  '{requestId:"agent-workspace-request",path:$path}')
[[ $(curl -sS -o "$root/unauthorized-workspace.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'x-piss-session-token: fake-token' \
  --data "$agent_workspace_body" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces") == 401 ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data '{"requestId":"outside-workspace-request","path":"/tmp"}' \
  "http://127.0.0.1:$port/api/v2/broker/workspaces") == 403 ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg path "$root/agent-project-escape" \
    '{requestId:"escape-workspace-request",path:$path}')" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces") == 403 ]]
agent_workspace_response=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$agent_workspace_body" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces")
agent_workspace=$(jq -r .workspace.id <<<"$agent_workspace_response")
[[ $(jq -r .workspace.root <<<"$agent_workspace_response") == "$root/agent-project" ]]
[[ $(jq -r .duplicate <<<"$agent_workspace_response") == false ]]
agent_workspace_duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$agent_workspace_body" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces")
[[ $(jq -r .duplicate <<<"$agent_workspace_duplicate") == true ]]
agent_workspace_reused=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg path "$root/agent-project" \
    '{requestId:"agent-workspace-reuse",path:$path}')" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces")
[[ $(jq -r .workspace.id <<<"$agent_workspace_reused") == "$agent_workspace" ]]
mv "$root/agent-project" "$root/agent-project-real"
ln -s /tmp "$root/agent-project"
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg workspace "$agent_workspace" \
    '{requestId:"rebound-workspace-session",workspaceId:$workspace,title:"Escape",harness:"pi"}')" \
  "http://127.0.0.1:$port/api/v2/broker/sessions") == 409 ]]
rm "$root/agent-project"
mv "$root/agent-project-real" "$root/agent-project"
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data '{"requestId":"agent-workspace-request","path":"/tmp"}' \
  "http://127.0.0.1:$port/api/v2/broker/workspaces") == 403 ]]

[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg workspace "$agent_workspace" \
    '{requestId:"invalid-harness-request",workspaceId:$workspace,title:"Invalid",harness:"hidden"}')" \
  "http://127.0.0.1:$port/api/v2/broker/sessions") == 409 ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg workspace "$agent_workspace" \
    '{requestId:"invalid-title-request",workspaceId:$workspace,title:"",harness:"pi"}')" \
  "http://127.0.0.1:$port/api/v2/broker/sessions") == 409 ]]

touch "$root/force-launch-failure" "$root/force-stop-failure"
failed_agent_body=$(jq -nc --arg workspace "$agent_workspace" \
  '{requestId:"failed-agent-request",workspaceId:$workspace,title:"Failed agent",harness:"pi"}')
[[ $(curl -sS -o "$root/failed-agent.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$failed_agent_body" \
  "http://127.0.0.1:$port/api/v2/broker/sessions") == 409 ]]
rm -f "$root/force-launch-failure"
failed_agent_id=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | \
  jq -r '.[] | select(.title=="Failed agent") | .id')
[[ -n "$failed_agent_id" ]]
for _ in $(seq 1 100); do
  duplicate_status=$(curl -sS -o "$root/failed-agent-duplicate.json" -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
    --data "$failed_agent_body" \
    "http://127.0.0.1:$port/api/v2/broker/sessions")
  [[ $duplicate_status == 409 && $(jq -r .state "$root/failed-agent-duplicate.json") == failed ]] && break
  sleep .05
done
[[ $(jq -r .state "$root/failed-agent-duplicate.json") == failed ]]
[[ $(jq -r .duplicate "$root/failed-agent-duplicate.json") == true ]]
[[ ! -e "$root/supervisors/$failed_agent_id.pid" ]]

agent_session_body=$(jq -nc --arg workspace "$agent_workspace" \
  '{requestId:"agent-session-request",workspaceId:$workspace,title:"Agent-created reviewer",harness:"opencode"}')
curl -sS -o "$root/agent-session-one.json" -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$agent_session_body" \
  "http://127.0.0.1:$port/api/v2/broker/sessions" \
  >"$root/agent-session-one.status" &
agent_one_pid=$!
curl -sS -o "$root/agent-session-two.json" -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$agent_session_body" \
  "http://127.0.0.1:$port/api/v2/broker/sessions" \
  >"$root/agent-session-two.status" &
agent_two_pid=$!
wait "$agent_one_pid"
wait "$agent_two_pid"
agent_statuses=$(cat "$root/agent-session-one.status" "$root/agent-session-two.status" | sort | tr '\n' ' ')
[[ "$agent_statuses" == "200 201 " ]]
agent_created=$(jq -r '.session.id // empty' "$root/agent-session-one.json" "$root/agent-session-two.json" | head -1)
[[ -n "$agent_created" ]]
[[ $(jq -cs '[.[].duplicate] | sort' "$root/agent-session-one.json" "$root/agent-session-two.json") == '[false,true]' ]]
wait_session_count 4
[[ $(grep -c "^$agent_created$" "$root/launch-invocations") == 1 ]]
[[ $(cat "$state/sessions/$agent_created/workspace") == "$root/agent-project" ]]
[[ $(cat "$state/sessions/$agent_created/harness") == opencode ]]
[[ $(curl -fsS -H "x-piss-session-token: $first_token" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces" | \
  jq --arg id "$agent_workspace" 'any(.[]; .id==$id and .root=="'"$root/agent-project"'" and (.containsCaller|not))') == true ]]
[[ $(curl -fsS -H "x-piss-session-token: $first_token" \
  "http://127.0.0.1:$port/api/v2/broker/sessions" | \
  jq --arg id "$agent_created" --arg root "$root/agent-project" --arg workspace "$agent_workspace" \
    'any(.[]; .id==$id and .workspaceId==$workspace and .workspaceName=="agent-project" and .workspaceRoot==$root and .createdByCaller==true and .cleanupRecommended==false)') == true ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg workspace "$agent_workspace" '{workspaceId:$workspace}')" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces/delete") == 409 ]]
[[ $(curl -fsS -H "x-piss-session-token: $first_token" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces" | \
  jq --arg id "$agent_workspace" 'any(.[]; .id==$id)') == true ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg workspace "$agent_workspace" \
    '{requestId:"over-limit-agent",workspaceId:$workspace,title:"Over limit",harness:"pi"}')" \
  "http://127.0.0.1:$port/api/v2/broker/sessions") == 409 ]]
agent_peer_body=$(jq -nc --arg target "$agent_created" \
  '{requestId:"agent-created-peer",targetSessionId:$target,prompt:"receive work in the agent-created workspace"}')
agent_peer_response=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$agent_peer_body" \
  "http://127.0.0.1:$port/api/v2/broker/ask")
[[ $(jq -r .response <<<"$agent_peer_response") == \
  "The worker retained ownership while the control plane was replaceable." ]]

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
waiting_body=$(jq -nc --arg target "$second" \
  '{requestId:"peer-waiting-status",targetSessionId:$target,prompt:"prove automatic waiting status reconciliation"}')
curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" --data "$waiting_body" \
  "http://127.0.0.1:$port/api/v2/broker/send" >/dev/null
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == waiting ]]
for _ in $(seq 1 600); do
  [[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == idle ]] && break
  sleep .02
done
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == idle ]]
[[ $(python3 - "$state/registry.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute("select state from peer_requests where id = 'peer-waiting-status'").fetchone()[0])
PY
) == completed ]]
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
  "piss_list_workspaces,piss_create_workspace,piss_delete_workspace,piss_create_session,piss_finish_session,piss_list_sessions,piss_ask_session,piss_send_session,piss_subscribe_responses,piss_collect_responses" ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_create_workspace")|.inputSchema.required|join(",")' <<<"$mcp_output") == "requestId,path" ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_delete_workspace")|.inputSchema.required|join(",")' <<<"$mcp_output") == "workspaceId" ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_create_session")|.inputSchema.required|join(",")' <<<"$mcp_output") == "requestId,workspaceId,title" ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_create_session")|.description' <<<"$mcp_output") == *piss_finish_session* ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_finish_session")|.inputSchema.required|join(",")' <<<"$mcp_output") == "targetSessionId" ]]
[[ $(jq -r 'select(.id==2)|.result.tools[]|select(.name=="piss_finish_session")|.description' <<<"$mcp_output") == *"does not hard-delete"* ]]
first_async=$(jq -r 'select(.id==3)|.result.content[0].text|fromjson|.requestId' <<<"$mcp_output")
second_async=$(jq -r 'select(.id==4)|.result.content[0].text|fromjson|.requestId' <<<"$mcp_output")
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == waiting ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions" | jq -r --arg id "$first" '.[]|select(.id==$id)|.status') == waiting ]]
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
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == idle ]]
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
agent_worker=$(cat "$root/supervisors/$agent_created.child")
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
"$root/stop" "$second"
python3 - "$state/registry.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    connection.execute("update peer_requests set state = 'dispatching' where id = 'wake-control-first'")
PY
sleep .5
[[ $(python3 - "$state/registry.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute("select state from peer_requests where id = 'wake-control-first'").fetchone()[0])
PY
) == dispatching ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$first" | jq -r .status) == waiting ]]
old_control=$control_pid
kill -9 "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
printf '0.2\n' >"$root/launch-delay"
: >"$root/launch-events"
start_control
rm -f "$root/launch-delay"
[[ "$control_pid" != "$old_control" ]]
[[ $(head -4 "$root/launch-events" | grep -c '^start ') == 4 ]]
[[ $(grep -c '^finish ' "$root/launch-events") == 4 ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces" | jq --arg id configured-empty 'any(.[]; .id==$id)') == false ]]
second_replacement=$(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$second" | jq -r .workerPid)
[[ "$second_replacement" != "$second_worker" ]]
second_worker=$second_replacement
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$third" | jq -r .workerPid) == "$third_worker" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$agent_created" | jq -r .workerPid) == "$agent_worker" ]]
[[ $(grep -c "^$agent_created$" "$root/launch-invocations") == 2 ]]
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
[[ "$wake_prompt" == *'peer session ended as ambiguous'* ]]
[[ $(grep -o 'The worker retained ownership while the control plane was replaceable.' <<<"$wake_prompt" | wc -l) == 1 ]]
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

# The externally-created session remained the same normal worker across the
# control-plane replacement. Its creator is encouraged to clean it up only after
# terminal work is durably collected; pending work and foreign creators fail
# closed, and finishing archives rather than hard-deleting history.
[[ $(curl -fsS -H "x-piss-session-token: $first_token" \
  "http://127.0.0.1:$port/api/v2/broker/sessions" | \
  jq -r --arg id "$agent_created" '.[]|select(.id==$id)|.cleanupRecommended') == true ]]
cleanup_peer=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" \
    '{requestId:"cleanup-safety-peer",targetSessionId:$target,prompt:"complete before creator cleanup"}')" \
  "http://127.0.0.1:$port/api/v2/broker/send")
cleanup_request=$(jq -r .requestId <<<"$cleanup_peer")
[[ $(jq -r .cleanupAfterCollection <<<"$cleanup_peer") == true ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" '{targetSessionId:$target}')" \
  "http://127.0.0.1:$port/api/v2/broker/finish") == 409 ]]
second_token=$(tr -d '\n' <"$state/sessions/$second/broker-token")
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $second_token" \
  --data "$(jq -nc --arg target "$agent_created" '{targetSessionId:$target}')" \
  "http://127.0.0.1:$port/api/v2/broker/finish") == 403 ]]
cleanup_collection=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg request "$cleanup_request" \
    '{requestIds:[$request],waitFor:"all",timeoutSeconds:10}')" \
  "http://127.0.0.1:$port/api/v2/broker/collect")
[[ $(jq '.pendingRequestIds|length' <<<"$cleanup_collection") == 0 ]]
[[ $(jq -r '.cleanupRecommendedSessionIds[0]' <<<"$cleanup_collection") == "$agent_created" ]]
blocked_mutation_body=$(targeted_for "$agent_created" \
  '{"commandId":"mutation-during-finish","text":"run only after failed finish releases the session lock"}')
independent_mutation_body=$(targeted_for "$second" \
  '{"commandId":"independent-during-finish","text":"prove another session remains concurrent"}')
echo 4 >"$root/stop-delay"
touch "$root/force-stop-failure"
curl -sS -o "$root/blocked-finish.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" '{targetSessionId:$target}')" \
  "http://127.0.0.1:$port/api/v2/broker/finish" \
  >"$root/blocked-finish.status" &
blocked_finish_pid=$!
for _ in $(seq 1 100); do
  [[ -f "$root/stop-started" ]] && break
  sleep .02
done
[[ $(cat "$root/stop-started") == "$agent_created" ]]
curl -sS -o "$root/blocked-mutation.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data "$blocked_mutation_body" \
  "http://127.0.0.1:$port/api/v2/commands?session=$agent_created" \
  >"$root/blocked-mutation.status" &
blocked_mutation_pid=$!
sleep .1
kill -0 "$blocked_mutation_pid"
independent_started=$(date +%s%3N)
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data "$independent_mutation_body" \
  "http://127.0.0.1:$port/api/v2/commands?session=$second") == 202 ]]
independent_elapsed=$(( $(date +%s%3N) - independent_started ))
[[ "$independent_elapsed" -lt 2000 ]]
[[ $(python3 - "$state/registry.sqlite3" "$agent_created" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute(
        "select finishing_at is not null from sessions where id = ?", (sys.argv[2],)
    ).fetchone()[0])
PY
) == 1 ]]
sleep 3
[[ $(python3 - "$state/registry.sqlite3" "$agent_created" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    print(connection.execute(
        "select finishing_at is not null from sessions where id = ?", (sys.argv[2],)
    ).fetchone()[0])
PY
) == 1 ]]
wait "$blocked_finish_pid"
wait "$blocked_mutation_pid"
[[ $(cat "$root/blocked-finish.status") == 409 ]]
[[ $(cat "$root/blocked-mutation.status") == 202 ]]
rm -f "$root/stop-delay" "$root/stop-started"
for _ in $(seq 1 600); do
  [[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$agent_created" | jq -r .status) == idle ]] && break
  sleep .02
done
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session?session=$agent_created" | jq -r .status) == idle ]]
[[ $(curl -fsS -H "x-piss-session-token: $first_token" \
  "http://127.0.0.1:$port/api/v2/broker/sessions" | \
  jq --arg id "$agent_created" 'any(.[]; .id==$id)') == true ]]
finish_response=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" '{targetSessionId:$target}')" \
  "http://127.0.0.1:$port/api/v2/broker/finish")
[[ $(jq -r .state <<<"$finish_response") == archived ]]
[[ $(jq -r .duplicate <<<"$finish_response") == false ]]
[[ $(jq -r .hardDeleted <<<"$finish_response") == false ]]
finish_duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" '{targetSessionId:$target}')" \
  "http://127.0.0.1:$port/api/v2/broker/finish")
[[ $(jq -r .duplicate <<<"$finish_duplicate") == true ]]
archived_peer_retry=$(curl -fsS -X POST -H 'content-type: application/json' \
  -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" \
    '{requestId:"cleanup-safety-peer",targetSessionId:$target,prompt:"complete before creator cleanup"}')" \
  "http://127.0.0.1:$port/api/v2/broker/send")
[[ $(jq -r .duplicate <<<"$archived_peer_retry") == true ]]
[[ $(jq -r .requestId <<<"$archived_peer_retry") == cleanup-safety-peer ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg target "$agent_created" \
    '{requestId:"cleanup-safety-peer",targetSessionId:$target,prompt:"different archived retry"}')" \
  "http://127.0.0.1:$port/api/v2/broker/send") == 409 ]]
finish_mcp_input=$(jq -nc --arg target "$agent_created" '[
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"piss_finish_session",arguments:{targetSessionId:$target}}}
] | .[]')
finish_mcp_output=$(printf '%s\n' "$finish_mcp_input" | env \
  PISS_BROKER_URL="http://127.0.0.1:$port" \
  PISS_SESSION_TOKEN="$first_token" PISS_CURL="$(command -v curl)" \
  "$session_mcp_exe")
[[ $(jq -r 'select(.id==2)|.result.content[0].text|fromjson|.state' <<<"$finish_mcp_output") == archived ]]
[[ $(jq -r 'select(.id==2)|.result.content[0].text|fromjson|.duplicate' <<<"$finish_mcp_output") == true ]]
wait_session_count 3
mv "$root/agent-project" "$root/agent-project-real"
ln -s /tmp "$root/agent-project"
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/$agent_created/restore") == 409 ]]
rm "$root/agent-project"
mv "$root/agent-project-real" "$root/agent-project"
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(jq -cn --arg failed "$failed_agent_id" --arg created "$agent_created" \
    '{ids:[$failed,$created]}')" \
  "http://127.0.0.1:$port/api/v2/sessions/delete-archived" >/dev/null
touch "$root/agent-project/retained-after-unregister"
delete_workspace_input=$(jq -nc --arg workspace "$agent_workspace" '[
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"piss_delete_workspace",arguments:{workspaceId:$workspace}}},
  {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"piss_delete_workspace",arguments:{workspaceId:$workspace}}}
] | .[]')
delete_workspace_output=$(printf '%s\n' "$delete_workspace_input" | env \
  PISS_BROKER_URL="http://127.0.0.1:$port" \
  PISS_SESSION_TOKEN="$first_token" PISS_CURL="$(command -v curl)" \
  "$session_mcp_exe")
[[ $(jq -r 'select(.id==2)|.result.content[0].text|fromjson|.removed' <<<"$delete_workspace_output") == true ]]
[[ $(jq -r 'select(.id==2)|.result.content[0].text|fromjson|.duplicate' <<<"$delete_workspace_output") == false ]]
[[ $(jq -r 'select(.id==2)|.result.content[0].text|fromjson|.id' <<<"$delete_workspace_output") == "$agent_workspace" ]]
[[ $(jq -r 'select(.id==3)|.result.content[0].text|fromjson|.removed' <<<"$delete_workspace_output") == false ]]
[[ $(jq -r 'select(.id==3)|.result.content[0].text|fromjson|.duplicate' <<<"$delete_workspace_output") == true ]]
[[ -f "$root/agent-project/retained-after-unregister" ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces" | \
  jq --arg id "$agent_workspace" 'any(.[]; .id==$id)') == false ]]

curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/$first/archive" >/dev/null
wait_session_count 2
mkdir -p "$root/stale-source-project"
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "x-piss-session-token: $first_token" \
  --data "$(jq -nc --arg path "$root/stale-source-project" \
    '{requestId:"stale-source-workspace",path:$path}')" \
  "http://127.0.0.1:$port/api/v2/broker/workspaces") == 401 ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/workspaces" | \
  jq --arg root "$root/stale-source-project" 'any(.[]; .root==$root)') == false ]]
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
selected_deleted=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(jq -cn --arg first "$first" --arg second "$second" '{ids: [$first, $second]}')" \
  "http://127.0.0.1:$port/api/v2/sessions/delete-archived")
[[ $(jq -r '.deleted' <<<"$selected_deleted") == 2 ]]
remaining=$(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true")
[[ $(jq 'length' <<<"$remaining") == 1 ]]
[[ $(jq -r '.[0].id' <<<"$remaining") == "$third" ]]
[[ ! -e "$state/sessions/$first" ]]
[[ ! -e "$state/sessions/$second" ]]
[[ -e "$state/sessions/$third" ]]
deleted=$(curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/sessions/delete-archived")
[[ $(jq -r '.deleted' <<<"$deleted") == 1 ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/sessions?archived=true" | jq 'length') == 0 ]]
[[ ! -e "$state/sessions/$third" ]]

printf 'session isolation proof passed: first=%s replacement=%s restored=%s second=%s third=%s fanout_ms=%s control=%s->%s final_archive=preserved selected_deleted=2 deleted=1\n' \
  "$first_worker" "$replacement" "$restored_worker" "$second_worker" "$third" "$fanout_elapsed" "$old_control" "$control_pid"
