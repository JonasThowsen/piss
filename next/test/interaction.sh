#!/usr/bin/env bash
set -euo pipefail

worker_exe=${1:?worker executable is required}
agent_exe=${2:?mock agent executable is required}
control_exe=${3:?control executable is required}
public_dir=${4:?public directory is required}
app_js=${5:?browser bundle is required}
workspace=${6:?workspace is required}
port=${PISS_TEST_PORT:-$((40000 + ($$ % 15000)))}
state=$(mktemp -d)
worker_pid=
control_pid=

cleanup() {
  [[ -z "$control_pid" ]] || kill "$control_pid" 2>/dev/null || true
  [[ -z "$worker_pid" ]] || kill "$worker_pid" 2>/dev/null || true
  [[ -z "$control_pid" ]] || wait "$control_pid" 2>/dev/null || true
  [[ -z "$worker_pid" ]] || wait "$worker_pid" 2>/dev/null || true
  rm -rf "$state"
}
trap cleanup EXIT

PISS_MOCK_DURATION=2 "$worker_exe" \
  --socket "$state/worker.sock" --database "$state/worker.sqlite3" \
  --session interaction-session --worker interaction-worker \
  --workspace "$workspace" --harness "$agent_exe" \
  >"$state/worker.log" 2>&1 &
worker_pid=$!

for _ in $(seq 1 300); do
  [[ -S "$state/worker.sock" ]] && break
  kill -0 "$worker_pid" 2>/dev/null || { cat "$state/worker.log" >&2; exit 1; }
  sleep .02
done

"$control_exe" --port "$port" --worker-socket "$state/worker.sock" \
  --public "$public_dir" --app-js "$app_js" --generation interaction-test \
  --dev-bypass-auth >"$state/control.log" 2>&1 &
control_pid=$!
for _ in $(seq 1 300); do
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
  sleep .02
done

curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"permission-command","text":"permission: test the decision path"}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null

request_id=
for _ in $(seq 1 300); do
  events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  request_id=$(jq -r '[.[] | select(.kind == "acp.permission.requested")][-1].payload.id // empty' <<<"$events")
  [[ -n "$request_id" ]] && break
  sleep .02
done
[[ -n "$request_id" ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data "{\"requestId\":\"$request_id\",\"optionId\":\"not-offered\"}" \
  "http://127.0.0.1:$port/api/v2/permissions") == 409 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"requestId\":\"$request_id\",\"optionId\":\"allow-once\"}" \
  "http://127.0.0.1:$port/api/v2/permissions" >/dev/null
sleep 3
events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "acp.permission.resolved")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "permission-command" and .payload.state == "completed")] | length' <<<"$events") == 1 ]]

curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"cancel-command","text":"cancel this prompt"}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
sleep .2
curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/cancel" >/dev/null
sleep 2
events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.cancel.requested")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "cancel-command" and .payload.state == "cancelled")] | length' <<<"$events") == 1 ]]

echo "interaction proof passed: permission resolved and prompt cancelled"
