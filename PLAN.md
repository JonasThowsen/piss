# PISS — Pi sin sidecar — Project Plan

## 1. Summary

PISS will provide a private, mobile-friendly web interface for viewing and controlling Pi sessions running on a personal computer.

The primary use case is continuity away from the desk: start one or more Pi sessions locally, leave the computer running, then open a private URL on a phone to inspect progress and continue interacting with those same live processes.

The project should support two related kinds of sessions over time:

1. **Terminal-owned sessions** — ordinary Pi TUI processes started from terminals. A global extension bridges each process to the sidecar.
2. **Sidecar-owned sessions** — Pi RPC or SDK runtimes launched and managed by the sidecar itself. This can be added after the bridge-based workflow is stable.

The first version should focus on terminal-owned sessions. This gives immediate value without requiring users to replace their existing Pi workflow.

## 2. Goals

### Initial goals

- Detect all currently active Pi processes that have the bridge extension loaded.
- Present a dashboard showing session name, working directory, model, state, and last activity.
- Stream assistant output and tool activity into the web client.
- Display enough conversation history to understand the current task.
- Send a new prompt to an idle session.
- Send steering and follow-up messages to a running session.
- Abort an active agent operation.
- Upload images from the remote device and send them as native Pi image content with prompts, steering messages, or follow-ups.
- Recover cleanly when the browser, extension, server, or network reconnects.
- Work well on a phone-sized screen.
- Be safe to use through a private remote-access network.

### Later goals

- Start new Pi sessions from the web interface.
- Manage sidecar-owned Pi RPC processes.
- Switch, fork, clone, compact, and navigate session trees.
- Select models and thinking levels remotely.
- Display context usage, token totals, and cost.
- Handle extension confirmation/input dialogs in the web client.
- Send browser notifications when sessions settle or require attention.
- Support read-only accounts or device-specific permissions.

## 3. Non-goals

The first release will not attempt to:

- expose Pi safely to arbitrary public users;
- support concurrent collaborative editing;
- make one session writable from multiple independent Pi runtimes;
- infer whether a process is active solely by inspecting JSONL session files;
- reproduce every TUI command and rendering detail;
- expose hidden model reasoning by default;
- replace terminal multiplexers or remote shells;
- provide a hosted cloud service.

## 4. Constraints and relevant Pi behavior

### Sessions on disk are not a live-process registry

Pi stores sessions as JSONL files under its agent session directory. These files can enumerate saved sessions, but they do not reliably indicate whether a Pi process is currently running. The sidecar therefore needs live registration and heartbeat messages from each bridge extension.

### Existing TUI processes cannot simply become RPC processes

An unrelated server cannot attach RPC control to a Pi process that was launched in TUI mode. The extension must explicitly expose control of that running process to the broker.

### Do not open one session for concurrent writing

The sidecar must not open the same persisted session in a second writable Pi runtime while the terminal-owned process is active. The bridge sends commands to the existing process instead. Saved session files may be inspected read-only when necessary, but live state should come from the bridge.

### Extension lifecycle

Long-lived resources should not start in the extension factory. The bridge should connect during `session_start` and close during `session_shutdown`. Session replacement and `/reload` tear down the old extension runtime and create a new one, so registration and reconnection must be idempotent.

### Prompt delivery modes

When a session is idle, a normal user message can start a turn. While streaming, remote input must explicitly choose between:

- **steer** — delivered after the current assistant turn and its tool calls;
- **follow-up** — delivered after the agent has otherwise finished.

The web UI must make this distinction clear.

## 5. Proposed architecture

