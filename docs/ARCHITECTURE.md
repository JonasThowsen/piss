# Piss architecture

This is the authoritative guide for ownership, invariants, flows, persistence,
performance budgets, extension work, tests, and deployment.

## 1. Process topology

```text
Bonsai/js_of_ocaml browser
  | authenticated same-origin HTTP; resumable SSE
  v
pissd control plane (replaceable)
  | one owner-only Unix socket per active session
  v
piss-session-worker (one supervised process + SQLite ledger per session)
  | ACP v1 JSON-RPC over stdio
  v
pi-acp / codex-acp / opencode ACP
  |
  +-- piss-session-mcp -> authenticated pissd broker -> peer workers
```

The control plane owns the catalog and coordination, not an active agent turn.
A session worker owns its ACP child, command receipt ledger, event spool, runtime
fence, and live waiters. The browser is a projection and never the authority for
command completion. The deterministic mock agent is test-only.

## 2. Compiler-enforced source ownership

`dune-project` disables implicit transitive dependencies, so every target must
declare the owner it imports. Dune public seams in `src/lib/dune`:

| Library | Owner | May depend on |
| --- | --- | --- |
| `piss.shared` | pure IDs, states, JSON/wire and ACP shapes | `yojson` |
| `piss.persistence` | common SQLite connection policy only | `sqlite3` |
| `piss.worker-store` | worker schema, migrations, event/command ledger | shared, persistence |
| `piss.registry-domain` | pure registry lifecycle algebra | nothing |
| `piss.registry` | catalog/workspace/peer SQLite schema and transitions | registry-domain, persistence |
| `piss.workspace-io` | bounded canonical filesystem operations | shared, Unix |
| `piss.origin` | origin pattern matching | nothing |

`piss.core` is a deprecated module-compatibility facade. It keeps the former
module paths available but is intentionally absent from every production and
test Dune dependency. Phase 2 deliberately removes unchecked ID constructors,
so downstream callers must migrate to validated `of_string` functions. `src/test/module_boundaries.sh` rejects a new bypass.
`Control_prelude` and `Worker_prelude` are target-private aliases, not public
ownership libraries. `Control_prelude` is compiled into the private
`control_audit` library; `Worker_prelude` is compiled only into the worker.
Dune still checks every declared direct dependency.

Do not add functors merely to hide dependencies. Add a library only when it
represents ownership, effect, or replacement boundaries.

## 3. Typed boundaries and state machines

### IDs

`Piss_shared.Domain` owns nominal `Session_id`, `Command_id`, `Request_id`, and
`Subscription_id`. Their `of_string` functions reject empty, overlong, or NUL
identities. JSON decoding validates before constructing wire requests; worker
protocol code converts to text only when calling SQLite/ACP adapters. Worker CLI
configuration stores validated nominal session/worker IDs, and broker adapters
retain validated request/subscription values until the explicit registry text
conversion. Existing databases remain compatible because SQLite rows already
store text and are compared against validated process identities; no unchecked
public legacy constructor is required.

Managed session path IDs have the stricter historical 3–64 lowercase
letter/digit/hyphen policy in `Lifecycle.valid_session_id`.

### Command lifecycle

```text
received -> accepted -> dispatched -> acknowledged -> completed
    |          |             |              |
    +-> rejected+-> cancelled/ambiguous/rejected
                         +-> completed/cancelled/ambiguous/rejected
```

`Domain.transition_command_state` is the pure validator. Terminal states never
reopen. SQLite's legacy administrative setter remains for migration/recovery
compatibility; normal runtime transitions should use validated transitions.
Acceptance is committed before ACP write. A crash in the dispatch ambiguity
window becomes `ambiguous`, never an automatic consequential retry. A late ACP
response may use only the dedicated evidence-backed reconciliation
`Ambiguous -> Completed|Cancelled|Rejected`; it cannot reopen or rewrite any
other terminal state. ACP prompt and mutation request IDs use disjoint internal
namespaces, and only a command-namespaced response is terminal command evidence.
External command/request IDs and wire shapes remain unchanged.

### Registry lifecycles

`Piss_registry_domain.Registry_domain` defines:

- session: `Active -> Finishing -> Archived`, with cancellation back to Active
  and explicit restore from Archived;
- peer request: Accepted/Queued -> Dispatching -> Dispatched -> Completed or
  Failed (with the existing dispatch retry edges);
