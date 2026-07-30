# PISS tracer roadmap

Each slice must produce useful behavior through the production boundary before the next slice broadens it.

## Completed foundation

The current implementation proves these end-to-end paths:

- an authenticated browser creates or selects a trusted workspace;
- PISS starts `pi --mode rpc` in that authorized root;
- native messages and tool events render in the browser;
- prompt, steer, follow-up, abort, stop, and resume cross the real RPC boundary;
- session ownership metadata survives server restarts while Pi JSONL remains transcript truth;
- stale runtime generations and duplicate durable command IDs are rejected;
- multiple sessions project deterministic attention states;
- model, thinking, usage, queue, compaction, and interactive extension controls use Pi's real RPC methods;
- file mention search and Bubblewrap Git review remain scoped to the authorized workspace;
- Web Push and the offline shell avoid caching or transmitting private session content;
- browser-only Nix package updates do not restart runtime-owning server processes.

These paths are covered by focused Node tests, an HTTP integration test with mock Pi RPC processes, Playwright browser coverage, and production-style Nix builds.

## Current limitations

- Pi is still a direct child of the control plane. A server-binary update resumes a durable transcript and continues an interrupted working run in a new process, but the exact in-flight tool process or interactive request cannot remain live across replacement.
- Transcript reconstruction restores recent conversation messages after resume, not every historical non-message event.
- The outgoing tray is device-local. Pi's native `queue_update` and JSONL transcript remain authoritative rather than duplicating queued prompt text in PISS storage.
- Existing registered Git worktrees are supported, but browser-managed worktree creation is not.
- Concurrent writable sessions in one checkout are warned about rather than automatically isolated.

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

- detached per-session workers that preserve in-flight tools across server-binary restarts;
- multiple remote hosts in one dashboard;
- a PISS capability through which one Pi can inspect or launch sibling sessions;
- shared tasks or scratchpads;
- read-only identities and device-specific permissions;
- complete projection of historical non-message transcript events.

Introduce new Effect services only when a real capability or test boundary requires them.
