#!/usr/bin/env bash
set -euo pipefail

worker_exe=${1:?worker executable is required}
agent_exe=${2:?mock agent executable is required}
control_exe=${3:?control executable is required}
public_dir=${4:?public directory is required}
app_js=${5:?browser bundle is required}
workspace=${6:?workspace is required}
port=${PISS_TEST_PORT:-$((35000 + ($$ % 20000)))}
state=$(mktemp -d)
socket="$state/worker.sock"
database="$state/worker.sqlite3"
worker_log="$state/worker.log"
control_log="$state/control.log"
worker_pid=
control_pid=
harness_pid=

cleanup() {
  if [[ -n "$control_pid" ]]; then kill "$control_pid" 2>/dev/null || true; fi
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$control_pid" ]]; then wait "$control_pid" 2>/dev/null || true; fi
  if [[ -n "$worker_pid" ]]; then wait "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$state"
}
trap cleanup EXIT

wait_for_worker() {
  for _ in $(seq 1 200); do
    [[ -S "$socket" ]] && return 0
    sleep 0.025
  done
  cat "$worker_log" >&2
  return 1
}

wait_for_control() {
  for _ in $(seq 1 200); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0
    sleep 0.025
  done
  cat "$control_log" >&2
  return 1
}

start_control() {
  local generation=$1
  "$control_exe" --port "$port" --worker-socket "$socket" \
    --public "$public_dir" --app-js "$app_js" --generation "$generation" \
    --dev-bypass-auth \
    >"$control_log" 2>&1 &
  control_pid=$!
  wait_for_control
}

PISS_MOCK_DURATION=4 "$worker_exe" \
  --socket "$socket" \
  --database "$database" \
  --session replaceability-session \
  --worker replaceability-worker \
  --workspace "$workspace" \
  --harness "$agent_exe" \
  >"$worker_log" 2>&1 &
worker_pid=$!
wait_for_worker
start_control generation-one

snapshot_before=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
reported_worker_pid=$(jq -r .workerPid <<<"$snapshot_before")
harness_pid=$(jq -r .harnessPid <<<"$snapshot_before")
[[ "$reported_worker_pid" == "$worker_pid" ]]
kill -0 "$harness_pid"

first_delivery=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"replaceability-command","text":"prove replacement"}' \
  "http://127.0.0.1:$port/api/v2/commands")
[[ $(jq -r .duplicate <<<"$first_delivery") == false ]]
[[ $(jq -r .state <<<"$first_delivery") == dispatched ]]

sleep 1
kill -9 "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
kill -0 "$worker_pid"
kill -0 "$harness_pid"

start_control generation-two
sleep 4

health_after=$(curl -fsS "http://127.0.0.1:$port/health")
[[ $(jq -r .generation <<<"$health_after") == generation-two ]]
snapshot_after=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
[[ $(jq -r .workerPid <<<"$snapshot_after") == "$worker_pid" ]]
[[ $(jq -r .harnessPid <<<"$snapshot_after") == "$harness_pid" ]]
[[ $(jq -r .status <<<"$snapshot_after") == idle ]]

events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.accepted")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.tool_call_update")] | length' <<<"$events") -ge 4 ]]
[[ $(jq '[.[] | select(.kind == "acp.agent_message_chunk")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.state == "completed")] | length' <<<"$events") == 1 ]]

duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"replaceability-command","text":"must not run twice"}' \
  "http://127.0.0.1:$port/api/v2/commands")
[[ $(jq -r .duplicate <<<"$duplicate") == true ]]
[[ $(jq -r .state <<<"$duplicate") == completed ]]

events_after_duplicate=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.accepted")] | length' <<<"$events_after_duplicate") == 1 ]]

echo "replaceability proof passed: control plane replaced; worker=$worker_pid harness=$harness_pid"