- subscription: Pending -> Dispatching -> Delivered;
- session creation: Pending -> Launching -> Active, or Cleanup -> Failed.

The registry adapter decodes SQLite text into variants and raises on unknown
persisted values. Public records expose variants, so control code cannot compare
or invent arbitrary state strings. `Registry.session_lifecycle` projects the
`archived_at`/`finishing_at` columns algebraically. Transition SQL remains
compare-and-set so concurrent fibers cannot bypass allowed predecessor states.

## 4. Persistence and migrations

Two SQLite authorities exist:

1. **Registry database** (`Registry`): workspaces, active/archived sessions,
   broker tokens, creation/finish fencing, peer requests/subscriptions, durable
   observation cursors, and catalog revision.
2. **Per-session worker database** (`Store`): runtime identity/generation,
   command receipts/content/state, metadata, acceptance sequence, and event
   spool.

Both use WAL, `synchronous=FULL`, foreign keys, and a 5 s busy timeout through
`piss.persistence`. Schema and migrations remain with the owning store's
`initialize` function. Migrations use `CREATE IF NOT EXISTS`, column inspection,
and explicit backfills so old databases open in place. Never move a migration
into HTTP or lifecycle code, and never change existing table/JSON spellings
without a compatibility migration and fixture.

Command receipts are independently capped at 1,024 terminal-authority rows;
open receipts are not evicted. Events are capped at 65,536 ordinary rows while
listed durable boundary kinds are protected. Protected-history exhaustion
fails rather than silently deleting authority. Legacy unnamespaced ACP response
rows are not treated as command evidence after upgrade; an affected command
remains Ambiguous for explicit recovery rather than risking a same-text mutation
collision.

## 5. Request and event flows

### Browser command

1. HTTP authenticates Tailscale identity and same-origin JSON.
2. `Wire.request_of_yojson` validates target, nominal IDs, body/images/resources.
3. Control holds the per-session lifecycle lock and writes a bounded frame to
   the selected worker socket.
4. Worker atomically validates the runtime target and accepts/deduplicates the
   command receipt.
5. Worker records Dispatched, writes ACP, and later records terminal events.
6. Browser resumes SSE by monotonic sequence and updates its bounded projection.

For Pi sessions, the adapter also translates the `pi-subagents` extension's
bounded `subagent-async` widget snapshot into
`session_info_update._meta.piAcp.subagents`. The worker persists that ACP
notification as ordinary, non-authoritative progress, and the browser projects
each top-level run into a stable delegated-work timeline card. These snapshots
may describe activity but never complete, reject, reconcile, or otherwise act
as evidence for a command receipt.

### Peer request

The broker durably accepts an idempotent request, claims dispatch with CAS,
forwards a normal targeted worker command, and observes byte-bounded event pages.
`observation_sequence`, partial response, and terminal observation persist after
each page. Subscriptions durably wake the source only after their any/all rule.

### Catalog

`GET /api/v2/sessions` reads registry rows, then obtains independent worker
snapshots with `Workers.summaries`. `Parallel_map` preserves order and limits
socket fan-out to eight cooperative fibers.

## 6. Performance budgets and benchmark

Budgets are part of correctness:

| Path | Budget |
| --- | --- |
| worker event page | max 500 rows and 8 MiB encoded target |
| browser automatic initial recovery | 4,096 events retained; notice + manual paging afterward |
| live browser map | 4,096 events with batched eviction |
| catalog snapshot fan-out | work-conserving max 8; independent 1 s deadline per worker |
| HTTP request body | 16 MiB |
| worker response frame | 32 MiB |
| Pi delegated-work snapshot | 32 KiB; 20 runs; 8 children/node; depth 3; strings 160 chars |
| workspace mention search | 5,000 entries, depth 12, 150 ms, 20 results, 64 KiB |
| command receipt authority | 1,024 terminal receipts; open receipts retained |

Reproduce the catalog benchmark:

```bash
nix develop . -c just bench-catalog
```

It runs 64 deterministic 10 ms summary operations through both the former
serial map and production bounded map, verifies result order, prints elapsed
milliseconds/speedup using the monotonic Eio clock, and applies a deliberately
wide 250 ms advisory budget. Deterministic focused tests prove max concurrency,
stable order, work conservation behind a stalled item, per-item timeout
fallback, and exception/empty/invalid-bound behavior without a CI wall-time
assertion. These are local scheduling benchmarks, not network throughput claims.

