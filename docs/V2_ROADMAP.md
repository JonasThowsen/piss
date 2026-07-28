# PISS V2 tracer roadmap

Each slice must produce one useful behavior through the production boundary before the next slice broadens it.

## Tracer 0 — parallel Effect control plane

**Behavior:** V1 and the Effect-based V2 workspace index run simultaneously under separate Tailscale hostnames.

**Acceptance:**

- both Nix packages build;
- both NixOS services can be enabled together;
- V2 binds to loopback on a distinct port;
- V2 has an independent Tailscale node, state directory, identity allowlist, and login command;
- the V2 browser decodes the workspace API with Effect Schema;
- a configured trusted workspace appears in the V2 UI;
- V1 source and runtime behavior remain unchanged.

## Tracer 1 — one owned Pi session

**Behavior:** From one trusted workspace, create a named or default-named Pi session without opening a terminal, then send its first prompt from the conversation composer.

**Acceptance:**

- PISS starts `pi --mode rpc` in the trusted workspace root;
- native Pi events render in the V2 timeline;
- prompt, steer, follow-up, and abort work;
- closing the browser does not stop the runtime;
- stopping the runtime preserves the Pi session file;
- stale-generation commands are rejected;
- process exit and malformed RPC output become typed, visible failures.

**At this tracer:** server-restart survival and worktrees were deliberately deferred; the later tracers below now cover durable resume and authorized existing worktrees.

## Tracer 2 — durable resume

**Complete:** A stopped owned session survives a control-plane restart, remains in its authorized workspace, and resumes the same Pi JSONL transcript in a new runtime generation.

Implemented production invariants:

- Pi's append-only session file remains transcript truth; V2 persists only bounded versioned ownership metadata and accepted command IDs.
- Metadata writes use a mode-0600 temporary file, file and directory `fsync`, and atomic rename; reads reject oversized, malformed, duplicate, non-regular, and symlinked state.
- Workspace device/inode identity is revalidated against the current authorized workspace registry.
- Resume accepts only a regular non-symlink Pi file beneath configured Pi session roots whose header `cwd`, session identity, and stored device/inode still match.
- Resume uses Pi's `--session` RPC startup, allocates a new runtime ID, rejects the stale generation, and reconstructs recent messages through `get_entries`.
- Durable client command IDs are recorded before RPC delivery and bounded, so a lost HTTP response or browser reconnect does not resend a command already handed to that generation.

**Known upgrade limitation:** V2 still owns Pi as a direct child. Graceful control-plane shutdown explicitly stops the child, records a recoverable stopped state, and preserves the transcript for manual resume. It does not yet keep an in-flight tool process running transparently across package replacement. A command accepted immediately before shutdown remains in the transcript but may have stopped partway through its work. Pending interactive extension requests are explicitly cancelled and reported when that child exits. Do not describe this as transparent worker reconnection.

## Tracer 3 — multiple sessions and attention

**Complete:** A workspace contains multiple independently named sessions and centrally defines starting, working, idle, blocked, finished, stopping, stopped, and crashed semantics. Navigation and runtime controls render text labels in addition to compact indicators; state changes are announced accessibly. Selecting a finished session sends a generation-checked server acknowledgement and persists the resulting idle state. New empty runtimes start idle, an agent settlement becomes finished, and a validated interactive request remains blocked until answered, cancelled, or timed out. Creation warns when another writable runtime is already using the checkout.

## Tracer 4 — Pi controls beyond chat

Add one vertical workflow at a time:

1. model and thinking level;
2. [complete] context, token, and cost statistics;
3. queue mode and pending messages;
4. [complete] manual/automatic compaction;
5. skills, prompt templates, and extension commands;
6. [complete] extension `select`, `confirm`, `input`, and `editor` requests;
7. tree navigation, labels, fork, and clone.

## V1 parity audit

Audited against the V1 server, Pi extension, browser client, push worker, and the current V2 production path. “Equal” describes parity only; where both clients omit a capability, the notes still call that out. A row moves out of **still missing** only after its real server/runtime boundary and browser behavior are tested.

