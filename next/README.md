# PISS next — usable OCaml agent control plane

This directory contains the first usable vertical slice of the [OCaml rewrite specification](../docs/OCAML-REWRITE.md).

Its boundaries are real:

```text
Reason/Melange browser
        |
        | authenticated same-origin HTTP
        v
pissd-next (replaceable)
        |
        | negotiated bounded JSONL over an owner-only Unix socket
        v
piss-session-worker (independently supervised; SQLite WAL)
        |
        | bidirectional ACP v1 JSON-RPC over stdio
        v
pi-acp (pinned Nix package)
        |
        | Pi RPC
        v
Pi coding agent
```

The mock ACP agent remains only as a deterministic integration-test fixture.

## Current user workflow

The deployed Reason application provides:

- fresh-conversation creation without restarting the control plane;
- an arbitrary prompt composer with Ctrl/Cmd+Enter dispatch;
- streamed assistant messages;
- structured tool-call cards and output;
- permission decisions for ACP agents that request them;
- active-turn cancellation;
- worker, adapter, and event-sequence telemetry;
- automatic reconnection to the durable timeline.

The NixOS module runs the control plane and worker as separate user-systemd services. Updating or restarting `piss-ocaml.service` does not restart the worker, `pi-acp`, Pi, or an active tool. If the worker itself restarts, it uses ACP `session/load` to reattach to the Pi session and replay conversation history. A stale or missing adapter mapping fails visibly and falls back to a new ACP session rather than entering a restart loop.

## Security boundary

The deployed control plane:

- binds only to loopback and is published through an independent Tailscale Serve node;
- requires an allowlisted `Tailscale-User-Login` for every route except `/health`;
- requires same-origin JSON mutations;
- uses a restrictive content security policy and denies framing;
- bounds HTTP bodies, worker frames, prompts, event pages, command IDs, and retained state;
- starts only fixed harness commands from the NixOS service definition;
- passes model credentials and the SSH agent only to the worker service.

Tailscale Serve strips client-supplied identity headers before injecting the authenticated user identity. Tagged source devices do not receive a user identity header and therefore cannot use the browser/API routes.

## Build and test

The repository is Nix-managed:

```bash
nix develop
npm ci
dune build @all @web-bundle
dune runtest
dune build @interaction-test
dune build @replaceability-test
```

Production packages:

```bash
nix build .#pi-acp
nix build .#piss-next-native
nix build .#piss-next-web
nix build .#checks.x86_64-linux.piss-next-nixos-module
```

`@interaction-test` proves permission validation/resolution and prompt cancellation against the deterministic ACP fixture. `@replaceability-test` dispatches a long-running tool, sends `SIGKILL` to `pissd-next`, starts a replacement generation, and verifies unchanged worker/harness PIDs, replay, and exactly-once command completion.

A real-harness smoke has also exercised both pinned `pi-acp` and OpenCode's `opencode acp` command through the same OCaml worker/control protocol. Both are reproducible flake packages, and the NixOS module selects them with `services.piss-next.harness = "pi"` or `"opencode"`.

## Local real-Pi run

Build first, then provide a writable HOME with normal Pi configuration:

```bash
state="$(mktemp -d)"
adapter="$(nix build .#pi-acp --no-link --print-out-paths)"

dune exec piss-session-worker -- \
  --socket "$state/worker.sock" \
  --database "$state/worker.sqlite3" \
  --session development-session \
  --worker development-worker \
  --workspace "$PWD" \
  --harness "$adapter/bin/pi-acp"
```

In another terminal:

```bash
dune exec pissd-next -- \
  --port 4318 \
  --worker-socket "$state/worker.sock" \
  --public "$PWD/web-next/public" \
  --app-js "$PWD/_build/default/web-next/app.js" \
  --generation development \
  --dev-bypass-auth
```

Open <http://127.0.0.1:4318>.

## Durability semantics

The worker database uses WAL, `synchronous=FULL`, foreign keys, a busy timeout, unique command/request IDs, and monotonic event sequences.

A command is committed before it is written to the ACP agent. Duplicate command IDs return the existing state and are never dispatched again. A write failure after acceptance becomes `ambiguous`; an interrupted worker reconciles accepted/dispatched commands to `ambiguous` instead of silently retrying consequential work. Completed, cancelled, rejected, and ambiguous outcomes are explicit.

The event spool keeps a bounded rolling window. When it reaches 4,096 rows, the oldest 512 events are compacted while SQLite's autoincrement sequence remains monotonic. The browser requests the newest bounded page, while ACP `session/load` remains the source for full harness conversation replay after worker replacement.

## Deliberate current limitations

- One deployed worker owns the currently selected ACP session and allows one prompt turn at a time.
- The browser can create a fresh conversation. Until each session has its own worker, creation is capped at four per worker lifetime because adapters may retain harness processes; list/archive and concurrent sessions are not exposed yet.
- OpenCode is packaged, selectable, and has passed a real ACP smoke through the same path, but the deployed Tailnet service currently selects Pi.
- The browser uses bounded 750 ms polling rather than resumable SSE.
- Pi executes its own filesystem and terminal tools; ACP permission requests are rendered when the adapter emits them, but `pi-acp` currently uses them primarily for extension UI interactions.
- Existing TypeScript PISS workflow metadata is not migrated.
- Browser automation, workflow authority, reviews, notifications, and the rest of the TypeScript product remain outside this slice.

## Next production slices

1. Add a narrow launcher that creates one fixed-argument user-systemd worker per durable session.
2. Add create/list/archive/load UI backed by that launcher and a control-plane session registry.
3. Deploy OpenCode as the second selectable harness and run the replaceability suite against both.
4. Replace polling with resumable SSE using the existing monotonic event cursor.
5. Port one complete PISS workflow through the real authority and receipt model.
