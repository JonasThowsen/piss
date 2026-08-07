#!/usr/bin/env bash
set -euo pipefail

worker_exe=${1:?worker executable is required}
agent_exe=${2:?mock agent executable is required}
control_exe=${3:?control executable is required}
public_dir=${4:?public directory is required}
app_js=${5:?browser bundle is required}
workspace=${6:?workspace is required}
port=${PISS_TEST_PORT:-$((40000 + ($$ % 8000)))}
state=$(mktemp -d)
worker_pid=
control_pid=
stream_pid=

cleanup() {
  [[ -z "$stream_pid" ]] || kill "$stream_pid" 2>/dev/null || true
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
  --generation interaction-generation \
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

curl -fsS -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$port/api/v2/session/new" >/dev/null
config_options=$(curl -fsS "http://127.0.0.1:$port/api/v2/config-options")
[[ $(jq -r '.[]|select(.category=="model")|.currentValue' <<<"$config_options") == mock/fast ]]
[[ $(jq -r '.[]|select(.category=="thought_level")|.currentValue' <<<"$config_options") == medium ]]
updated_config=$(curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"configId":"thought_level","value":"high"}' \
  "http://127.0.0.1:$port/api/v2/config-options")
[[ $(jq -r '.configOptions[]|select(.category=="thought_level")|.currentValue' <<<"$updated_config") == high ]]
snapshot=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
[[ $(jq -r '.configOptions[]|select(.category=="thought_level")|.currentValue' <<<"$snapshot") == high ]]
[[ $(jq -r '.acceptsImages' <<<"$snapshot") == true ]]
mentions=$(curl -fsS "http://127.0.0.1:$port/api/v2/file-mentions?query=App")
[[ $(jq -r '.[0].path' <<<"$mentions") == web-next/App.re ]]
[[ $(jq -r '.[0].kind' <<<"$mentions") == file ]]
long_query=$(python3 - <<'PY'
print('q' * 201)
PY
)
[[ $(curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:$port/api/v2/file-mentions?query=$long_query") == 400 ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"commandId":"escaping-resource","text":"inspect","resources":[{"path":"../outside.txt"}]}' \
  "http://127.0.0.1:$port/api/v2/commands") == 400 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"resource-command","text":"Inspect @web-next/App.re safely","resources":[{"path":"web-next/App.re"}]}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
for _ in $(seq 1 300); do
  resource_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "resource-command" and .payload.state == "completed")] | length' <<<"$resource_events") == 1 ]] && break
  sleep .02
done
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "resource-command" and .payload.resourceCount == 1 and .payload.resources[0].path == "web-next/App.re")] | length' <<<"$resource_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.user_message_chunk" and .payload.params.update.content.type == "resource_link" and .payload.params.update.content.name == "web-next/App.re" and (.payload.params.update.content.uri | startswith("file:///")))] | length' <<<"$resource_events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "acp.agent_message_chunk" and .payload.params.update.content.text == "Received typed resource link: web-next/App.re.")] | length' <<<"$resource_events") == 1 ]]
image_data=R0lGODlhAQABAAAAACw=
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"commandId":"bad-image","text":"","images":[{"mimeType":"image/svg+xml","data":"PHN2Zz4=","name":"unsafe.svg"}]}' \
  "http://127.0.0.1:$port/api/v2/commands") == 400 ]]
curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"commandId\":\"image-command\",\"text\":\"Inspect this pasted image\",\"images\":[{\"mimeType\":\"image/gif\",\"data\":\"$image_data\",\"name\":\"proof.gif\"}]}" \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
for _ in $(seq 1 300); do
  image_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "image-command" and .payload.state == "completed")] | length' <<<"$image_events") == 1 ]] && break
  sleep .02
done
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "image-command" and .payload.imageCount == 1 and .payload.images[0].mimeType == "image/gif" and .payload.images[0].size == 14)] | length' <<<"$image_events") == 1 ]]
[[ $(jq --arg data "$image_data" '[.[] | select(tostring | contains($data))] | length' <<<"$image_events") == 0 ]]
[[ $(jq '[.[] | select(.kind == "acp.agent_message_chunk" and .payload.params.update.content.text == "Received 1 image attachment.")] | length' <<<"$image_events") == 1 ]]
initial_events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "timeline.reset")] | length' <<<"$initial_events") == 1 ]]
initial_cursor=$(jq '[.[].sequence] | max // 0' <<<"$initial_events")
[[ $(curl -sS -o /dev/null -w '%{http_code}' -H 'Last-Event-ID: invalid' \
  "http://127.0.0.1:$port/api/v2/event-stream?after=$initial_cursor") == 400 ]]
