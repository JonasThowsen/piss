# PISS architecture

Status: **accepted and implemented foundation**.

PISS is the primary interface and lifecycle owner for Pi. Pi remains the coding harness and durable session format; PISS adds secure remote ownership, supervision, organization, and a browser interface.

## Product boundary

PISS is a Pi-native remote workspace, not a generic IDE. It owns:

- trusted workspace registration;
- Pi process lifecycle;
- browser authentication and command routing;
- session discovery, status, and attention state;
- web views of Pi messages, tools, queues, statistics, review data, extension UI, and durable guided workflows.

It does not own a general-purpose terminal, arbitrary browser-triggered process execution, provider-neutral agent adapters, or collaborative editing.

## Domain model

```text
Host
└── Workspace
    ├── trusted root and launch policy
    └── Sessions
        ├── one durable Pi JSONL transcript
        └── zero or one active Runtime
```

A **workspace** is a PISS-owned registration of an explicitly authorized root. A **session** is a durable Pi conversation associated with one workspace. A **runtime** is an ephemeral Pi process generation with RPC transport and live state. Runtime identity is never used as durable session identity, and one session has at most one writable runtime.

Standard Git checkouts and registered worktrees can be workspace roots. Browser-managed worktree creation is a future workflow.

## Process model

```text
Browser ── HTTPS ── PISS server ── JSONL stdin/stdout ── pi --mode rpc
```

The server owns multiple Pi RPC child processes. RPC exposes prompts, queues, models, compaction, statistics, extension commands, and interactive extension requests while retaining process isolation per active session.

Pi JSONL files are transcript truth. PISS stores bounded ownership metadata, workspace registrations, accepted command IDs, notification subscriptions, durable guided-workflow state, and ephemeral runtime projections. Workflow progress, guidance delivery, authority decisions, checkpoints, and operation receipts also have bounded timeline records so startup can reconcile a metadata/timeline crash window before dispatching the first incomplete safe boundary. A persisted timeline high-water sequence makes repeated startup reconciliation idempotent. Each phase run retains every accepted event ID up to a fail-closed 4,096-event boundary, resets the ledger only when a replacement phase run starts, and never evicts an ID that could make an old duplicate mutating again. Current workflow events must exactly identify their phase run, plan revision, and runtime generation; supervisor advice additionally binds to one stable consultation and workflow revision. Receipt-required operations have one dossier-bound idempotency key and monotonic receipt; commits, pushes, migrations, deployments, and production writes require this policy inherently, while consequential generic commands/writes declare it explicitly. A durable `started` boundary and completion evidence are mandatory, invalid receipt events cannot contribute slice/criterion progress, completed receipts are never evicted or redispatched, and an unresolved operation blocks phase success or becomes an explicit restart reconciliation blocker. Phase dispatch failures use a server-owned fixed retry budget before durable supervisor adjudication. If Pi settles after tool execution without a displayable assistant response, PISS requests the missing final response once. An unexpected or forced server restart stops direct children and resumes durable sessions in a new runtime generation; runs interrupted while working receive a transcript-aware continuation prompt. Declarative server updates avoid that recovery path by remaining staged until every runtime is quiescent. Transparent survival of the exact in-flight tool process across arbitrary control-plane replacement remains deferred.

## Effect architecture

The server uses a pinned Effect 4 beta. Domain operations return typed `Effect` values, capabilities are declared with `Context.Service`, implementations are assembled with `Layer`, and unknown data is decoded with `Schema` at trust boundaries.

```text
shared/                    Effect schemas and shared state rules
server/
├── config.ts              validated environment configuration
├── workspaces/            authorization, discovery, and persistence
├── runtimes/              Pi process supervision and durable resume
├── files/                 authorized file mention search
├── reviews/               bounded Bubblewrap Git review
├── notifications/         persisted Web Push delivery
├── http.ts                authenticated Node HTTP adapter
└── main.ts                layer assembly and runtime edge
web/                       React client and PWA worker
```

Node HTTP, filesystem, process, and sandbox APIs remain in infrastructure services. React components render state and initiate use cases; Effect Schema decodes server responses at the browser boundary.

The guided engineering workflow treats the approved specification as its completion boundary. Define and Plan are conversational: Pi can publish durable drafts and focused questions while the operator guides refinement. There is no authority-granting specification gate. One final **Approve & Run** dossier binds the complete specification, ordered delivery slices, readiness results, and typed operations—including bounded target, explicit constraints, recovery, and evidence—to an immutable plan revision and digest.

