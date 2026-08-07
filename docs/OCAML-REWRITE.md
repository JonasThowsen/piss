# PISS OCaml rewrite specification

Status: **accepted direction; tracer implementation in progress**  
Branch: `rewrite/ocaml`

## 1. Objective

Rebuild PISS as a harness-agnostic, local-first agent control plane whose own deployment, restart, or failure does not interrupt active agent processes.

The defining guarantee is **control-plane replaceability**:

> While an agent is executing a tool, the PISS API/control-plane process can be killed and replaced. The agent and tool processes keep their PIDs, output is durably buffered, the replacement control plane reconstructs the session, and no accepted command is executed twice.

The backend and browser application are written in OCaml. Native services compile with OCaml 5 and Dune. Browser code compiles from OCaml/Reason through Melange and Dune. The first harness integration uses ACP; Pi may be reached through an ACP adapter while remaining replaceable.

## 2. Product boundary

PISS is a secure control plane and user interface for coding agents. It is not itself required to own the model/tool reasoning loop.

PISS owns:

- authenticated remote browser access;
- trusted workspace registration and path policy;
- durable PISS session identity;
- creation and independent supervision of session workers;
- accepted-command deduplication;
- bounded durable event projection;
- browser reconnection and attention state;
- user approvals and interactive requests;
- engineering-workflow authority, progress, and operation receipts;
- notifications, review, and managed browser capabilities;
- mapping PISS sessions to harness-owned sessions;
- durable, capability-authenticated request/reply between active sessions so any session can act as an orchestrator.

A harness owns:

- provider communication and authentication;
- model/tool reasoning loops;
- native tools, prompts, skills, and compaction;
- harness-native conversation context;
- its own session identifier and optional history.

ACP owns the interoperable vocabulary between them:

- initialization and capability negotiation;
- session create/list/load/resume/close;
- prompts and cancellation;
- messages, plans, usage, and tool-call updates;
- permission and elicitation requests;
- configurable models, modes, and reasoning levels.

PISS-specific capabilities remain server-owned and may be exposed to harnesses through MCP or negotiated ACP extensions. The primary collaboration path is a PISS-provided MCP server with session discovery, synchronous request/reply, asynchronous fan-out, durable response collection, and durable wake subscriptions. An orchestrator can send work to many independently supervised sessions, subscribe to any or all completions, end its current turn, and be started in exactly one new turn containing the captured results once it is idle. Subscription and deterministic wake-command identities survive control replacement; PISS schedules the turn but does not own its reasoning loop. ACP wire messages are not the PISS persistence schema.

## 3. Non-negotiable invariants

### 3.1 Process isolation

1. `pissd` never owns an agent process directly.
2. Each writable session has at most one active session worker.
3. A worker owns at most one writable harness session.
4. Session workers are independently supervised by the OS service manager.
5. Stopping, upgrading, or crashing `pissd` does not signal workers, harnesses, or their tool process groups.
6. A worker failure cannot directly terminate another worker.
7. Existing workers may continue running an older immutable Nix generation while new workers use a newer generation.

### 3.2 Durable identity

These identities are distinct and never substituted for one another:

- `PissSessionId`: durable, allocated by PISS;
- `WorkerId`: one independently supervised worker incarnation;
- `RuntimeGeneration`: monotonically increasing writable runtime generation;
- `HarnessSessionId`: opaque identifier allocated by the harness;
- `CommandId`: client-generated idempotency identity;
- `EventSequence`: worker-allocated monotonic event position;
- `ToolCallId`: harness-owned identity scoped to a harness session;
- `OperationId` and `OperationReceiptId`: PISS workflow authority identities.

Every runtime-targeted mutation binds to `PissSessionId`, `WorkerId`, and `RuntimeGeneration`. Stale generations fail closed.

### 3.3 Command delivery

A command has the durable states:

```text
received -> accepted -> dispatched -> acknowledged -> completed
                         \-> ambiguous
received -> rejected
```

- `(session_id, command_id)` is unique.
- The worker persists `accepted` before writing to the harness.
- A duplicate command returns the existing result and is never redispatched.
- A worker crash after dispatch but before harness acknowledgement produces `ambiguous`; it does not silently retry a consequential command.
- Read-only commands may declare a bounded retry policy.
- Receipt-required operations retain their dossier-bound idempotency key forever or until explicit archival policy permits removal.

### 3.4 Event delivery

- Every worker event has a monotonic `EventSequence`.
- The worker persists an event before advertising its sequence to `pissd`.
- `pissd` reconnects with its last durably applied sequence.
- Replay is inclusive of every later retained event and idempotent at `pissd`.
- The worker retains a bounded event log; exceeding the bound applies backpressure or fails closed rather than silently dropping security-relevant state.
- Large tool output is stored as a bounded artifact referenced by an event.
- Browser streams are projections and may reconnect from a server cursor; they are never the source of truth.

