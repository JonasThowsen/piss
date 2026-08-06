# PISS next — usable OCaml agent control plane

This directory contains the first usable vertical slice of the [OCaml rewrite specification](../docs/OCAML-REWRITE.md).

Its boundaries are real:

```text
Reason/Melange browser
        |
        | authenticated same-origin HTTP + resumable SSE
        v
pissd-next (replaceable; durable session registry)
        |
        | one negotiated owner-only Unix socket per session
        v
piss-session-worker@<session> (independent systemd unit + SQLite WAL)
        |
        | bidirectional ACP v1 JSON-RPC over stdio
        v
pi-acp + Pi  OR  opencode acp (selected per session)
        |
        | PISS-provided MCP tools + capability-authenticated broker
        v
other independently supervised PISS sessions
```

The mock ACP agent remains only as a deterministic integration-test fixture.

## Current user workflow

The deployed Reason application provides:

- durable allowlisted workspaces with current-style responsive navigation and a bounded local-directory picker rooted only in Nix-approved discovery paths;
- named Pi/OpenCode session creation, renaming, switching, archival, and restoration;
- simultaneous Pi and OpenCode sessions with one worker and ledger each;
- a current-workbench composer with Enter/Ctrl/Cmd dispatch plus ACP-backed model and thinking selectors;
- streamed assistant messages over resumable server-sent events;
- structured tool-call cards and output;
- permission decisions for ACP agents that request them;
- active-turn cancellation;
- worker, adapter, and event-sequence telemetry;
- automatic reconnection to the durable timeline;
- harness-neutral agent collaboration through `piss_list_sessions`, synchronous `piss_ask_session`, asynchronous `piss_send_session`, blocking `piss_collect_responses`, and durable `piss_subscribe_responses` MCP tools;
- parallel fan-out with durable request IDs and fan-in that can listen for the first response or all responses;
- dormant orchestrator wake-up: PISS durably waits after the originating turn ends, then starts exactly one new turn with captured results once the subscription is ready and the orchestrator is idle.

The NixOS module builds the control plane, session worker, browser, and collaboration MCP server as separate immutable Nix closures. It runs the control plane separately from dynamic `piss-ocaml-worker@<session>.service` instances. Worker templates set `restartIfChanged = false` and `stopIfChanged = false`, so existing workers retain their current executable generation through PISS updates and unrelated NixOS rebuilds; newly created or independently restarted workers adopt the current generation. The durable registry records active and archived sessions, while each active session owns a Unix socket, SQLite ledger, ACP adapter, and systemd restart policy. Updating or restarting `piss-ocaml.service` idempotently starts missing workers without restarting healthy ones. If a worker itself restarts, it uses ACP `session/load` when supported to reattach to its harness session and replay conversation history. A stale or missing adapter mapping fails visibly and falls back to a new ACP session rather than entering a restart loop.

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
dune build @session-isolation-test
```

Production packages:

```bash
nix build .#pi-acp
nix build .#piss-next-native
nix build .#piss-next-web
nix build .#checks.x86_64-linux.piss-next-nixos-module
```

`@interaction-test` proves monotonic SSE delivery, `Last-Event-ID` resumption without duplicates, permission validation/resolution, and prompt cancellation against the deterministic ACP fixture. `@replaceability-test` dispatches a long-running tool, sends `SIGKILL` to `pissd-next`, starts a replacement generation, resumes SSE from the last received event ID, and verifies unchanged worker/harness PIDs, gap-free replay, and exactly-once command completion. `@session-isolation-test` creates two durable sessions, runs both concurrently, kills and observes replacement of one worker without changing the other, replaces the control plane, archives one session, restores it under the same identity, and verifies its ledger and completed timeline remain intact.

A real-harness smoke has exercised both pinned `pi-acp` and OpenCode's `opencode acp` command through the same OCaml worker/control protocol. Both are reproducible flake packages and may now run simultaneously; `services.piss-next.harness` selects only the bootstrap default.

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

The worker database uses WAL, `synchronous=FULL`, foreign keys, a busy timeout, unique command/request IDs, and monotonic event sequences. The registry also durably records inter-session request identities, source/target sessions, target command IDs, replay cursors, queued/dispatched/completed states, responses, and wake subscriptions. An orchestrator may dispatch up to 64 tracked requests, continue other work, synchronously collect results, or subscribe and end its turn. The replaceable control supervisor reconstructs target outputs from their ledgers and retries the same deterministic wake command until the source worker is idle. Worker command deduplication ensures control replacement cannot start the wake turn twice.

A command is committed before it is written to the ACP agent. Duplicate command IDs return the existing state and are never dispatched again. A write failure after acceptance becomes `ambiguous`; an interrupted worker reconciles accepted/dispatched commands to `ambiguous` instead of silently retrying consequential work. Completed, cancelled, rejected, and ambiguous outcomes are explicit.

The event spool keeps a bounded rolling window. When it reaches 4,096 rows, the oldest 512 events are compacted while SQLite's autoincrement sequence remains monotonic. The browser loads the newest bounded page once, then follows the selected session over SSE. Every frame carries the durable sequence as its event ID, so native `Last-Event-ID` reconnection resumes strictly after the last received event without duplicates. ACP `session/load` remains the source for full harness conversation replay after worker replacement.

## Deliberate current limitations

- Each session allows one prompt turn at a time; independent sessions can run concurrently.
- Active sessions have a configurable resource cap (`maxActiveSessions`, 32 by default and at most 256). Archival stops the worker and retains its registry row and ledger; restoration relaunches the same session identity and ledger.
- Pi and OpenCode are selectable per session. The bootstrap default remains Pi. Every session is bound to one Nix-allowlisted workspace, written into its immutable owner-only worker specification.
- The first SSE path uses bounded 250 ms worker-ledger reads behind one browser connection; a worker-side wait/fanout primitive is deferred until multiple simultaneous observers per session are needed.
- Pi executes its own filesystem and terminal tools; ACP permission requests are rendered when the adapter emits them, but `pi-acp` currently uses them primarily for extension UI interactions.
- Existing TypeScript PISS workflow metadata is not migrated.
- Browser automation, workflow authority, reviews, notifications, and the rest of the TypeScript product remain outside this slice.

## Next production slices

1. Add per-session names, workspace selection from a fixed allowlist, and configuration controls so orchestrators can address stable human-readable roles.
2. Add explicit cancellation and optional deadlines for asynchronous collaboration requests.
3. Add explicit lifecycle operation receipts for create/archive/restore reconciliation.
4. Port one complete PISS workflow through the real authority and receipt model.
