#!/usr/bin/env bash
set -euo pipefail

worker_exe=${1:?worker executable is required}
harness_exe=${2:?harness executable is required}
control_exe=${3:?control executable is required}
public_dir=${4:?public directory is required}
app_js=${5:?browser bundle is required}
session_mcp=${6:?session MCP executable is required}
workspace=${7:?workspace is required}
shift 7

port=${PISS_TEST_PORT:-$((48000 + ($$ % 1000)))}
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

harness_args=()
for argument in "$@"; do
  harness_args+=(--harness-arg "$argument")
done

"$worker_exe" \
  --socket "$state/worker.sock" \
  --database "$state/worker.sqlite3" \
  --session real-harness-smoke \
  --worker real-harness-worker \
  --generation real-harness-generation \
  --workspace "$workspace" \
  --harness "$harness_exe" \
  --session-mcp "$session_mcp" \
  --broker-url "http://127.0.0.1:$port" \
  --broker-token smoke-token \
  --curl-command "$(command -v curl)" \
  "${harness_args[@]}" \
  >"$state/worker.log" 2>&1 &
worker_pid=$!

for _ in $(seq 1 1500); do
  [[ -S "$state/worker.sock" ]] && break
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    cat "$state/worker.log" >&2
    exit 1
  fi
  sleep .02
done
[[ -S "$state/worker.sock" ]] || { cat "$state/worker.log" >&2; exit 1; }

"$control_exe" \
  --port "$port" \
  --worker-socket "$state/worker.sock" \
  --public "$public_dir" \
  --app-js "$app_js" \
  --generation real-harness-smoke \
  --dev-bypass-auth \
  >"$state/control.log" 2>&1 &
control_pid=$!

for _ in $(seq 1 500); do
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
  if ! kill -0 "$control_pid" 2>/dev/null; then
    cat "$state/control.log" >&2
    exit 1
  fi
  sleep .02
done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null
runtime_target=$(curl -fsS "http://127.0.0.1:$port/api/v2/session" | \
  jq -c '{sessionId,workerId,runtimeGeneration}')

curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(jq -nc --argjson target "$runtime_target" '{target:$target,commandId:"real-harness-command",text:"Reply with exactly PISS_REAL_HARNESS_OK and no other text. Do not use tools."}')" \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null

terminal_state=
for _ in $(seq 1 1800); do
  events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  terminal_state=$(jq -r '[.[] | select(.kind == "command.state" and .payload.commandId == "real-harness-command")][-1].payload.state // empty' <<<"$events")
  [[ "$terminal_state" == "completed" || "$terminal_state" == "failed" || "$terminal_state" == "cancelled" ]] && break
  sleep .1
done

if [[ "$terminal_state" != "completed" ]]; then
  cat "$state/worker.log" >&2
  jq . <<<"$events" >&2
  exit 1
fi

response=$(jq -r '[.[] | select(.kind == "acp.agent_message_chunk") | .payload.params.update.content.text // ""] | join("")' <<<"$events")
[[ "$response" == *PISS_REAL_HARNESS_OK* ]] || {
  printf 'unexpected harness response: %s\n' "$response" >&2
  exit 1
}

agent=$(curl -fsS "http://127.0.0.1:$port/api/v2/session" | jq -r .agentName)
printf 'real harness smoke passed: %s returned %s\n' "$agent" "$response"