curl -NsS --max-time 12 \
  "http://127.0.0.1:$port/api/v2/event-stream?after=$initial_cursor" \
  >"$state/permission.stream" 2>"$state/permission.stream.log" &
stream_pid=$!

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
[[ $(jq '[.[] | select(.kind == "acp.tool_call_update" and .payload.params.update.toolCallId == "tool-permission-command" and any(.payload.params.update.content[]?; .type == "diff") and any(.payload.params.update.content[]?; .type == "terminal") and any(.payload.params.update.content[]?; .content.type == "image") and any(.payload.params.update.content[]?; .content.type == "resource") and .payload.params.update.locations[0].path == "/workspace/mock-proof.txt")] | length' <<<"$events") == 1 ]]
for _ in $(seq 1 100); do
  grep -q '"commandId":"permission-command","state":"completed"' \
    "$state/permission.stream" 2>/dev/null && break
  sleep .02
done
grep -q '^retry: 1000$' "$state/permission.stream"
grep -q '"commandId":"permission-command","state":"completed"' \
  "$state/permission.stream"
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
stream_pid=
resume_cursor=$(awk '/^id: / { value=$2 } END { print value+0 }' \
  "$state/permission.stream")
python3 - "$state/permission.stream" "$initial_cursor" <<'PY'
import sys
path, initial = sys.argv[1], int(sys.argv[2])
ids = [int(line.split(':', 1)[1]) for line in open(path) if line.startswith('id: ')]
assert ids and ids == sorted(set(ids)) and min(ids) > initial, ids
PY

curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"delivery-base","text":"run while delivery messages arrive"}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
sleep .1
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"delivery-steer","text":"steer this active run","action":"steer"}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"commandId":"delivery-follow","text":"process this durable follow-up","action":"follow_up"}' \
  "http://127.0.0.1:$port/api/v2/commands" >/dev/null
for _ in $(seq 1 300); do
  events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "delivery-steer" and .payload.state == "completed")] | length' <<<"$events") == 1 ]] && break
  sleep .02
done
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session" | jq -r .status) == running ]]
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "delivery-steer" and .payload.action == "steer")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.accepted" and .payload.commandId == "delivery-follow" and .payload.action == "follow_up")] | length' <<<"$events") == 1 ]]
for _ in $(seq 1 400); do
  events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
  [[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "delivery-follow" and .payload.state == "completed")] | length' <<<"$events") == 1 ]] && break
  sleep .02
done
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "delivery-base" and .payload.state == "completed")] | length' <<<"$events") == 1 ]]
[[ $(jq '[.[] | select(.kind == "command.state" and .payload.commandId == "delivery-follow" and .payload.state == "completed")] | length' <<<"$events") == 1 ]]

curl -NsS --max-time 12 -H "Last-Event-ID: $resume_cursor" \
  "http://127.0.0.1:$port/api/v2/event-stream?after=0" \
  >"$state/cancel.stream" 2>"$state/cancel.stream.log" &
stream_pid=$!
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
for _ in $(seq 1 100); do
  grep -q '"commandId":"cancel-command","state":"cancelled"' \
    "$state/cancel.stream" 2>/dev/null && break
  sleep .02
done
grep -q '"commandId":"cancel-command","state":"cancelled"' \
  "$state/cancel.stream"
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
stream_pid=
python3 - "$state/cancel.stream" "$resume_cursor" <<'PY'
import sys
path, cursor = sys.argv[1], int(sys.argv[2])
ids = [int(line.split(':', 1)[1]) for line in open(path) if line.startswith('id: ')]
assert ids and ids == sorted(set(ids)) and min(ids) > cursor, ids
PY

snapshot=$(curl -fsS "http://127.0.0.1:$port/api/v2/session")
[[ $(jq -r .workerGeneration <<<"$snapshot") == interaction-generation ]]
prepared=$(python3 - "$state/worker.sock" <<'PY'
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
print(json.dumps(exchange({"op":"prepare_upgrade","generation":"interaction-next"})))
PY
)
[[ $(jq -r .ready <<<"$prepared") == true ]]
[[ $(curl -fsS "http://127.0.0.1:$port/api/v2/session" | jq -r .upgradePending) == true ]]
events=$(curl -fsS "http://127.0.0.1:$port/api/v2/events?after=0")
[[ $(jq '[.[] | select(.kind == "worker.upgrade.prepared" and .payload.fromGeneration == "interaction-generation" and .payload.toGeneration == "interaction-next")] | length' <<<"$events") == 1 ]]
[[ $(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"commandId":"upgrade-race","text":"must not enter a draining worker"}' \
  "http://127.0.0.1:$port/api/v2/commands") == 503 ]]

echo "interaction proof passed: bounded file mentions, typed resources, images, SSE, permissions, delivery, cancellation, and atomic idle-upgrade drain"