### 3.5 Authority and interaction

- Losing the browser or control plane never converts a pending interaction into approval.
- Pending permission and elicitation requests remain pending across reconnect.
- An approval is released only after the authority decision is durable.
- Generic ACP `allow_always` is not equivalent to a PISS engineering-workflow authority envelope.
- Workspace paths supplied by a harness are untrusted and revalidated against the worker's immutable authorized roots.

### 3.6 Resource bounds

All of the following are explicitly bounded:

- active workers;
- queued and retained commands;
- event rows and retained bytes;
- JSON line length;
- HTTP request and response bodies;
- browser stream clients;
- tool output and media artifacts;
- restart attempts and retry delays;
- shutdown and reconciliation timeouts.

No input-controlled collection may grow without a configured bound.

## 4. Process architecture

```text
Browser (OCaml/Melange)
        |
        | HTTPS + server events
        v
pissd (replaceable OCaml control plane)
  - Tailscale identity authentication
  - workspace/session registry
  - worker discovery and reconciliation
  - durable workflow state
  - browser API and projections
        |
        | versioned reconnectable local protocol
        v
piss-session-worker@<session-id> (OCaml)
  - one session lease
  - command ledger
  - bounded event spool
  - pending interactions
  - ACP client and harness adapter
        |
        | ACP v1 over JSON-RPC stdio initially
        v
Pi ACP adapter / OpenCode / OpenHands / other ACP agent
```

### 4.1 OS ownership

Production workers run as independently managed user-systemd units or equivalent service-manager jobs. `pissd` requests a typed worker specification; a narrow launcher creates the unit with fixed arguments and an immutable executable path. The API does not accept arbitrary commands.

The worker unit records:

- PISS session ID;
- workspace device/inode identity and canonical path;
- worker generation and binary generation;
- harness adapter and fixed executable;
- state/event storage paths;
- bounded environment allowlist.

The worker is not part of `pissd.service`'s control group and is not stopped when that service changes generation.

### 4.2 Local transport

The preferred production transport is an owner-only Unix-domain socket beneath `$XDG_RUNTIME_DIR/piss/workers/<worker-id>.sock`.

Each connection performs protocol negotiation before state exchange. During the tracer, loopback TCP may be used only if Unix socket support blocks the vertical slice; this deferral must not permit non-loopback binding and must be replaced before production authority is enabled.

The local protocol provides:

- `hello` / version and capability negotiation;
- worker snapshot;
- event replay from sequence;
- command submission by stable command ID;
- interaction response;
- quiesce/stop request;
- health and bounded diagnostic state.

It is not ACP. ACP is the worker-to-harness protocol; the worker protocol includes PISS durability and reconciliation semantics absent from ACP.

## 5. Persistence model

SQLite in WAL mode is the default local system of record. Foreign keys are enabled. Migrations are monotonic, transactional, checksummed, and run only by the process that owns the database.

`pissd` owns a global database containing:

- trusted workspaces;
- PISS sessions and worker registrations;
- browser-visible names and metadata;
- engineering workflows and authority decisions;
- notification subscriptions;
- applied worker event high-water marks.

Each worker owns a session-local database containing:

- worker/runtime identity;
- harness identity and negotiated capabilities;
- command ledger;
- monotonic events;
- pending interactions;
- bounded artifact metadata;
- clean/unclean shutdown marker.

Workers do not open the global database. `pissd` does not open worker databases while workers are active. Ownership stays explicit and schema upgrades cannot create cross-generation multi-writer ambiguity.

Durability levels:

- authority, command acceptance, receipts, and interaction decisions use full transactional durability;
- reconstructible display projections may use normal WAL durability;
- no security decision relies only on an in-memory acknowledgement.

## 6. Domain model

```ocaml
type session_state =
  | Registered
  | Starting of starting
  | Idle of connected_runtime
  | Running of running
  | Requires_action of pending_interaction
  | Reconnecting of reconnect_state
  | Stopping of stopping
  | Stopped of stop_reason
  | Failed of failure
```

State transitions are pure functions returning either a new state and effects to execute, or a typed domain error. Infrastructure performs effects only after persistence boundaries required by the transition.

Illegal combinations are excluded through variants rather than optional fields where practical. Decoded external data first enters untrusted wire types and is converted to validated domain types.

## 7. ACP compatibility

### 7.1 Baseline

The first production baseline is stable ACP v1:

