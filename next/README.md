# PISS next — OCaml replaceability tracer

This directory contains the first vertical slice of the [OCaml rewrite specification](../docs/OCAML-REWRITE.md).

It is intentionally narrow, but its boundaries are real:

```text
OCaml/Melange browser
        |
        | HTTP
        v
pissd-next (replaceable)
        |
        | negotiated JSONL over an owner-only Unix socket
        v
piss-session-worker (durable SQLite event/command ledger)
        |
        | ACP v1 JSON-RPC over stdio
        v
piss-mock-agent
```

## What the tracer proves

- The control plane does not own the agent process.
- The worker and agent retain their PIDs across a forced control-plane replacement.
- ACP updates produced while the control plane is absent are committed to SQLite WAL.
- The replacement control plane reconnects through a version-negotiated Unix socket and projects the retained events.
- A repeated `(session, commandId)` returns the durable result and is not dispatched twice.
- The browser is written in Reason, compiled by Melange through Dune, and reconnects without a page reload.
- Native and browser artifacts build reproducibly through Nix.

## Build and test

The repository is Nix-managed:

```bash
nix develop
npm ci                     # JavaScript runtime modules used by the Melange bundle
dune build @all @web-bundle
dune runtest
dune build @replaceability-test
```

Production-style package checks:

```bash
nix build .#piss-next-native
nix build .#piss-next-web
```

The replaceability test starts a worker and ACP mock, dispatches a long-running tool, sends `SIGKILL` to `pissd-next`, starts a new control-plane generation, and verifies unchanged worker/harness PIDs plus exactly-once command completion.

## Run the browser tracer

```bash
state="$(mktemp -d)"

dune exec piss-session-worker -- \
  --socket "$state/worker.sock" \
  --database "$state/worker.sqlite3" \
  --session tracer-session \
  --worker tracer-worker \
  --workspace "$PWD" \
  --harness "$PWD/_build/default/next/mock_agent/main.exe"
```

In another terminal:

```bash
dune exec pissd-next -- \
  --port 4318 \
  --worker-socket "$state/worker.sock" \
  --public "$PWD/web-next/public" \
  --app-js "$PWD/_build/default/web-next/app.js" \
  --generation development
```

Open <http://127.0.0.1:4318> and choose **Start stability proof**.

## Current durability boundary

The worker database uses:

- WAL journal mode;
- `synchronous=FULL`;
- foreign keys;
- a busy timeout;
- a unique command ID and request ID;
- an autoincrementing event sequence;
- transactions around command acceptance and state transitions.

A command is durably accepted before it is written to the ACP agent. A duplicate command returns its existing state. A write failure after durable acceptance transitions the command to `ambiguous` rather than retrying it invisibly.

## Deliberate tracer limitations

- The mock agent implements only the ACP methods needed by this slice.
- One worker handles one ACP session and one active prompt at a time by convention; the next slice will enforce this in the domain reducer.
- `pissd-next` is development-loopback-only and does not yet implement production Tailscale identity authentication.
- The browser polls the bounded event endpoint once per second; resumable SSE follows after replay semantics are finalized.
- Worker creation is manual; the production worker launcher must use independently supervised user-systemd units with fixed arguments.
- The worker has no production retention pass yet, although all endpoint and frame reads are bounded.
- Existing PISS metadata is not read or migrated.
- The current TypeScript application remains the reference for features not represented by this tracer.

These limitations are at explicit boundaries. None weakens the replaceability proof.

## Next slice

Connect one real ACP harness through the existing worker boundary, initially `pi-acp` or OpenCode, and implement the shared contract for:

- capability negotiation;
- messages and tool calls;
- permission requests;
- session configuration;
- cancellation;
- malformed/oversized ACP containment;
- agent exit and restart reconciliation.

Only after the same worker/control path supports a second harness should additional product features move from the TypeScript implementation.