| Routine workflow | V2 vs V1 | Evidence and remaining gap |
| --- | --- | --- |
| Session lifecycle and reconnect | **improved** | Browser reload is safe. V2 durably records owned sessions, serves browser-only releases from a separately updatable Nix package without restarting the runtime server, and automatically resumes sessions from the same validated Pi transcript after a server release. Runtime generations still reject stale or duplicate delivery. An in-flight tool can be interrupted by a server-binary update because Pi is still a direct child. |
| Prompt, steer, follow-up, abort, stop | **equal** | Typed V2 HTTP commands reach Pi RPC with runtime-generation checks; queue delivery and abort/stop have integration and browser coverage. |
| Model and thinking controls | **equal** | Both expose authenticated available models and supported thinking levels; V2 validates responses and permits changes only after settlement. |
| Attention states | **improved** | V2 centrally projects and persists starting/working/idle/blocked/finished/stopping/stopped/crashed, renders text labels on desktop/mobile navigation, announces changes, and generation-checks completion acknowledgement. |
| Notifications | **equal** | V2 explicitly opts devices into persisted Web Push, notifies once on finished/blocked/crashed, removes expired subscriptions, routes clicks by opaque session ID, suppresses the already-focused target session, and uses privacy-safe generic payloads. |
| Drafts | **improved** | V2 keeps bounded, per-session text and delivery-mode drafts, reconciles accepted sends against Pi events, and isolates delayed failures between sessions. |
| Images | **equal** | PNG/JPEG/GIF/WebP, four-image and 10 MiB aggregate limits, and recursive base64 redaction are preserved. |
| File mentions | **improved** | V2 adds authenticated workspace-scoped FFF search and desktop/mobile `@` pickers; V1 has no equivalent browser picker. |
| Copying | **equal** | Message/tool copying, denied-Clipboard fallback, focus restoration, and accessible feedback are covered. |
| Git review | **improved** | V2 uses an authenticated bounded Bubblewrap sandbox for standard repositories and registered worktrees, with read-only checkout/worktree/common metadata mounts, no network, dropped capabilities, sanitized Git behavior, cancellation, timeouts, and output/concurrency limits. |
| Worktrees | **equal** | V2 launches sessions in authorized existing worktrees and securely reviews staged, unstaged, and untracked changes from worktree roots or nested workspace paths. Browser-managed worktree creation remains a separate intentional workflow. |
| Context and cost | **improved** | V2 displays Pi's real context-window estimate, input/output/cache tokens, cost when reported, pending count, model, and thinking level in a compact collapsible panel; unavailable values remain explicitly unreported. |
| Compaction | **improved** | V2 invokes real manual compaction with lossy-context confirmation, progress/result/failure state, and post-compaction recalculation semantics, and controls Pi's actual automatic-compaction setting. |
| Extension UI requests | **improved** | V2 validates, bounds, queues, persists, and generation-correlates RPC `select`, `confirm`, `input`, and `editor` requests in an accessible mobile dialog. Refresh restores live requests; runtime loss explicitly reports their cancellation instead of silently hanging. |
| Installability/offline behavior | **improved** | V2 generates a versioned worker from the actual Vite bundle, atomically precaches every hashed JS/CSS entry plus the shell, never caches APIs/session data, preserves browser-local drafts offline, and applies complete builds only after an explicit idle-safe update action. |
| Mobile usability | **improved** | V2 has workspace/session creation, text-labelled attention, scoped accessible dialogs, compact model/review/usage controls, interactive prompts, notifications, offline drafts, IME-safe composition, and mobile mention picking. |

Remaining intentional differences and documented limitations:

- V2 reconstructs recent transcript messages from Pi's append-only entries after explicit resume, but it does not project every historical non-message event.
- Browser-shell updates do not restart the control plane. When the server binary itself changes, Pi is still a direct child: the session automatically resumes from its durable transcript, but an in-flight tool or interactive request cannot remain live after the old Pi process exits.
- V2 shows the authoritative pending count and the current-device outgoing tray. It does not create a second durable copy of queued prompt text; Pi's native `queue_update` remains visible in Events and the JSONL transcript remains conversation truth.

### Current parity floor

- [x] prompt, steer, follow-up, abort, and stop;
- [x] authenticated model selection and supported thinking levels;
- [x] native message and tool-event projection;
- [x] image attachment delivery;
- [x] message and tool-output copying;
- [x] persistent per-session text and delivery-mode drafts;
- [x] durable stopped-session resume and explicit recoverable routine-upgrade behavior;
- [x] deterministic attention states and interactive requests;
- [x] opt-in completion/attention notifications;
- [x] constrained Git review in standard repositories and real worktrees;
- [x] context/usage and compaction controls;
- [x] installable, update-safe offline shell.