```text
                         private HTTPS/WSS
┌─────────────────┐      (for example Tailscale)      ┌────────────────────┐
│ Phone / browser │ ◄────────────────────────────────► │ Sidecar server     │
└─────────────────┘                                    │                    │
                                                       │ auth               │
┌─────────────────┐                                    │ session registry   │
│ Desktop browser │ ◄────────────────────────────────► │ event routing      │
└─────────────────┘                                    │ history cache      │
                                                       └─────────┬──────────┘
                                                                 │ local WSS/WS
                                ┌────────────────────────────────┼─────────────┐
                                │                                │             │
                         ┌──────▼──────┐                  ┌──────▼──────┐      │
                         │ Pi process A│                  │ Pi process B│      │
                         │ bridge ext. │                  │ bridge ext. │      │
                         └─────────────┘                  └─────────────┘      │
                                                                                │
                                                        future RPC-managed Pi ◄─┘
```

### 5.1 Bridge extension

A global Pi extension runs inside each Pi process. Its responsibilities are deliberately narrow:

- establish an authenticated outbound WebSocket connection to the local broker;
- register the current process and session;
- send heartbeat and status updates;
- forward selected Pi lifecycle events;
- accept a constrained set of commands from the broker;
- validate command shape and target session generation;
- cleanly unregister during session shutdown;
- reconnect with bounded exponential backoff.

The extension should not serve the web application and should not become the system-wide broker. Multiple Pi processes would otherwise contend for ports and server ownership.

### 5.2 Sidecar server

The server is one persistent user-level process. Its responsibilities are:

- accept bridge connections from local Pi processes;
- authenticate browser connections;
- maintain the authoritative in-memory live-session registry;
- route commands to the correct bridge connection;
- fan out session events to subscribed browsers;
- provide short reconnect buffers or snapshots;
- optionally enumerate saved sessions through Pi's `SessionManager` APIs;
- serve the compiled web client;
- record a security audit log without recording secrets unnecessarily;
- enforce rate, payload-size, and origin limits.

The server should be independently managed by systemd, launchd, tmux, or a direct command. On this machine, a systemd user service is the preferred production setup.

### 5.3 Web client

The frontend should be responsive and optimized for intermittent mobile use. Initial screens:

1. **Session dashboard**
   - active/idle/offline state;
   - session name;
   - cwd/project name;
   - selected model and thinking level;
   - last activity timestamp;
   - compact latest-message preview.

2. **Session detail**
   - conversation timeline;
   - streaming assistant text;
   - tool calls with collapsed output;
   - queued steering/follow-up messages;
   - prompt composer;
   - steer, follow-up, and abort actions;
   - reconnect/offline status.

3. **Settings/status**
   - broker status;
   - connected Pi processes;
   - authentication/session management;
   - protocol and application versions.

### 5.4 Shared protocol

The extension, server, and web client should share versioned TypeScript message definitions. Runtime validation is required at trust boundaries; TypeScript types alone are insufficient.

The protocol should distinguish:

- extension-to-server registration and events;
- server-to-extension commands;
- browser-to-server API commands;
- server-to-browser snapshots and incremental events.

Each envelope should include at least:

```ts
interface Envelope<T> {
  protocolVersion: 1;
  type: string;
  messageId: string;
  timestamp: number;
  payload: T;
}
```

Session-targeted commands should include both a stable session ID and a connection/runtime generation token. This prevents a delayed command intended for an old extension instance from being delivered after `/new`, `/resume`, or `/reload` changes the runtime.

## 6. Live session identity and presence

A process registration should include:

- random connection ID;
- per-runtime generation ID;
- process ID;
- Pi session ID;
- session file, if persisted;
- session name, if set;
- cwd;
- model provider and ID;
- thinking level;
- idle/streaming state;
- extension and protocol versions;
- host identifier, even if the first version supports one host only;
- startup timestamp and last activity timestamp.

The broker marks a session offline after a heartbeat grace period. It should retain the disconnected card briefly so the UI can explain a restart rather than making the session disappear immediately.

One Pi process can replace its active session. The extension lifecycle will disconnect and reconnect around replacement. The server should model that as the old runtime ending and a new runtime registering, even if the operating-system PID remains the same.

## 7. Initial protocol sketch

### 7.1 Bridge to server

