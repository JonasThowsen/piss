#!/usr/bin/env bash
set -euo pipefail

worker_exe=${1:?worker executable is required}
agent_exe=${2:?mock agent executable is required}
control_exe=${3:?control executable is required}
public_dir=${4:?public directory is required}
app_js=${5:?browser bundle is required}
workspace=${6:?workspace is required}
port=${PISS_TEST_PORT:-$((32000 + ($$ % 8000)))}
state=$(mktemp -d)
socket="$state/worker.sock"
database="$state/worker.sqlite3"
worker_log="$state/worker.log"
control_log="$state/control.log"
worker_pid=
control_pid=
harness_pid=
stream_pid=

cleanup() {
  if [[ -n "$stream_pid" ]]; then kill "$stream_pid" 2>/dev/null || true; fi
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
  --generation worker-generation-one \
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
initial_cursor=$(jq -r .lastSequence <<<"$snapshot_before")
old_target=$(jq -c '{sessionId,workerId,runtimeGeneration}' <<<"$snapshot_before")
curl -NsS --max-time 10 \
  "http://127.0.0.1:$port/api/v2/event-stream?after=$initial_cursor" \
  >"$state/generation-one.stream" 2>/dev/null &
stream_pid=$!

command_body=$(jq -nc --argjson target "$old_target" \
  '{target:$target,commandId:"replaceability-command",text:"prove replacement"}')
# Send a complete authenticated HTTP request, then deliberately discard its
# response. The durable acceptance is observed through the event ledger before
# retrying the exact same command identity.
python3 - "$port" "$command_body" <<'PY'
import socket, sys, time
port, body = int(sys.argv[1]), sys.argv[2].encode()
request = (b"POST /api/v2/commands HTTP/1.1\r\nHost: 127.0.0.1\r\n"
           b"Content-Type: application/json\r\nContent-Length: "
           + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
connection = socket.create_connection(("127.0.0.1", port))
connection.sendall(request)
time.sleep(.2)
connection.close()
PY
for _ in $(seq 1 100); do
  accepted=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "replaceability-command")] | length' <<<"$accepted") == 1 ]] && break
  sleep .02
done
# Concurrent response-loss retries reuse the same identity. Both must observe
# the one durable command rather than dispatching another ACP prompt.
curl -fsS -X POST -H 'content-type: application/json' --data "$command_body" \
  "http://127.0.0.1:$port/api/v2/commands" >"$state/retry-one.json" &
retry_one=$!
curl -fsS -X POST -H 'content-type: application/json' --data "$command_body" \
  "http://127.0.0.1:$port/api/v2/commands" >"$state/retry-two.json" &
retry_two=$!
wait "$retry_one" "$retry_two"
[[ $(jq -r .duplicate "$state/retry-one.json") == true ]]
[[ $(jq -r .duplicate "$state/retry-two.json") == true ]]

sleep 1
kill -9 "$control_pid"
wait "$control_pid" 2>/dev/null || true
control_pid=
wait "$stream_pid" 2>/dev/null || true
stream_pid=
kill -0 "$worker_pid"
kill -0 "$harness_pid"
first_stream_cursor=$(awk '/^id: / { value=$2 } END { print value+0 }' \
  "$state/generation-one.stream")
[[ "$first_stream_cursor" -gt "$initial_cursor" ]]

start_control generation-two
curl -NsS --max-time 10 -H "Last-Event-ID: $first_stream_cursor" \
  "http://127.0.0.1:$port/api/v2/event-stream?after=0" \
  >"$state/generation-two.stream" 2>/dev/null &
stream_pid=$!
sleep 4

health_after=$(curl -fsS "http://127.0.0.1:$port/health")
[[ $(jq -r .generation <<<"$health_after") == generation-two ]]
snapshot_after=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
[[ $(jq -r .workerPid <<<"$snapshot_after") == "$worker_pid" ]]
[[ $(jq -r .harnessPid <<<"$snapshot_after") == "$harness_pid" ]]
[[ $(jq -r .status <<<"$snapshot_after") == idle ]]

events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "replaceability-command")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.user_message_chunk" and .payload.params.update.content.text == "prove replacement")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.tool_call_update")] | length' <<<"$events") -ge 4 ]]
[[ $(jq '[.[] | select(.kind == "acp.agent_message_chunk")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "replaceability-command" and .payload.state == "completed")] | length' <<<"$events") == 1 ]]
for _ in $(seq 1 100); do
  grep -q '"state":"completed"' "$state/generation-two.stream" 2>/dev/null && break
  sleep .02
