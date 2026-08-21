# Piss — OCaml implementation

This directory contains the native OCaml 5.2 services for Piss. The boundaries
are real:

```text
OCaml/Bonsai/js_of_ocaml browser
        |
        | authenticated same-origin HTTP + resumable SSE
        v
piss-control (replaceable; durable session registry)
        |
        | one negotiated owner-only Unix socket per session
        v
piss-session-worker@<session> (independent systemd unit + SQLite WAL)
        |
        | bidirectional ACP v1 JSON-RPC over stdio
        v
pi-acp + Pi  OR  codex-acp + Codex  OR  opencode acp (selected per session)
        |
        | Piss-provided MCP tools + capability-authenticated broker
        v
other independently supervised Piss sessions
```

The mock ACP agent remains only as a deterministic integration-test fixture.

## Layout

```
shared/                shared library (Piss_shared) — pure types and
│                       protocol definitions that both the backend
│                       and the browser shell consume. No IO.
│   ├── domain.ml      session, worker, command, event, snapshot types
│   ├── wire.ml        Piss wire protocol request/response variants
│   ├── acp.ml         ACP envelope helpers
│   └── workspace_files.ml  mention + resource types, validators,
│                            file:// uri builder, MIME table
src/
├── lib/                 compiler-enforced ownership libraries
│   ├── sqlite_support.ml shared durable SQLite connection policy
│   ├── store.ml         `piss.worker-store`: command/event ledger
│   ├── registry_domain.ml pure algebraic registry lifecycle states
│   ├── registry.ml      `piss.registry`: catalog + peer SQLite authority
│   ├── workspace_io.ml  `piss.workspace-io`: bounded filesystem IO
│   └── piss_core.ml     deprecated compatibility facade only
├── control/             piss-control (control plane)
│   ├── config.ml        CLI parsing, the workers type
│   ├── http.ml          HTTP request routing
│   ├── headers.ml       security headers and JSON/text helpers
│   ├── authentication.ml Tailscale identity, origin matching, CSP
│   ├── event_stream.ml  resumable SSE source
│   ├── workers.ml       session create/archive/restore, summary
│   ├── workspaces.ml    workspace directory discovery
│   ├── lifecycle.ml     launcher, stopper, per-session spec files
│   ├── broker.ml        inter-session request broker
│   ├── worker_client.ml Unix-socket client for worker requests
│   ├── assets.ml        static asset serving
│   └── main.ml          entry point
├── worker/              piss-session-worker
│   ├── config.ml        CLI parsing, timeouts, the args record
│   ├── harness.ml       ACP harness process spawn + envelope dispatch
│   ├── protocol.ml      wire protocol request handler
│   └── main.ml          run() orchestration
├── session_mcp/         piss-session-mcp
├── mock_agent/          piss-mock-agent
└── test/                unit tests + shell-driven integration tests
```

## Current user workflow

The deployed Bonsai application provides:

- durable allowlisted workspaces with current-style responsive navigation,
  safe removal of empty workspace registrations, and a bounded
  local-directory picker rooted only in Nix-approved discovery paths;
- named Pi/Codex/OpenCode session creation, renaming, switching, archival, and
  restoration through an active/archived session search;
- simultaneous Pi, Codex, and OpenCode sessions with one worker and ledger each;
- a current-workbench composer with Enter/Ctrl/Cmd dispatch,
  workspace-scoped `@` file mentions, pasted or file-selected image
  attachments, and ACP-backed model and thinking selectors;
- paginated durable history plus frame-batched streamed assistant messages
  over resumable server-sent events;
- safe Markdown message rendering with whole-message and fenced-code
  clipboard actions;
- compact, collapsed-by-default tool disclosures for commands, file
  locations, ACP diffs, images, resources, and terminal references;
- permission decisions for ACP agents that request them;
- durable active-turn steering and queued follow-up messages;
- harness-neutral agent collaboration through `piss_list_sessions`,
  `piss_ask_session`, `piss_send_session`, `piss_collect_responses`, and
  `piss_subscribe_responses` MCP tools.

The pinned `codex-acp` package carries a tested Piss delivery patch that maps
active-turn steer metadata to Codex steering and serializes durable follow-ups
after the current turn. The opt-in authenticated `just test-codex` conformance
suite covers prompt, model/reasoning/mode changes, images/resources,
permissions, steer, follow-up, cancel, a real Piss MCP tool call, and restart
resume.

The NixOS module builds the control plane, session worker, browser, and
collaboration MCP server as separate immutable Nix closures. It runs the
control plane separately from dynamic `piss-worker@<session>.service`
instances. Worker templates set `restartIfChanged = false` and
`stopIfChanged = false`, so NixOS activation never interrupts a healthy
worker. The timer can be disabled with
`services.piss.autoUpgradeIdleWorkers = false` or rescheduled through
`workerUpgradeInterval`.

The durable registry records active and archived sessions, while each
active session owns a Unix socket, SQLite ledger, ACP adapter, and systemd
restart policy. A worker restart uses ACP `session/load` when supported
to reattach to its harness session and replay conversation history.

## Security boundary

- binds only to loopback and is published through an independent Tailscale
  Serve node;
- requires an allowlisted `Tailscale-User-Login` for every route except
  `/health`;
- requires same-origin JSON mutations;
- uses a restrictive content security policy and denies framing;
- bounds HTTP bodies, worker frames, prompts, image count/types/decoded
  bytes, event pages, command IDs, and retained state;
- starts only fixed harness commands from the NixOS service definition;
- passes model credentials and the SSH agent only to the worker service.

## Build and test

The default Nix development shell provides OCaml 5.2, the native project
dependencies, Playwright, and Chromium. Browser builds use the separate OCaml
5.2 `.#web` shell:

```bash
just build          # native and Bonsai OCaml 5.2 builds
just test           # Alcotest unit suite
just test-integration  # shell-driven interaction/isolation/mention/replaceability
just format         # auto-format every compiled OCaml source
just check          # format-check + build + test + test-integration
```

Direct dune equivalents remain available (`dune build @all`, etc.). Run
`just bench-catalog` to reproduce the serial-versus-eight-fiber catalog summary
benchmark. See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for ownership,
state-machine, migration, budget, extension, and deployment rules.

Production Nix package:

```bash
nix build .#piss
```

The single output contains every Piss executable and the browser assets under
`share/piss/public`. Agent adapters and service orchestration belong to the
host NixOS configuration.

`@interaction-test` proves bounded workspace file search, typed ACP
resource-link and image delivery, monotonic SSE delivery, `Last-Event-ID`
resumption without duplicates, artifact-bearing ACP tool updates,
permission validation/resolution, and prompt cancellation against the
deterministic ACP fixture.

## Durability semantics

The worker database uses WAL, `synchronous=FULL`, foreign keys, a busy
timeout, unique command/request IDs, and monotonic event sequences. A
command is committed before it is written to the ACP agent. Duplicate
command IDs return the existing state and are never dispatched again. A
write failure after acceptance becomes `ambiguous`; an interrupted worker
reconciles accepted/dispatched commands to `ambiguous` instead of silently
retrying consequential work.

## Deliberate current limitations

- Each session allows one prompt turn at a time; independent sessions can
  run concurrently.
- Active sessions have a configurable resource cap (`maxActiveSessions`,
  32 by default and at most 256).
- Pi, Codex, and OpenCode are selectable per session; the bootstrap default is Pi.
- The first SSE path uses bounded 250 ms worker-ledger reads behind one
  browser connection.