PISS owns the durable Define → Plan → Build → Verify → Review state machine and bounded Repair loop. Structured RPC workflow events are applied in arrival order through the session mutation semaphore; phase-run, current-phase, runtime-generation, revision, event, and mutation identities make duplicates harmless and reject stale work. Phase transitions close the prior run before accepting more structured output, and the control plane allocates monotonic plan revisions for scope-changing replanning. Every public workflow mutation carries a stable mutation ID and compare-and-set workflow/revision/phase identity; guarded browser mutations reuse that exact ID for bounded transient HTTP replay. The workflow stores factual dossier-validated slice/criterion evidence, queued/delivered/applied guidance, authority decisions, server-owned transient retry state, and operation receipts. Guidance remains queued until Pi acknowledges delivery; after a crash, PISS reconciles the stable guidance marker against Pi's durable user-message transcript before deciding whether to retry. A correlated PISS-owned confirmation is auto-answered only when its exact extension-owned tool-call marker, workflow, active current phase run, plan revision, operation ID, kind, target, constraints, and any receipt-required idempotency key match the approved dossier and receipt state. Its allow decision is persisted before the positive extension response is released. Opaque or out-of-envelope requests remain human-visible. Skills report state but never own durable orchestration, and the browser never drives continuation timers.

Runtime stops reconcile an active workflow at a resumable boundary, preserving approved artifacts, progress, guidance, authority decisions, and operation receipts. Completed receipts are not redispatched; ambiguous started operations become `reconciliation_required` rather than being repeated. Replacement runtimes reject old-generation output and resume from the first incomplete safe boundary.

A Build, Verify, or Review blocker lazily starts one durable, read-only sibling Pi supervisor for that workflow. PISS sends it a bounded dossier containing the approved artifacts, blocker evidence, prior advice, and repeated-blocker state. Recoverable structured advice resumes the worker automatically; only `enter_repair` consumes repair budget. A request to reconfirm work inside the approved plan is recoverable uncertainty, while genuinely new authority or unsafe decisions remain blocked for the user as one plain-language problem. Durable Guide remains available during consultation. Recoverable blockers may expose Continue, while human-only authority blockers require explicit non-secret input or replanning and never offer generic continuation. Technical adjudication stays available in collapsed details. Repeated blocker fingerprints have a hard consultation limit, and the control plane—not either agent—owns every transition.

## Deployment architecture

The flake exposes:

- `piss-server`, the runtime-owning process;
- `piss-web`, the independently updatable browser shell;
- `piss`, a combined package used by the default app and build checks;
- `nixosModules.default`, the sole NixOS module.

The module exposes one canonical `services.piss` service on loopback. An independent userspace Tailscale node supplies HTTPS and authenticated identity headers. The web package is linked through a stable `/etc/piss/public` path so browser-only releases do not restart active Pi runtimes.

Server units use a two-phase update handoff. A NixOS switch reloads the new unit definition but leaves the running control plane in place. A generation-specific activation unit sends `SIGUSR2`; the old control plane keeps serving and supervising until no session is starting, working, blocked on extension UI, compacting, or carrying queued/pending commands. It then exits cleanly, and systemd starts the staged generation. This trades immediate server activation for preservation of active work and keeps deployment itself non-blocking.

## Data ownership

| Data | Source of truth |
| --- | --- |
| Pi conversation and tree | Pi JSONL session file |
| Current Pi stream | owned runtime / RPC events |
| Workspace definitions | PISS state store |
| Workspace-to-session association | PISS state store |
| Runtime state | in-memory supervisor, reconciled with processes |
| Engineering workflow phase, approvals, and bounded artifacts | PISS state store |
| Browser drafts and outgoing tray | browser local storage |
| Browser reconnect view | bounded event projection and transcript reconstruction |

## Security invariants

- Production binds only to loopback and is exposed through the dedicated Tailscale Serve node.
- Browser access requires a Tailscale identity and an explicit allowlist by default.
- Mutations require a same-origin HTTPS request in production.
- Workspace roots are server-authorized; browser input cannot select an arbitrary working directory.
- Browser requests cannot supply arbitrary Pi CLI arguments.
- Project-local Pi resources require explicit workspace trust.
- Runtime-targeted commands include a generation token, and accepted command IDs are bounded and persisted.
- Image type, signature, count, and aggregate size are validated before RPC delivery.
- Git review uses fixed commands in a bounded, networkless Bubblewrap sandbox.
- API responses and private runtime data are never cached by the service worker.
- Tailscale Funnel and direct public exposure are unsupported.