done
grep -q '"state":"completed"' "$state/generation-two.stream"
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
stream_pid=
python3 - "$state/generation-two.stream" "$first_stream_cursor" <<'PY'
import sys
path, cursor = sys.argv[1], int(sys.argv[2])
ids = [int(line.split(':', 1)[1]) for line in open(path) if line.startswith('id: ')]
assert ids and ids == sorted(set(ids)) and min(ids) > cursor, ids
PY

# Race two first submissions of one fresh prompt. They cross independent HTTP
# and worker connections, but only one may accept and write to the ACP harness.
concurrent_body=$(jq -nc --argjson target "$old_target" \
  '{target:$target,commandId:"concurrent-command",text:"dispatch concurrently once"}')
concurrent_results=$(python3 - "$port" "$concurrent_body" <<'PY'
import json, threading, urllib.request, sys
port, body = int(sys.argv[1]), sys.argv[2].encode()
barrier = threading.Barrier(3)
results = []
def submit():
    barrier.wait()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v2/commands", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        results.append(json.load(response))
threads = [threading.Thread(target=submit) for _ in range(2)]
for thread in threads: thread.start()
barrier.wait()
for thread in threads: thread.join()
print(json.dumps(results, separators=(",", ":")))
PY
)
[[ $(jq -c '[.[].duplicate] | sort' <<<"$concurrent_results") == '[false,true]' ]]
for _ in $(seq 1 300); do
  concurrent_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "concurrent-command" and .payload.state == "completed")] | length' <<<"$concurrent_events") == 1 ]] && break
  sleep .02
done
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "concurrent-command")] | length' <<<"$concurrent_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.user_message_chunk" and .payload.params.update.content.text == "dispatch concurrently once")] | length' <<<"$concurrent_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "concurrent-command" and .payload.state == "completed")] | length' <<<"$concurrent_events") == 1 ]]

duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data "$command_body" \
  "http://127.0.0.1:$port/api/v2/commands")
[[ $(jq -r .duplicate <<<"$duplicate") == true ]]
[[ $(jq -r .state <<<"$duplicate") == completed ]]

# Protocol-v1 control and upgrade helpers can still observe and prepare a v2
# worker during a rollback window. Mutations remain decoded by the current
# worker and therefore retain their v2 fencing semantics.
legacy_snapshot=$(python3 - "$socket" <<'PY'
import json, socket, sys
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
stream = connection.makefile("rwb", buffering=0)
def exchange(value):
    stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    envelope = json.loads(stream.readline())
    assert envelope["ok"], envelope
    return envelope["result"]
hello = exchange({"op":"hello","protocolVersion":1})
assert hello["protocolVersion"] == 1, hello
print(json.dumps(exchange({"op":"snapshot"}), separators=(",", ":")))
PY
)
[[ $(jq -r .workerPid <<<"$legacy_snapshot") == "$worker_pid" ]]

legacy_config=$(python3 - "$socket" <<'PY'
import json, socket, sys
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
stream = connection.makefile("rwb", buffering=0)
def exchange(value):
    stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    envelope = json.loads(stream.readline())
    assert envelope["ok"], envelope
    return envelope["result"]
exchange({"op":"hello","protocolVersion":1})
print(json.dumps(exchange({"op":"set_config_option","configId":"thought_level","value":"low"}), separators=(",", ":")))
PY
)
[[ $(jq -r '.configOptions[]|select(.category=="thought_level")|.currentValue' <<<"$legacy_config") == low ]]

events_after_duplicate=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "replaceability-command")] | length' <<<"$events_after_duplicate") == 1 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(jq -nc --argjson target "$old_target" '{target:$target,mutationId:"config-model",configId:"model",value:"mock/deep"}')" \
  "http://127.0.0.1:$port/api/v2/config-options" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(jq -nc --argjson target "$old_target" '{target:$target,mutationId:"config-thought",configId:"thought_level",value:"high"}')" \
  "http://127.0.0.1:$port/api/v2/config-options" >/dev/null