- `initialize` with explicit capabilities;
- `session/new`;
- `session/prompt`;
- `session/update` messages, plans, usage, and tools;
- `session/request_permission`;
- `session/cancel`;
- optional list/load/resume/close and configuration capabilities.

ACP v2 remains feature-gated until stable. The internal domain must not assume that a pending `session/prompt` request is the only indication of running work, so v2's independent state updates can be added without a rewrite.

### 7.2 Capability policy

PISS renders three layers:

1. baseline interoperable ACP features;
2. negotiated optional capabilities;
3. namespaced harness/PISS extensions.

Unsupported controls are absent or explicitly unavailable. PISS never fabricates support. Raw unknown extensions may be retained in bounded diagnostic events but do not affect authority.

### 7.3 Mapping policy

PISS keeps its own canonical values for attention, delivery, and workflow state. ACP updates are reduced into those values through total functions. Harness-specific adapters may enrich but never weaken security validation.

## 8. HTTP/browser boundary

The browser remains a remote client of `pissd`; it does not speak stdio ACP and does not connect directly to workers.

Initial API:

- `GET /health` — process liveness and generation;
- `GET /api/v2/sessions` — bounded session summaries;
- `GET /api/v2/sessions/:id` — reconstructed session snapshot;
- `GET /api/v2/sessions/:id/events?after=` — paginated durable events;
- `GET /api/v2/sessions/:id/stream?after=` — resumable event stream;
- `POST /api/v2/sessions/:id/commands` — stable command ID and runtime target;
- `POST /api/v2/sessions/:id/interactions/:id` — durable response;
- workspace and worker lifecycle endpoints added by later slices.

All mutations require same-origin HTTPS in production, authenticated Tailscale identity, content-type validation, bounded bodies, and mutation IDs.

The OCaml/Melange browser application is compiled by Dune. It preserves the current mobile-first product direction and accessibility boundary. Frontend migrations are vertical by workflow; the existing React application remains reference behavior until each replacement path is verified.

## 9. Update protocol

### 9.1 Browser assets

Browser assets are content-addressed and independently replaceable. A service worker caches only immutable shell assets. API responses and private data are never cached. Activation never reloads a focused tab without an explicit local update action.

### 9.2 Control plane

1. New Nix generation is built without touching running processes.
2. `pissd` stops accepting new mutations and drains accepted HTTP requests for a short bound.
3. `pissd` exits without contacting or signalling workers.
4. systemd starts the new `pissd` generation.
5. It opens the global database, runs compatible migrations, discovers workers, negotiates protocol versions, and replays from each high-water sequence.
6. Browser clients reconnect and receive a new control-plane generation.

Unlike the current system, activation does not wait for agents to become idle.

### 9.3 Worker

Workers are never stopped as a bulk activation side effect. A worker upgrade is session-scoped and eventually automatic by default:

- an idle worker atomically enters a bounded drain lease, durably records its target generation and selected ACP configuration, rejects racing mutations, and is replaced independently;
- the replacement restores the ACP session and selected configuration when supported and durably completes the upgrade receipt before the upgrader advances;
- running workers keep their existing generation until a later idle check;
- protocol compatibility allows old workers to reconnect to new `pissd`;
- legacy or incompatible workers that cannot acknowledge safe preparation remain supervised and visible rather than being restarted through a race.

## 10. Security boundary

The existing private NixOS + Tailscale deployment remains the supported production boundary.

Required invariants:

- production listeners bind only to loopback or owner-only Unix sockets;
- Tailscale identity and explicit allowlist remain default-deny;
- worker launch roots come only from registered workspaces;
- browser input cannot provide arbitrary executable paths or CLI flags;
- workers receive a minimal environment and explicitly configured secret set;
- one worker cannot mutate another worker's storage or socket;
- local sockets and state are mode `0600`/`0700` as appropriate;
- harness output is untrusted data and never rendered as unsanitized HTML;
- all artifacts are signature/type/size validated;
- operation authority is exact, durable, and revision-bound.

## 11. Observability

Every process emits structured logs with:

- process and immutable binary generation;
- session, worker, and runtime identities where relevant;
- command ID or event sequence;
- bounded error category and causal context;
- no prompt, tool output, path, token, or secret unless explicitly enabled in local diagnostics.

Metrics include:

- worker connection state;
- event replay lag;
- event/artifact bytes retained;
- command state counts;
- malformed frame counts;
- reconnect and restart counts;
- database transaction latency;
- browser stream count and backpressure state.

A support bundle is bounded and privacy-reviewed before export.

## 12. Testing strategy

### 12.1 Pure domain tests

- exhaustive state transitions;
- stale runtime rejection;
- duplicate command reduction;
- attention-state projection;
- ACP-to-domain conversion;
- bounds and retention decisions.

### 12.2 Persistence tests

