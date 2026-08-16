#!/usr/bin/env python3
"""Authenticated end-to-end Codex conformance test for the Piss worker.

This is intentionally opt-in because it uses the caller's Codex account and
runs real model turns. The ordinary Nix check still tests the adapter without
credentials.
"""

from __future__ import annotations

import argparse
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any


PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmc"
    "AAAAASUVORK5CYII="
)


class BrokerHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/api/v2/broker/sessions":
            self.send_error(404)
            return
        body = json.dumps(
            [
                {
                    "id": "peer-codex-conformance",
                    "title": "CODEX_MCP_PEER",
                    "harness": "mock",
                    "self": False,
                }
            ]
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        pass


class Worker:
    def __init__(
        self, args: argparse.Namespace, root: Path, broker_url: str
    ) -> None:
        self.args = args
        self.root = root
        self.broker_url = broker_url
        self.socket_path = root / "worker.sock"
        self.database = root / "worker.sqlite3"
        self.workspace = root / "workspace"
        self.codex_home = root / "codex"
        self.process: subprocess.Popen[str] | None = None
        self.log_handle: Any = None
        self.target: dict[str, Any] = {}
        self.resolved_permissions: set[str] = set()

    def start(self, generation: str) -> None:
        self.stop()
        self.socket_path.unlink(missing_ok=True)
        env = {
            key: os.environ[key]
            for key in (
                "LANG",
                "LC_ALL",
                "NIX_SSL_CERT_FILE",
                "PATH",
                "SSL_CERT_FILE",
                "TZ",
            )
            if key in os.environ
        }
        env.update(
            {
                "CODEX_HOME": str(self.codex_home),
                "HOME": str(self.root),
                "NO_BROWSER": "1",
            }
        )
        log_path = self.root / f"worker-{generation}.log"
        self.log_handle = log_path.open("w", encoding="utf-8")
        self.process = subprocess.Popen(
            [
                self.args.worker,
                "--socket",
                str(self.socket_path),
                "--database",
                str(self.database),
                "--session",
                "codex-conformance",
                "--worker",
                "worker-codex-conformance",
                "--generation",
                generation,
                "--workspace",
                str(self.workspace),
                "--harness",
                self.args.codex_acp,
                "--session-mcp",
                self.args.session_mcp,
                "--broker-url",
                self.broker_url,
                "--broker-token",
                "conformance-token",
                "--curl-command",
                self.args.curl,
            ],
            env=env,
            stdout=self.log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if self.socket_path.exists():
                try:
                    snapshot = self.request({"op": "snapshot"})
                except (ConnectionError, OSError, TimeoutError):
                    time.sleep(0.05)
                    continue
                self.target = {
                    key: snapshot[key]
                    for key in ("sessionId", "workerId", "runtimeGeneration")
                }
                return
            if self.process.poll() is not None:
                raise RuntimeError(f"worker exited during startup; see {log_path}")
            time.sleep(0.05)
        raise TimeoutError(f"worker socket did not appear; see {log_path}")

    def stop(self) -> None:
        if self.process is not None:
            process_group = self.process.pid
            try:
                os.killpg(process_group, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=5)
            self.process = None
        if self.log_handle is not None:
            self.log_handle.close()
            self.log_handle = None

    def hello(self) -> dict[str, Any]:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(15)
            connection.connect(str(self.socket_path))
            stream = connection.makefile("rwb", buffering=0)
            stream.write(b'{"op":"hello","protocolVersion":2}\n')
            response = json.loads(stream.readline())
        if not response.get("ok"):
            raise AssertionError(response)
        return response["result"]

    def request_envelope(self, request: dict[str, Any]) -> dict[str, Any]:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(15)
            connection.connect(str(self.socket_path))
            stream = connection.makefile("rwb", buffering=0)
            stream.write(b'{"op":"hello","protocolVersion":2}\n')
            hello = json.loads(stream.readline())
            if not hello.get("ok"):
                raise AssertionError(hello)
            stream.write((json.dumps(request) + "\n").encode())
            response = json.loads(stream.readline())
        return response

    def request(self, request: dict[str, Any]) -> Any:
        response = self.request_envelope(request)
        if not response.get("ok"):
            raise AssertionError(response)
        return response["result"]

    def snapshot(self) -> dict[str, Any]:
        return self.request({"op": "snapshot"})

    def events(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        after = 0
        while True:
            page = self.request({"op": "events", "after": after, "limit": 500})
            events.extend(page)
            if len(page) < 500:
                return events
            after = max(int(event["sequence"]) for event in page)

    def event_sequence(self) -> int:
        return max((int(event["sequence"]) for event in self.events()), default=0)

    def wait_for_tool_call(
        self,
        *,
        after: int,
        input_fragment: str,
        timeout: float,
        resolve_permissions: bool,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if resolve_permissions:
                self.resolve_permissions()
            for event in self.events():
                if int(event["sequence"]) <= after or event["kind"] != "acp.tool_call":
                    continue
                raw_input = event["payload"]["params"]["update"].get("rawInput")
                if input_fragment in json.dumps(raw_input, sort_keys=True):
                    return
            time.sleep(0.1)
        raise TimeoutError(f"Codex did not start tool call containing {input_fragment!r}")

    def prompt(
        self,
        command_id: str,
        text: str,
        *,
        action: str | None = None,
        images: list[dict[str, Any]] | None = None,
        resources: list[dict[str, Any]] | None = None,
    ) -> None:
        request: dict[str, Any] = {
            "op": "prompt" if action is None else "deliver",
            "target": self.target,
            "commandId": command_id,
            "text": text,
            "images": images or [],
            "resources": resources or [],
        }
        if action is not None:
            request["action"] = action
        result = self.request(request)
        if result["state"] != "dispatched":
            raise AssertionError(result)

    def command_state(self, command_id: str) -> str | None:
        states = [
            event["payload"]["state"]
            for event in self.events()
            if event["kind"] == "command.state"
            and event["payload"].get("commandId") == command_id
        ]
        return states[-1] if states else None

    def resolve_permissions(self) -> None:
        for event in self.events():
            if event["kind"] != "acp.permission.requested":
                continue
            request_id = str(event["payload"]["id"])
            if request_id in self.resolved_permissions:
                continue
            options = event["payload"]["params"]["options"]
            params = event["payload"]["params"]
            raw_request = json.dumps(params, sort_keys=True)
            is_expected_mcp = params.get("_meta", {}).get("is_mcp_tool_approval") is True
            is_expected_read = (
                "proof.txt" in raw_request
                and '"type": "read"' in raw_request
            )
            if not is_expected_mcp and not is_expected_read and "sleep 4" not in raw_request:
                raise AssertionError(f"unexpected permission request: {raw_request}")
            option = next(
                (item for item in options if item.get("kind") == "allow_once"),
                None,
            )
            if option is None:
                raise AssertionError(f"permission lacks allow_once: {options}")
            self.request(
                {
                    "op": "permission",
                    "target": self.target,
                    "mutationId": f"permission-{request_id}",
                    "requestId": request_id,
                    "optionId": option["optionId"],
                }
            )
            self.resolved_permissions.add(request_id)

    def wait_for_command(
        self,
        command_id: str,
        *,
        expected: str = "completed",
        timeout: float = 150,
        resolve_permissions: bool = True,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if resolve_permissions:
                self.resolve_permissions()
            state = self.command_state(command_id)
            if state == expected:
                return
            if state in {"completed", "cancelled", "rejected", "ambiguous"}:
                raise AssertionError(
                    f"{command_id} reached {state}, expected {expected}"
                )
            time.sleep(0.2)
        raise TimeoutError(f"{command_id} remained {self.command_state(command_id)}")

    def assistant_text(self) -> str:
        return "".join(
            event["payload"]["params"]["update"]
            .get("content", {})
            .get("text", "")
            for event in self.events()
            if event["kind"] == "acp.agent_message_chunk"
        )


def option_values(snapshot: dict[str, Any], option_id: str) -> tuple[str, list[str]]:
    option = next(item for item in snapshot["configOptions"] if item["id"] == option_id)
    values = [str(item["value"]) for item in option.get("options", [])]
    return str(option["currentValue"]), values


def set_option(worker: Worker, option: str, value: str) -> None:
    worker.request(
        {
            "op": "set_config_option",
            "target": worker.target,
            "mutationId": f"set-{option}-{value}",
            "configId": option,
            "value": value,
        }
    )
    snapshot = worker.snapshot()
    worker.target = {
        key: snapshot[key] for key in ("sessionId", "workerId", "runtimeGeneration")
    }
    current = {
        item["id"]: item["currentValue"] for item in snapshot["configOptions"]
    }
    if current[option] != value:
        raise AssertionError(current)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--codex-acp", required=True)
    parser.add_argument("--session-mcp", required=True)
    parser.add_argument("--auth-file", required=True)
    parser.add_argument("--curl", default=shutil.which("curl") or "curl")
    args = parser.parse_args()
    args.worker = str(Path(args.worker).resolve(strict=True))
    args.codex_acp = str(Path(args.codex_acp).resolve(strict=True))
    args.session_mcp = str(Path(args.session_mcp).resolve(strict=True))
    args.curl = str(Path(args.curl).resolve(strict=True))

    auth_file = Path(args.auth_file).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="piss-codex-conformance.") as temp:
        root = Path(temp)
        (root / "workspace").mkdir()
        (root / "codex").mkdir()
        shutil.copy2(auth_file, root / "codex" / "auth.json")
        (root / "workspace" / "proof.txt").write_text(
            "RESOURCE_MARKER_7281\n", encoding="utf-8"
        )
        broker = ThreadingHTTPServer(("127.0.0.1", 0), BrokerHandler)
        broker_thread = threading.Thread(target=broker.serve_forever, daemon=True)
        broker_thread.start()
        broker_url = f"http://127.0.0.1:{broker.server_address[1]}"
        worker = Worker(args, root, broker_url)
        try:
            worker.start("conformance-1")
            capabilities = worker.hello()["capabilities"]
            if not {"prompt", "steer", "follow_up", "cancel", "permission", "config_options", "image_prompt"} <= set(capabilities):
                raise AssertionError(capabilities)

            worker.prompt(
                "mcp-call",
                "Use tool search to locate the MCP tool on server piss-sessions whose name ends in piss_list_sessions. Call that tool exactly once, then report the peer title exactly.",
            )
            worker.wait_for_command("mcp-call")
            text = worker.assistant_text()
            if "CODEX_MCP_PEER" not in text:
                raise AssertionError(text)
            if not any(
                event["kind"] == "acp.tool_call"
                and event["payload"]["params"]["update"].get("rawInput", {}).get("tool")
                == "piss_list_sessions"
                for event in worker.events()
            ):
                raise AssertionError("Codex did not emit the Piss MCP tool call")

            snapshot = worker.snapshot()
            option_ids = {item["id"] for item in snapshot["configOptions"]}
            if not {"model", "reasoning_effort", "mode"} <= option_ids:
                raise AssertionError(option_ids)
            initial_model, models = option_values(snapshot, "model")
            initial_reasoning, reasoning_values = option_values(
                snapshot, "reasoning_effort"
            )
            _, modes = option_values(snapshot, "mode")
            alternate_model = next(
                (value for value in models if value != initial_model), None
            )
            alternate_reasoning = next(
                (value for value in reasoning_values if value != initial_reasoning),
                None,
            )
            if alternate_model is None or alternate_reasoning is None:
                raise AssertionError("Codex did not advertise alternate model/reasoning values")
            if not {"read-only", "agent"} <= set(modes):
                raise AssertionError(modes)
            set_option(worker, "model", alternate_model)
            set_option(worker, "reasoning_effort", alternate_reasoning)
            set_option(worker, "model", initial_model)
            set_option(worker, "mode", "read-only")

            worker.prompt(
                "attachments",
                "Read the attached resource and report its exact marker. Also confirm that an image was attached. Do not modify files.",
                images=[
                    {
                        "mimeType": "image/png",
                        "data": PNG_1X1,
                        "name": "pixel.png",
                        "size": len(base64.b64decode(PNG_1X1)),
                    }
                ],
                resources=[{"path": "proof.txt"}],
            )
            worker.wait_for_command("attachments")
            text = worker.assistant_text()
            if "RESOURCE_MARKER_7281" not in text or "image" not in text.lower():
                raise AssertionError(text)

            base_after = worker.event_sequence()
            worker.prompt(
                "base",
                "Run the shell command sleep 4. After it finishes, answer BASE_ONLY unless I correct you during the run.",
            )
            worker.wait_for_tool_call(
                after=base_after,
                input_fragment="sleep 4",
                timeout=45,
                resolve_permissions=True,
            )
            worker.prompt(
                "steer",
                "Correction: answer STEER_OK instead of BASE_ONLY when the current run finishes.",
                action="steer",
            )
            worker.prompt(
                "follow",
                "After the current turn is fully finished, answer exactly FOLLOW_OK.",
                action="follow_up",
            )
            for command_id in ("steer", "base", "follow"):
                worker.wait_for_command(command_id)
            text = worker.assistant_text()
            if "STEER_OK" not in text or "FOLLOW_OK" not in text:
                raise AssertionError(text)
            if not worker.resolved_permissions:
                raise AssertionError("permission path was not exercised")

            set_option(worker, "mode", "agent")
            cancel_after = worker.event_sequence()
            worker.prompt("cancel-me", "Run the shell command sleep 30, then report done.")
            worker.wait_for_tool_call(
                after=cancel_after,
                input_fragment="sleep 30",
                timeout=30,
                resolve_permissions=False,
            )
            worker.request(
                {"op": "cancel", "target": worker.target, "mutationId": "cancel-1"}
            )
            worker.wait_for_command(
                "cancel-me", expected="cancelled", resolve_permissions=False
            )

            set_option(worker, "model", alternate_model)
            worker.stop()
            worker.start("conformance-2")
            if not any(
                event["kind"] == "acp.session.loaded" for event in worker.events()
            ):
                raise AssertionError("Codex session did not resume")
            restored = {
                item["id"]: item["currentValue"]
                for item in worker.snapshot()["configOptions"]
            }
            if (
                restored["model"] != alternate_model
                or restored["reasoning_effort"] != alternate_reasoning
                or restored["mode"] != "agent"
            ):
                raise AssertionError(restored)
            worker.prompt("after-resume", "Reply exactly RESUME_AFTER. Do not use tools.")
            worker.wait_for_command("after-resume")
            if "RESUME_AFTER" not in worker.assistant_text():
                raise AssertionError(worker.assistant_text())
        finally:
            worker.stop()
            broker.shutdown()
            broker.server_close()
            broker_thread.join(timeout=5)
            # The Codex app-server closes several SQLite WAL files after its
            # ACP parent exits. Give those child-process finalizers a bounded
            # moment before TemporaryDirectory removes CODEX_HOME.
            time.sleep(1)

    print(
        "Codex conformance passed: prompt, model/reasoning/mode, image/resource, "
        "permission, steer, follow-up, cancel, MCP tool call, and resume"
    )


if __name__ == "__main__":
    main()