prepared=$(python3 - "$socket" <<'PY'
import json, socket, sys
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(sys.argv[1])
stream = connection.makefile("rwb", buffering=0)
def exchange(value):
    stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    envelope = json.loads(stream.readline())
    assert envelope["ok"], envelope
    return envelope["result"]
exchange({"op":"hello","protocolVersion":2})
print(json.dumps(exchange({"op":"prepare_upgrade","generation":"worker-generation-two"})))
PY
)
[[ $(jq -r .ready <<<"$prepared") == true ]]
old_worker_pid=$worker_pid
kill "$worker_pid" "$harness_pid" 2>/dev/null || true
wait "$worker_pid" 2>/dev/null || true
worker_pid=
rm -f "$socket"
PISS_MOCK_DURATION=4 "$worker_exe" \
  --socket "$socket" \
  --database "$database" \
  --session replaceability-session \
  --worker replaceability-worker \
  --generation worker-generation-two \
  --workspace "$workspace" \
  --harness "$agent_exe" \
  >"$worker_log" 2>&1 &
worker_pid=$!
wait_for_worker
replacement_snapshot=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
[[ $(jq -r .workerPid <<<"$replacement_snapshot") != "$old_worker_pid" ]]
[[ $(jq -r .workerGeneration <<<"$replacement_snapshot") == worker-generation-two ]]
[[ $(jq -r .status <<<"$replacement_snapshot") == idle ]]
[[ $(jq -r .runtimeGeneration <<<"$replacement_snapshot") -gt $(jq -r .runtimeGeneration <<<"$snapshot_before") ]]
[[ $(jq -r .workerId <<<"$replacement_snapshot") != $(jq -r .workerId <<<"$snapshot_before") ]]
# A response-loss retry is a durable receipt lookup, so the original command ID
# remains recoverable even though its captured runtime target is now stale.
post_replacement_duplicate=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data "$command_body" "http://127.0.0.1:$port/api/v2/commands")
[[ $(jq -r .duplicate <<<"$post_replacement_duplicate") == true ]]
[[ $(jq -r .state <<<"$post_replacement_duplicate") == completed ]]
stale_body=$(jq -nc --argjson target "$old_target" \
  '{target:$target,commandId:"stale-runtime-command",text:"must be fenced"}')
[[ $(curl -sS -o "$state/stale.json" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data "$stale_body" \
  "http://127.0.0.1:$port/api/v2/commands") == 409 ]]
[[ $(jq -r .errorDetails.kind "$state/stale.json") == Conflict ]]
[[ $(jq -r .error "$state/stale.json") == stale\ runtime\ target:* ]]
stale_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "stale-runtime-command")] | length' <<<"$stale_events") == 0 ]]
[[ $(jq '[.[] | select(.kind == "acp.user_message_chunk" and .payload.params.update.content.text == "must be fenced")] | length' <<<"$stale_events") == 0 ]]
replacement_target=$(jq -c '{sessionId,workerId,runtimeGeneration}' <<<"$replacement_snapshot")
retargeted_body=$(jq -nc --argjson target "$replacement_target" \
  '{target:$target,commandId:"stale-runtime-command",text:"must be fenced"}')
retargeted=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data "$retargeted_body" "http://127.0.0.1:$port/api/v2/commands")
[[ $(jq -r .duplicate <<<"$retargeted") == false ]]
for _ in $(seq 1 300); do
  retargeted_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "stale-runtime-command" and .payload.state == "completed")] | length' <<<"$retargeted_events") == 1 ]] && break
  sleep .02
done
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "stale-runtime-command")] | length' <<<"$retargeted_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.user_message_chunk" and .payload.params.update.content.text == "must be fenced")] | length' <<<"$retargeted_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "stale-runtime-command" and .payload.state == "completed")] | length' <<<"$retargeted_events") == 1 ]]
[[ $(jq -r '.configOptions[]|select(.category=="model")|.currentValue' <<<"$replacement_snapshot") == mock/deep ]]
[[ $(jq -r '.configOptions[]|select(.category=="thought_level")|.currentValue' <<<"$replacement_snapshot") == high ]]
upgrade_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "worker.upgrade.prepared" and .payload.toGeneration == "worker-generation-two")] | length' <<<"$upgrade_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "worker.upgrade.completed" and .payload.fromGeneration == "worker-generation-one" and .payload.toGeneration == "worker-generation-two")] | length' <<<"$upgrade_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.config_option.restored" and .payload.configId == "model" and .payload.value == "mock/deep")] | length' <<<"$upgrade_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.config_option.restored" and .payload.configId == "thought_level" and .payload.value == "high")] | length' <<<"$upgrade_events") == 1 ]]

echo "replaceability proof passed: response-loss-safe/concurrent dedup, stale-runtime fencing and same-ID retarget, control replacement, protocol-v1 rollback reads, idle worker upgrade receipts, and restored ACP configuration"
