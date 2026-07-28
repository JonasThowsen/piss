# PISS V2 architecture

Status: **accepted foundation; implementation begins with the workspace tracer**.

V2 makes PISS the primary interface and lifecycle owner for Pi. Pi remains the coding harness and durable session format; PISS adds secure remote ownership, supervision, organization, and a browser interface.

V1 remains supported while V2 is built. Both applications run from the same repository but have separate entrypoints, packages, services, state directories, ports, and Tailscale nodes.

## Product boundary

PISS V2 is a Pi-native remote workspace, not a generic IDE.

It will own:

- trusted workspace registration;
- Pi process lifecycle;
- browser authentication and command routing;
- session discovery, status, and attention state;
- a web representation of Pi messages, tools, queues, trees, stats, and extension UI;
- optional worktree isolation for concurrent sessions.

It will not initially own:

- a general-purpose terminal or file editor;
- arbitrary process execution from the browser;
- provider-neutral agent adapters;
- GitHub or issue-tracker dashboards;
- collaborative multi-user editing.

## Domain model

```text
Host (future multi-host boundary)
└── Workspace
    ├── trusted root and launch defaults
    ├── zero or more Checkouts (a main checkout or Git worktrees)
    └── Sessions
        ├── one durable Pi JSONL session
        └── zero or one active Runtime
```

### Workspace

A stable PISS-owned project registration. Its root is explicitly trusted on the server. A workspace groups configuration, checkouts, and sessions; it is not itself a Git worktree.

### Checkout

A concrete working directory. V2 starts with the workspace root as its only checkout. A later slice can create managed Git worktrees so concurrently writing sessions do not modify the same checkout.

### Session

A durable Pi conversation associated with one workspace and checkout. Pi's JSONL file is the source of truth for conversation history and tree state. PISS stores only its own metadata and associations.

A session can be stopped without being deleted. It may have at most one writable runtime at a time.

### Runtime

The ephemeral execution of a session: process identity, runtime generation, RPC transport, live state, and event stream. Runtime identity must never be used as durable session identity.

## Process model

The first owned-runtime implementation uses Pi's existing RPC boundary:

```text
Browser ── HTTPS/WSS ── PISS V2 server ── JSONL stdin/stdout ── pi --mode rpc
```

RPC is the first adapter because it already exposes prompting, queues, models, compaction, session trees, statistics, extension commands, and extension UI. It also gives each active session process isolation.

The V2 application must depend on a `SessionRuntime` capability rather than directly on child-process APIs. This leaves room for a per-session worker or direct Pi SDK adapter if measured requirements justify either one.

Initially, a PISS server restart may stop owned runtimes while preserving their Pi sessions. A detached per-session worker is deferred until daily use demonstrates that runtime survival across server upgrades is worth the extra IPC and supervision boundary.

## Backend capability boundary

V1 terminal attachment and V2-owned runtimes can coexist behind one conceptual interface:

```text
SessionBackend
├── AttachedSessionBackend  # V1 extension bridge
└── OwnedSessionBackend     # V2 RPC supervisor
```

Capabilities are explicit. The web client must not assume that an attached V1 session supports every owned-session operation.

## Effect architecture

V2 uses Effect 4 beta from the beginning. This is a deliberate trade-off for a single-user project: learning and building against Effect's current architecture is more valuable than avoiding beta API changes. The dependency is pinned to an exact beta release so upgrades remain explicit and reviewable.

Effect 4 conventions:

- domain operations return `Effect<Success, Error, Requirements>`;
- services are declared with `Context.Service` and constructed with `Layer`;
- expected failures use tagged error values, not thrown exceptions;
- unknown input is decoded with `Schema` at every trust boundary;
- long-lived processes, sockets, and subscriptions are scoped resources;
- blocking or promise APIs are wrapped once in infrastructure adapters;
- mutable state is encapsulated inside a service implementation;
- React components render state and initiate use cases; they do not contain process or persistence logic;
- dependencies are replaced with test layers rather than module mocks.

Initial source layout:

```text
v2/
├── shared/              # Effect schemas and transport contracts
├── server/
│   ├── config.ts        # configuration service
│   ├── workspaces/      # workspace use cases and repository capability
│   ├── sessions/        # durable resume catalog (next)
│   ├── runtimes/        # supervised Pi RPC processes and controls
│   ├── http.ts          # Node HTTP adapter
│   └── main.ts          # layer assembly and runtime edge
└── web/                 # React client; Effect at API boundaries
```

The functional core must not import Node HTTP, filesystem, child-process, or WebSocket APIs. Those belong in infrastructure implementations.

## Data ownership

| Data | Source of truth |
| --- | --- |
| Pi conversation and tree | Pi JSONL session file |
| Current Pi stream | owned runtime / RPC events |
| Workspace definitions | PISS V2 state store |
| Workspace-to-session association | PISS V2 state store |
| Runtime state | in-memory supervisor, reconciled with processes |
| Browser reconnect cursor | Pi entry ID when durable; bounded event sequence while streaming |

The initial workspace tracer reads server-configured workspaces. A persistent state store is introduced with the first browser-created workspace rather than before a write path exists.

## Security invariants

- Production binds only to loopback and is exposed through its dedicated Tailscale Serve node.
- Browser access requires a Tailscale identity and an explicit allowlist by default.
- Workspace roots are server-trusted; a browser cannot submit an arbitrary cwd.
- Browser requests cannot supply arbitrary Pi CLI arguments.
- Non-interactive Pi project trust must be explicit. PISS must never silently pass `--approve` for an untrusted workspace.
- One Pi session file has at most one writable runtime.
- Runtime-targeted commands include a generation token to reject stale delivery.
- Concurrent writable sessions in one checkout require an explicit warning; managed worktrees are the safe path.
- Extension UI requests display their workspace and session identity before accepting input.
- Tailscale Funnel and direct public exposure remain unsupported.

## Parallel V1/V2 deployment

| Concern | V1 | V2 |
| --- | --- | --- |
| NixOS option | `services.piss` | `services.piss-v2` |
| Application service | `piss.service` | `piss-v2.service` |
| Default port | `4317` | `4318` |
| Tailscale hostname | `piss` | `piss-v2` |
| State directory | `~/.local/state/piss` | `~/.local/state/piss-v2` |
| Package binary | `piss` | `piss-v2` |

The independent Tailscale nodes make it possible to use V1 to work on V2 without replacing the production V1 deployment.
