#!/usr/bin/env python3
"""Focused proof that MCP caller IDs reach the durable broker unchanged."""

import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import tempfile

MCP = pathlib.Path(sys.argv[1])

FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
body = None
for index, arg in enumerate(args):
    if arg == "--data-binary":
        body = json.loads(args[index + 1])
url = args[-1]
state_path = os.environ["PISS_MCP_CAPTURE"]
try:
    state = json.loads(open(state_path).read())
except (FileNotFoundError, json.JSONDecodeError):
    state = {"peers": {}, "subscriptions": {}}
status = 200
response = {}
if url.endswith("/api/v2/broker/send") or url.endswith("/api/v2/broker/ask"):
    request_id = body["requestId"]
    payload = [body["targetSessionId"], body["prompt"]]
    previous = state["peers"].get(request_id)
    if previous is not None and previous != payload:
        status, response = 409, {"error": "requestId was already used with different input"}
    else:
        duplicate = previous is not None
        state["peers"][request_id] = payload
        response = {"requestId": request_id, "duplicate": duplicate, "response": "answer"}
elif url.endswith("/api/v2/broker/subscribe"):
    subscription_id = body["subscriptionId"]
    payload = [sorted(body["requestIds"]), body.get("waitFor", "all")]
    previous = state["subscriptions"].get(subscription_id)
    if previous is not None and previous != payload:
        status, response = 409, {"error": "subscriptionId was already used with different input"}
    else:
        duplicate = previous is not None
        state["subscriptions"][subscription_id] = payload
        response = {"subscriptionId": subscription_id, "duplicate": duplicate}
else:
    response = []
open(state_path, "w").write(json.dumps(state))
sys.stdout.write(json.dumps(response) + "\n" + str(status))
'''


def rpc(process, ident, method, params=None):
    request = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        request["params"] = params
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    ready, _, _ = select.select([process.stdout], [], [], 5)
    if not ready:
        raise TimeoutError(f"MCP call {ident} ({method}) exceeded 5 seconds")
    line = process.stdout.readline()
    if not line:
        raise AssertionError(process.stderr.read())
    return json.loads(line)


def tool(process, ident, name, arguments):
    reply = rpc(process, ident, "tools/call", {"name": name, "arguments": arguments})
    return reply["result"]


def fail_after_timeout(_signum, _frame):
    raise TimeoutError("MCP stable-ID proof exceeded 30 seconds")


signal.signal(signal.SIGALRM, fail_after_timeout)
signal.alarm(30)

with tempfile.TemporaryDirectory(prefix="piss-mcp-ids-") as temporary:
    root = pathlib.Path(temporary)
    curl = root / "fake-curl"
    curl.write_text(f"#!{sys.executable}\n" + FAKE_CURL.split("\n", 1)[1])
    curl.chmod(0o700)
    capture = root / "capture.json"
    env = os.environ.copy()
    env.update({
        "PISS_BROKER_URL": "http://broker",
        "PISS_SESSION_TOKEN": "token",
        "PISS_CURL": str(curl),
        "PISS_MCP_CAPTURE": str(capture),
    })
    process = subprocess.Popen(
        [str(MCP)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, env=env,
    )
    completed = False
    try:
        listed = rpc(process, 1, "tools/list")["result"]["tools"]
        schemas = {entry["name"]: entry["inputSchema"] for entry in listed}
        assert "requestId" in schemas["piss_ask_session"]["properties"]
        assert "requestId" in schemas["piss_send_session"]["properties"]
        assert "subscriptionId" in schemas["piss_subscribe_responses"]["properties"]

        base = {"requestId": "stable-send", "targetSessionId": "s-target", "prompt": "work"}
        first = tool(process, 2, "piss_send_session", base)
        second = tool(process, 3, "piss_send_session", base)
        assert first["isError"] is False and second["isError"] is False
        assert json.loads(second["content"][0]["text"])["duplicate"] is True
        mismatch = tool(process, 4, "piss_send_session", {**base, "prompt": "different"})
        assert mismatch["isError"] is True

        asked = tool(process, 5, "piss_ask_session", {
            "requestId": "stable-ask", "targetSessionId": "s-target", "prompt": "question"
        })
        assert asked["isError"] is False and asked["content"][0]["text"] == "answer"

        subscription = {"subscriptionId": "stable-sub", "requestIds": ["stable-send"], "waitFor": "all"}
        assert tool(process, 6, "piss_subscribe_responses", subscription)["isError"] is False
        repeated = tool(process, 7, "piss_subscribe_responses", subscription)
        assert json.loads(repeated["content"][0]["text"])["duplicate"] is True
        mismatch = tool(process, 8, "piss_subscribe_responses", {**subscription, "waitFor": "any"})
        assert mismatch["isError"] is True

        state = json.loads(capture.read_text())
        assert state["peers"]["stable-send"] == ["s-target", "work"]
        assert state["peers"]["stable-ask"] == ["s-target", "question"]
        assert state["subscriptions"]["stable-sub"] == [["stable-send"], "all"]
        completed = True
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if completed and process.returncode != 0:
            raise AssertionError(process.stderr.read())

signal.alarm(0)
print("session MCP stable-ID proof passed")