## Production verification — 2026-07-28

Deployed through the separate NixOS flake with deploy-rs automatic rollback. Read-only Chromium smoke passed at desktop and 390×844 mobile viewports with authenticated workspaces, no page errors, an active generated service worker, and the install manifest. A live production Pi tracer created a session in a real registered worktree, projected its branch/model/events and deterministic finish state, captured Pi's lazily-created JSONL only after settlement, stopped, resumed the same transcript under a new runtime generation, and deleted cleanly. Both V1 and V2 remained healthy with no warning-level service logs after deployment.

## Production-safe PWA — complete

The manifest, icons, and generated worker ship in the production artifact. Vite injects the exact hashed JS/CSS entry list and a content-derived cache version; installation fails rather than publishing a partial build. The active worker serves one complete cached build until the user applies a waiting update, then removes old V2 and legacy V1-named shell caches. Only fixed shell paths are cached: API/auth/session responses, prompts, tools, images, and workspace data are excluded. Offline reload exposes a clear unavailable state and an editable browser-local draft, with sending disabled. The same worker handles private notifications.

## Context, usage, and compaction — complete

The session-details panel reads `get_session_stats` and `get_state`; it never estimates provider data. It handles absent cost/context values, shows queue counts, and stays compact on mobile. Manual `compact` is idle-only, confirms that active model context is lossy while preserving the JSONL transcript, persists running/success/failure state, and shows Pi's actual before/estimated-after token results. Automatic compaction uses `set_auto_compaction`, not a browser-only preference.

## Completion and attention notifications — complete

V2 uses a bounded, versioned, atomic subscription store and a user-action-only permission flow. Finished, blocked, and crashed transitions send generic payloads without prompt text, tool output, workspace names, errors, or absolute paths. Delivery is deduplicated, expired endpoints are removed, failures cannot block a session, and notification clicks select the opaque session route. Notification and fixed-shell caching now share the generated PWA worker without caching private runtime data.

## Secure existing-worktree review — complete

V2 accepts both standard `.git` directories and strict registered-worktree gitfiles. It validates absolute/relative `gitdir`, `commondir`, and worktree back-pointers; requires the common `.git/worktrees/<name>` relationship; rejects symlinked critical metadata and unauthorized/unrelated paths; and holds checkout/Git directory handles across the Bubblewrap run to resist replacement races. Tests create real repositories with `git worktree add` and cover root/nested views, malformed and external gitfiles, metadata symlinks, cancellation, and staged/unstaged/untracked output.

## Tracer 5 — isolated worktree session

**Behavior:** Create a managed Git worktree and launch a session into it from the browser.

PISS must show the checkout and branch anywhere a destructive command can be sent.

## Tracer 6 — review and ship

**Behavior:** Review the owned session's changes, then perform constrained commit and push workflows. Arbitrary remote shell access remains out of scope.

The authenticated, workspace-scoped review path is complete. Constrained commit and push remain separate follow-up slices.

## Later hypotheses

These require usage evidence before architecture work:

- detached workers that preserve in-flight tools transparently across server-binary restarts (automatic durable resume is complete, and browser-only updates no longer restart runtimes);
- multiple remote hosts in one dashboard;
- a PISS MCP/extension capability through which one Pi can inspect or launch sibling sessions;
- shared tasks or scratchpads;
- read-only identities and device-specific permissions.

## Effect learning checkpoints

The implementation should intentionally introduce Effect concepts when a real slice needs them:

- **Tracer 0:** `Effect`, `Schema`, tagged errors, services, and `Layer`;
- **Tracer 1:** `Scope`, process acquisition/release, `Queue` or `PubSub`, and `Stream` for RPC events;
- **Tracer 2:** persistence service, retries, and explicit recovery errors;
- **Tracer 3:** `SubscriptionRef` or equivalent state projection and deterministic test layers;
- **Tracer 4:** typed request/response protocols and concurrent workflows;
- **Tracer 5:** transactions around worktree and runtime lifecycle.

Avoid introducing an Effect abstraction only to demonstrate it. Every service and layer should isolate a real capability or test boundary.