- `bridge.hello`
- `bridge.heartbeat`
- `session.snapshot`
- `session.info_changed`
- `session.model_changed`
- `agent.started`
- `agent.settled`
- `message.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.updated`
- `tool.completed`
- `command.accepted`
- `command.rejected`
- `bridge.goodbye`

### 7.2 Server to bridge

- `command.prompt`
- `command.steer`
- `command.follow_up`
- `command.abort`
- `command.get_snapshot`
- `command.set_model` — later
- `command.set_thinking_level` — later

Every command should have a command ID and receive an acceptance or rejection result. Acceptance only means Pi accepted or queued the instruction; subsequent model/tool failures arrive as normal events.

### 7.3 Browser API

The browser protocol can closely mirror the internal messages but must not expose bridge credentials or unrestricted routing fields. It needs:

- list active sessions;
- subscribe/unsubscribe from one session;
- retrieve a current snapshot;
- submit prompt/steer/follow-up;
- abort;
- acknowledge server event cursor;
- list saved sessions later.

## 8. Event storage and resynchronization

The bridge connection is live and transient; the browser may sleep in the background. The protocol therefore needs a resynchronization strategy.

Initial strategy:

- server keeps a bounded in-memory ring buffer per active session;
- every routed event receives a monotonically increasing sequence number scoped to the runtime generation;
- browser stores its latest sequence number;
- after reconnect, browser requests events after that cursor;
- if the cursor has expired, server sends a fresh snapshot;
- finalized conversation history can be rebuilt from `ctx.sessionManager` by the bridge when asked;
- partial streaming state is included in the live snapshot where possible.

Persistent event storage is not needed initially. Pi's JSONL file remains the durable conversation record. The sidecar cache exists for transport recovery and UI performance, not as a second source of truth.

## 9. Security model

Remote Pi control is equivalent to privileged access to the host user account. Pi can run shell commands, edit files, read credentials available to the process, and invoke extension code. Security is therefore a core feature rather than deployment polish.

### 9.1 Network exposure

Initial production policy:

- bind the application server to `127.0.0.1` and reject non-loopback bind configuration;
- use Tailscale Serve as the only supported remote-access path;
- require Tailscale Serve identity headers and optionally restrict them with an explicit login allowlist;
- do not support Tailscale Funnel;
- do not bind directly to a public interface;
- use the HTTPS/WSS endpoint issued by Tailscale Serve;
- allow authentication bypass only through an explicit development-only environment flag.

### 9.2 Authentication

Even on a private network, require application authentication. The first implementation uses Tailscale Serve identity headers:

- require `Tailscale-User-Login` on browser HTTP and WebSocket requests;
- optionally restrict access with a configured login allowlist;
- trust these headers only because the server is loopback-bound and reachable remotely exclusively through Tailscale Serve, which strips client-supplied copies before adding its own;
- avoid bearer tokens in URLs and browser storage;
- reject browser requests without Tailscale identity outside explicit development mode.

The bridge uses a separate high-entropy local credential stored in a mode-0600 file. WebAuthn or an additional application session layer may be added later if the deployment model expands beyond Tailscale Serve.

### 9.3 Web protections

- strict WebSocket Origin validation;
- CSRF protection for state-changing HTTP routes;
- secure and HTTP-only cookies;
- restrictive Content Security Policy;
- no third-party scripts in the control interface;
- payload and image size limits, with MIME validation at both browser API and bridge boundaries;
- request rate limiting;
- structured validation for every command;
- no arbitrary server-side shell endpoint;
- redact credentials and sensitive headers from logs.

### 9.4 Bridge authentication

The bridge-to-broker connection should use a separate local credential, not the browser session token. The broker should reject remote bridge registration by default. Possible mechanisms:

- Unix-domain socket for same-host bridges; or
- loopback WebSocket with a file-based high-entropy token readable only by the user.

A Unix-domain socket is attractive for same-host security but may complicate cross-platform support. Start with loopback plus a protected token if implementation speed is more important, while keeping the transport abstraction narrow.

