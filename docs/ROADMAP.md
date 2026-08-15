# Piss tracer roadmap

Each slice must produce useful behavior through the production boundary before the next slice broadens it.

## Completed foundation

The current implementation proves these end-to-end paths:

- an authenticated browser creates or selects a trusted workspace;
- Piss starts `pi --mode rpc` in that authorized root;
- native messages and tool events render in the browser;
- prompt, steer, follow-up, abort, stop, and resume cross the real RPC boundary;
- session ownership metadata survives server restarts while Pi JSONL remains transcript truth;
- stale runtime generations and duplicate durable command IDs are rejected;
- multiple sessions project deterministic attention states;
- model, thinking, usage, queue, compaction, and interactive extension controls use Pi's real RPC methods;
- file mention search and Bubblewrap Git review remain scoped to the authorized workspace;
- Web Push and the offline shell avoid caching or transmitting private session content;
- browser-only Nix package updates do not restart runtime-owning server processes;
- server updates stage immediately but activate only after working, queued, compacting, interactive, and autonomous workflow phases settle;
- an authenticated user can conversationally refine a guided engineering workflow, choose a local/targeted/required disclosure boundary, receive a validated source-pinned read-only Research brief, grant revision-bound authority once through **Approve & Run**, and continue unattended through ordered Build → Verify → Review slices, bounded repairs, durable guidance/progress, exact structured authority checks, and independent read-only supervisor adjudication;
- an owned Pi session can use a Piss-managed, loopback-only Chromium context to inspect and interact with a local UI, publish validated PNG/WebM evidence, and use bounded keyboard, form, wait, viewport, page-info, and console-error tools.

These paths are covered by focused Node tests, an HTTP integration test with mock Pi RPC processes, Playwright browser coverage, and production-style Nix builds.

## Current limitations

- Pi is still a direct child of the control plane. Normal server deployments now wait for quiescence, but an unexpected crash or forced restart must resume a durable transcript and cannot preserve the exact in-flight tool process or interactive request.
- Transcript reconstruction restores recent conversation messages after resume, not every historical non-message event.
- The outgoing tray is device-local. Pi's native `queue_update` and JSONL transcript remain authoritative rather than duplicating queued prompt text in Piss storage.
- Existing registered Git worktrees are supported, but browser-managed worktree creation is not.
- Concurrent writable sessions in one checkout are warned about rather than automatically isolated.
- The guided engineering workflow persists structured research questions, source/finding provenance and Plan handoff IDs, slice/criterion evidence, immutable guidance submission bindings plus replacement-Plan carry targets, authority decisions, operation receipts, retained superseded-revision evidence, session-scoped start-mutation receipts, and a terminal cancellation identity. Research currently uses a hard read-only tool set inside the owned Pi session; isolated parallel research workers and managed source caches are deliberately deferred until a child-session tracer can preserve the same phase identity and replay guarantees. Bounded ledgers fail closed rather than evict replay/evidence safety state, while cancellation remains available at ordinary mutation capacity. Unsupported irreversible operations without an approved idempotency or system-of-record reconciliation method remain outside unattended authority.
- An unexpected control-plane restart replays bounded workflow progress, guidance-delivery, authority, checkpoint, and receipt records across the metadata/timeline crash window, then resumes from the first incomplete safe boundary. A completed dossier-bound receipt is not repeated or evicted; an ambiguous started receipt-required operation blocks with a concrete reconciliation requirement.
- Managed browser evidence remains intentionally short-lived and quota-bounded: recordings are silent VP8 WebM up to 60 seconds/50 MiB, with no generated poster, arbitrary JavaScript/selectors, external top-level navigation, or long-form retention policy.

## Next tracer — managed worktree sessions

**Behavior:** Create a managed Git worktree from the browser and launch a session into it.

**Acceptance:**

- the source repository and requested branch are validated inside an authorized workspace;
- worktree creation uses fixed arguments and bounded output;
- the resulting checkout is durably associated with its workspace;
- the new Pi runtime starts in that checkout;
- branch and checkout identity appear anywhere a destructive command can be sent;
- partial creation is cleaned up or surfaced as a recoverable state.

## Following tracer — constrained review and ship

**Behavior:** Review an owned session's changes, then perform constrained commit and push workflows.

The existing authenticated review path is read-only. Commit and push must remain explicit typed operations; arbitrary remote shell access stays out of scope.

## Later hypotheses

These require usage evidence before architecture work:

- detached per-session workers that preserve in-flight tools across unexpected or forced control-plane restarts and eliminate even the short quiescent deployment handoff;
- multiple remote hosts in one dashboard;
- a Piss capability through which one Pi can inspect or launch sibling sessions;
- shared tasks or scratchpads;
- read-only identities and device-specific permissions;
- complete projection of historical non-message transcript events;
- bounded metric-driven hypothesis experiments in managed worktrees, with immutable evaluation contracts and separate merge authority.

Introduce new capability services only when a real capability or test boundary requires them.