When changing performance, first record the old behavior with this or a new
reproducible fixture. Prefer row/byte/work limits to speculative rewrites. Never
weaken FULL durability, command fencing, authentication, or canonical-path
checks for latency.

## 7. Extension playbooks

### New harness

1. Add the fixed harness command in deployment/Nix policy; never accept an
   arbitrary shell command from HTTP.
2. Extend initialize/capability normalization in `src/worker/harness.ml` and
   `state.ml`.
3. Keep `protocol.ml` harness-neutral and ACP-shaped.
4. Add mock/integration parity and any authenticated conformance suite as
   opt-in.

### New HTTP route

1. Add a typed variant and pure parser in `src/control/routes.*`.
2. Decide user vs broker credentials and same-origin mutation policy.
3. Put managed effects in `managed_routes.ml`; generic proxy behavior in
   `http.ml`.
4. Decode IDs/body before registry/worker calls and return structured `Error.t`.
5. Add route unit tests and a real HTTP integration assertion.

### New command/mutation

1. Add a bounded `Wire.request` variant and codec validation.
2. Choose a nominal ID and durable idempotency receipt before allowing retries.
3. Add a pure state transition, then adapter CAS/update.
4. Handle ambiguity/restart explicitly; do not infer success from socket loss.
5. Cover duplicate, stale-target, crash-window, and old-wire compatibility.

### New event

1. Define stable kind/payload and decide whether it protects authority during
   retention.
2. Append only after the durable fact it represents.
3. Add browser decode/projection behavior and malformed-payload tests.
4. Verify pagination, SSE resume, replay filtering, and byte budgets.

## 8. Testing and deployment

Canonical checks:

```bash
nix develop . -c just format-check
nix develop . -c just test
nix develop . -c just test-integration
nix build .#piss --no-link
nix flake check -L
```

`just test-integration` boots control + worker + mock ACP and includes interaction,
session isolation, mention, replaceability, and Playwright browser suites. Use
`just test-codex` only with explicit permission because it consumes account
quota.

The flake builds immutable `pissd`, worker, MCP, mock fixture, and browser assets.
The host NixOS configuration owns Tailscale Serve, secrets, harness commands,
systemd template policy, and idle-worker cutover. Deploy through the host flake;
do not run mutable code or credentials from the package build. Worker services
are independently supervised and are not interrupted by a browser/control-only
activation.

## 9. Common traps

- Importing `piss.core` hides an ownership violation.
- Comparing registry lifecycle strings bypasses exhaustive matching.
- Treating browser state or SSE delivery as command authority is unsafe.
- Retrying after a lost response without a durable receipt duplicates work.
- Reading all 65,536 startup events blocks the browser; automatic recovery
  retains up to 4,096 accumulated events, surfaces a cap notice, and leaves
  manual paging available.
- Worker snapshots must stay inside the work-conserving eight-fiber pool and
  one-second per-worker deadline; never call an unbounded serial catalog path.
- One SQLite FULL commit per event is durable but expensive; batch only when an
  end-to-end benchmark and crash semantics prove a safe transaction boundary.
- Filesystem paths must be realpath-canonical and stay under configured roots.
- A control restart may replace sockets while workers continue; always fence by
  session + worker incarnation + runtime generation.

## 10. Concise file map

```text
shared/domain.*            nominal IDs, command/worker states, JSON domain
shared/wire.*              bounded control↔worker request decoder
src/lib/sqlite_support.*   common durable SQLite pragmas
src/lib/store.*            per-worker ledger/schema/migrations
src/lib/registry_domain.*  pure registry state machines
src/lib/registry*          control registry/schema/migrations
src/lib/workspace_io.*     bounded workspace filesystem adapter
src/worker/state.ml        abstract mutable runtime state
src/worker/protocol.ml     typed worker operation handler
src/control/routes.ml      pure HTTP routing
src/control/http.ml        auth/generic request and SSE adapter
src/control/managed_routes.ml managed control effects
src/control/workers.ml     lifecycle/catalog/runtime discovery
src/control/broker.ml      durable peer dispatch/observation
src/control/parallel_map.ml bounded catalog fan-out
web/history_loader.ml      bounded history/SSE orchestration
web/event_buffer.ml        bounded incremental browser projection
src/test/core_test.ml      store/registry/domain/migration tests
src/test/run_integration.sh production-style native/browser harness
src/bench/catalog_summary_bench.ml reproducible fan-out benchmark
flake.nix / justfile       build, test, package, benchmark entry points
```