### 9.5 Dangerous operations

The UI should clearly show:

- which cwd a command targets;
- whether the session is currently running;
- whether input will steer or follow up;
- destructive tool calls and their results.

A later permission-gate extension can route confirmations to the browser, but the first version must not pretend that ordinary Pi TUI confirmations are automatically available remotely. If a workflow depends on a terminal-only dialog, the web UI should indicate that local interaction may be required.

## 10. Repository and package layout

Proposed initial structure:

```text
piss/
├── flake.nix
├── package.json
├── package-lock.json
├── README.md
├── PLAN.md
├── extensions/
│   └── index.ts
├── server/
│   ├── index.ts
│   ├── config.ts
│   ├── auth.ts
│   ├── bridge-server.ts
│   ├── browser-api.ts
│   └── session-registry.ts
├── web/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── app.tsx
│       └── components/
├── shared/
│   ├── protocol.ts
│   └── schemas.ts
├── dist/
│   ├── server.js
│   └── public/
└── scripts/
    └── install-service.sh
```

The Pi manifest will load only the bridge extension:

```json
{
  "name": "piss",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

The server and built frontend remain part of the same package/repository but are not Pi resources. Runtime dependencies belong in `dependencies`; development-only build tools belong in `devDependencies`.

For reliable Git installation, either commit production build artifacts or ensure all tools required to start the application are production dependencies. Committing `dist/` is likely simplest for this private project.

## 11. Service management

The sidecar should be one persistent service independent of any Pi process.

Preferred Linux deployment:

```ini
[Unit]
Description=PISS — Pi sin sidecar
After=network.target

[Service]
Type=simple
ExecStart=/nix/store/...-piss/bin/piss
Restart=on-failure
RestartSec=2
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

The actual service should use the correct Node path for the machine's environment. If the repository adopts a Nix flake, the service may instead execute a stable packaged derivation or wrapper. The installer must not assume `/usr/bin/node` exists on NixOS.

The bridge should tolerate the service being absent and reconnect later. Starting Pi must never fail merely because the optional sidecar is unavailable.

## 12. Configuration

Suggested user configuration file:

```text
~/.config/piss/config.json
```

Potential fields:

```json
{
  "host": "127.0.0.1",
  "port": 4317,
  "bridgeHost": "127.0.0.1",
  "bridgePort": 4318,
  "dataDir": "~/.local/state/piss",
  "allowedOrigins": ["https://piss.example.ts.net"],
  "showThinking": false
}
```

Separate browser and bridge listeners are optional but make trust boundaries clearer. A single listener with separate authenticated paths is simpler initially.

Secrets should live in permission-restricted files outside project configuration and should never be committed to Git.

The extension needs a small configuration source containing broker URL, bridge token path, and enabled/disabled status. It must not trust project-local configuration for a global remote-control bridge unless the project is explicitly trusted and the security implications are understood. Prefer user-level configuration only for the initial version.

## 13. Implementation phases

### Phase 0 — decisions and scaffold

Deliverables:

- initialize Git repository;
- choose Node and frontend versions;
- decide whether to add a Nix flake;
- create package manifest and TypeScript configurations;
- establish formatting, linting, and tests;
- define the versioned protocol package;
- add a minimal threat-model document or security section.

Exit criteria:

- extension can be loaded by Pi without side effects;
- server starts and exposes a health endpoint;
- frontend build renders a placeholder page;
- shared schemas are tested.

### Phase 1 — live presence

Deliverables:

- bridge connects on `session_start`;
- bridge unregisters on `session_shutdown`;
- heartbeat and reconnect behavior;
- broker registry with expiry;
- dashboard listing live sessions;
- session metadata updates for naming and model changes.

Exit criteria:

- launch three terminal Pi processes and see three cards;
- kill one process and see it become offline within the configured timeout;
- `/new`, `/resume`, and `/reload` do not leave duplicate live registrations;
- sidecar downtime does not interrupt Pi.