- transaction rollback at every command boundary;
- WAL reopen after abrupt process exit;
- migration checksums and downgrade refusal;
- event high-water idempotency;
- ambiguous dispatch reconciliation.

### 12.3 Process integration tests

- malformed and oversized JSONL frames;
- partial UTF-8 and fragmented frames;
- harness exits before/after acknowledgement;
- worker exits while `pissd` remains;
- `pissd` exits while worker and tool remain;
- pending permission across reconnect;
- signal escalation and process-group cleanup on explicit session stop.

### 12.4 Browser tests

- initial session list and reconnect state;
- message/tool timeline updates;
- command deduplication after simulated response loss;
- accessible permission handling;
- narrow mobile and desktop viewports;
- no private API data in Cache Storage;
- update activation without involuntary active-tab reload.

### 12.5 Production-style acceptance

The canonical replaceability test records PIDs, starts a 60-second tool, force-kills `pissd`, starts the new generation, and proves:

- worker, harness, and tool PIDs did not change;
- output produced during downtime is present after replay;
- the accepted command appears exactly once;
- the final result appears exactly once;
- no pending permission was auto-resolved;
- all retained state stays within configured bounds.

## 13. Delivery slices

### Slice 0 — repository and reproducible toolchain

- OCaml 5, Dune, formatter, tests, Melange, and required libraries pinned by Nix.
- `dune build @all`, tests, and frontend emission run in the dev shell.
- Existing TypeScript implementation remains buildable during migration.

### Slice 1 — replaceability tracer

Observable behavior: one mock ACP session continues a long-running tool while `pissd` is killed and replaced; an OCaml/Melange browser reconnects and shows buffered completion.

This slice includes real native binaries, SQLite, local transport, HTTP/event stream, and process tests. It may use a fixed mock harness and one fixed workspace.

### Slice 2 — real ACP harness

Replace the mock with one real ACP harness, initially Pi through `pi-acp` or OpenCode. Negotiate capabilities and render native messages/tools/permissions.

### Slice 3 — trusted workspace and session lifecycle

Port workspace registration, session creation/list/load/resume/stop, identity validation, and bounded worker launcher integration.

### Slice 4 — complete conversational controls

Port model/thinking configuration, usage, commands, image prompts, queue/steer behavior where supported, and interactive elicitation.

### Slice 5 — review, files, notifications, and PWA

Port file mentions, sandboxed review, notifications, offline shell, drafts, navigation, and update UX.

### Slice 6 — engineering workflows and managed browser

Port the durable workflow state machine, exact authority, receipts, supervisor recovery, browser tools, and evidence artifacts without weakening current invariants.

### Slice 7 — migration and cutover

Import existing trusted workspaces and PISS metadata. Pi transcript files remain owned by Pi. Run both implementations against separate ports/state roots, execute compatibility and recovery tests, then switch the NixOS module deliberately.

## 14. Explicit exclusions from the first tracer

- complete migration of the existing 3,700-line React workbench;
- public internet exposure;
- multi-user collaboration;
- exact process survival across machine reboot;
- ACP v2 enabled by default;
- arbitrary harness executable or argument submission from the browser;
- engineering-workflow authority before command/event durability is proven;
- browser-managed worktrees;
- automatic migration of production state.

These exclusions keep the first slice small without faking its central reliability claim.

## 15. Readiness gates

The rewrite cannot replace the current implementation until all are true:

- replaceability acceptance passes under graceful restart and `SIGKILL`;
- at least two harnesses pass the shared ACP contract suite;
- every current security invariant is preserved or explicitly strengthened;
- production Nix builds are reproducible on supported architectures;
- migration is backup-first, resumable, and rollback-tested;
- browser primary workflows meet mobile accessibility checks;
- resource soak demonstrates bounded memory, descriptors, storage, and queues;
- current guided-workflow receipts and authority tests have equivalent coverage;
- operational documentation includes recovery from incompatible workers and corrupt local state.

## 16. Decision record

- **Language:** OCaml for native services and shared domain logic.
- **Browser language:** OCaml or Reason syntax compiled by Melange through Dune.
- **Concurrency:** structured concurrency within a process; OS supervision between lifecycle domains.
- **Persistence:** SQLite WAL with one explicit owning process per database.
- **Harness boundary:** ACP baseline plus negotiated capabilities; MCP/PISS extensions for specialized features.
- **Deployment:** immutable Nix generations; API and workers upgraded independently.
- **Migration:** tracer-bullet replacement, not horizontal big-bang parity work.

The architecture—not the implementation language alone—provides the primary stability guarantee. OCaml is chosen to make the state machines and trust boundaries explicit, reviewable, and difficult to represent incorrectly.