### Phase 2 — event streaming and history

Deliverables:

- forward message and tool lifecycle events;
- render text streaming incrementally;
- render tool calls and results in collapsible cards;
- current-session snapshot request;
- reconnect sequence/cursor support;
- mobile session-detail page.

Exit criteria:

- browser sleep/reconnect does not duplicate messages;
- tool updates correlate by tool-call ID;
- switching between sessions preserves independent views;
- large tool outputs are bounded in browser transport and rendering.

### Phase 3 — remote commands

Deliverables:

- normal prompts while idle;
- explicit steer and follow-up controls while running;
- abort action;
- command IDs and acceptance/rejection acknowledgements;
- optimistic UI only after acceptance semantics are clear;
- visible pending-message queue where available.

Exit criteria:

- prompt from phone starts an idle Pi turn;
- steer changes a running workflow at the expected boundary;
- follow-up waits until the agent finishes;
- abort stops an active operation;
- an image selected or captured on a phone is delivered as native Pi image content with its prompt;
- stale-generation commands are rejected.

### Phase 4 — secure remote deployment

Deliverables:

- authentication flow;
- secure session cookies;
- CSRF and WebSocket Origin enforcement;
- bridge-token generation and rotation commands;
- Tailscale Serve identity enforcement, login allowlist, and deployment guide;
- systemd user-service unit or generator;
- audit logging and secret redaction;
- explicit production configuration validation.

Exit criteria:

- unauthenticated clients cannot list sessions or open WebSockets;
- unapproved origins are rejected;
- bridge credential cannot be used as a browser credential;
- service is loopback-only and rejects missing Tailscale identity in production;
- access and image upload from a phone work through the Tailscale Serve URL.

### Phase 5 — operational polish

Deliverables:

- browser notifications;
- install/update documentation;
- service health and diagnostics UI;
- protocol compatibility warning;
- graceful server shutdown;
- retention limits and backpressure handling;
- automated integration tests with fake bridge clients.

### Phase 6 — sidecar-owned RPC sessions

Deliverables:

- spawn and supervise `pi --mode rpc` children, or use Pi's SDK directly;
- start a session for a selected cwd;
- route the existing web UI through a common session adapter;
- session switching, forking, cloning, compaction, model selection, and thinking-level controls;
- extension UI request/response support.

This phase should remain separate from the terminal bridge. A common interface can make both kinds of sessions look similar to the frontend while preserving different lifecycle and capability sets.

## 14. Testing strategy

### Unit tests

- protocol schema validation;
- authentication/session expiry;
- registry heartbeat expiry;
- event sequencing and cursor recovery;
- command routing and generation checks;
- redaction and log formatting.

### Integration tests

Use fake bridge and browser clients to test:

- registration and disconnect;
- server restart and bridge reconnect;
- browser reconnect with valid and expired cursors;
- command acceptance/rejection;
- out-of-order or duplicate messages;
- malformed and oversized payloads;
- slow browser backpressure;
- simultaneous sessions with identical cwd values.

### Pi integration tests

Run real Pi sessions with a safe test model or mocked provider to verify:

- extension lifecycle events;
- prompt, steer, follow-up, and abort behavior;
- session replacement;
- extension reload;
- model and session-name updates;
- tool streaming.

Tests must avoid modifying real project files or invoking destructive commands.

### Browser tests

- desktop and narrow mobile layouts;
- background tab reconnect;
- virtual keyboard behavior;
- long messages and tool output;
- accessibility labels and keyboard navigation;
- offline indicators;
- authentication expiry while a WebSocket is open.

## 15. Observability and failure behavior

The sidecar should make failures understandable without becoming noisy.

Server logs should include:

- startup and effective bind address;
- bridge registration/disconnection with non-secret identifiers;
- authentication events;
- command routing outcomes;
- protocol errors;
- bounded stack traces for internal failures.

The web UI should distinguish:

- browser disconnected from broker;
- broker connected but Pi bridge offline;
- Pi idle;
- Pi streaming;
- Pi retrying or compacting where observable;
- command rejected;
- local terminal interaction required.

The extension must fail open with respect to normal Pi operation: if the broker is down, Pi remains usable and the extension retries quietly.

## 16. UX principles

- Optimize for checking status quickly from a phone.
- Show project/cwd prominently to prevent commands going to the wrong session.
- Keep tool output collapsed by default but make errors obvious.
- Never hide whether a message is prompt, steer, or follow-up.
- Require a deliberate action to abort.
- Make reconnect state visible.
- Avoid rendering unbounded streaming content on every delta; batch UI updates.
- Treat session names as primary labels and cwd as mandatory secondary context.
- Avoid generic chat-app styling; this is an operational control surface.

## 17. Open design decisions

Decide during Phase 0:

1. **Frontend stack:** a small React/Vite client, another framework, or server-rendered HTML with minimal client code.
2. **Server framework:** Node HTTP primitives, Fastify, Hono, or another small framework.
3. **Runtime schema library:** TypeBox, Zod, or generated JSON Schema. TypeBox aligns with Pi extension conventions.
4. **Bridge transport:** loopback WebSocket first or Unix-domain socket from the beginning.
5. **Repository tooling:** npm workspaces versus one package with folders.
6. **Nix:** add a flake for reproducible Node tooling and a stable service wrapper, especially if deploying on NixOS.
7. **Build artifacts:** commit `dist/` for Git installation or introduce a reliable package build step.
8. **Authentication:** bootstrap token plus cookie versus immediate WebAuthn/passkey support.
9. **History representation:** raw Pi messages versus a normalized sidecar view model.
10. **Thinking content:** omit entirely by default or expose behind an explicit local setting.
11. **Image transport:** base64 inside the authenticated command envelope initially, with strict decoded-size limits and native Pi `ImageContent` delivery; move to short-lived upload handles only if measured payload or memory pressure warrants it.

Recommended initial choices:

- TypeScript throughout;
- React/Vite for the web client;
- Fastify or Node plus a narrowly scoped WebSocket library for the server;
- TypeBox schemas shared across components;
- npm workspaces only if separation becomes useful;
- loopback WebSocket with protected bridge token initially;
- Tailscale Serve identity headers with an optional login allowlist;
- native image content in Phase 3 with a conservative decoded-size limit;
- omit thinking content by default;
- add a Nix flake if this machine's normal development workflow benefits from it.

## 18. Definition of the first useful release

Version `0.1.0` is useful when:

- the repository installs as a local or Git Pi package;
- its global extension automatically registers each active Pi process;
- one persistent sidecar service shows all active sessions;
- a phone can open the dashboard through Tailscale Serve;
- session activity streams reliably;
- the user can prompt, attach phone images, steer, follow up, and abort;
- reconnects and session replacement do not create stale control paths;
- the service is authenticated, loopback-bound by default, and documented;
- normal Pi operation is unaffected when the sidecar is unavailable.

## 19. Current implementation status and next steps

The first implementation now includes the package scaffold, shared protocol, authenticated loopback server, global bridge extension, structured mobile web client, native image delivery, prompt/steer/follow-up/abort routing, Tailscale Serve identity enforcement, bounded in-memory session events, reconnect behavior, and a hardened systemd user-service installer.

Next hardening work should proceed against real daily use rather than replacing this implementation with a prototype:

1. Validate lifecycle behavior across multiple real Pi processes, including `/new`, `/resume`, and `/reload`.
2. Add automated integration fixtures that run a real Pi test session in addition to the fake bridge protocol tests.
3. Preserve and replay browser event cursors across sleep/reconnect instead of always rebuilding from a snapshot.
4. Normalize the history view model and keep tool cards in exact conversation order.
5. Add browser notifications and explicit attention/permission states.
6. Package a stable Nix derivation or Home Manager module if service deployment needs to be reproduced across machines.
7. Add bridge-token rotation and audit-log inspection commands.
