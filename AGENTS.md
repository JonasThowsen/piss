# Agent guide

`docs/ARCHITECTURE.md` is authoritative. Read it before changing process,
persistence, protocol, lifecycle, or performance behavior.

## Fast path

1. Check `git status` and `git rev-parse HEAD`; do not overwrite another
   writer's work.
2. Choose the owning library before editing:
   - pure wire/domain: `shared/` (`piss.shared`)
   - SQLite policy: `src/lib/sqlite_support.*` (`piss.persistence`)
   - worker ledger: `src/lib/store.*` (`piss.worker-store`)
   - control registry: `src/lib/registry*` (`piss.registry*`)
   - workspace filesystem: `src/lib/workspace_io.*` (`piss.workspace-io`)
   - worker runtime: `src/worker/`
   - control/HTTP/broker: `src/control/`
   - browser domain/UI: `web/`
3. Do not add a production dependency on `piss.core`; it is compatibility-only.
4. Preserve JSON and SQLite text at adapters. Use validated
   `Domain.{Session,Worker,Command,Request,Subscription}_id` modules and
   `Registry_domain` variants after decoding; unchecked ID constructors are not
   available. Add transitions rather than a new arbitrary state setter.
5. For a performance change, add a reproducible benchmark or deterministic
   work/byte bound first. Do not remove durability or fencing to win a benchmark.

## Required checks

Run from the repository root through Nix:

```bash
nix develop . -c just format-check
nix develop . -c just test
nix develop . -c just test-integration   # protocol/control/browser behavior
nix build .#piss --no-link
nix flake check -L
```

Use `nix develop . -c just bench-catalog` for the catalog fan-out benchmark.
For browser-only OCaml tests/builds, the `just` recipes enter `.#web`.

## Non-negotiable invariants

- Commit a command receipt before ACP dispatch; never redispatch an uncertain
  consequence automatically.
- Validate runtime target session/worker/generation and fail closed.
- One worker and one ledger own each active session; the registry owns catalog,
  workspace, and peer-work metadata.
- Schema migrations are forward, in-place, and owned by the store that reads
  the table. Never silently delete durable authority/history.
- Keep lifecycle mutations under the per-session lock.
- Preserve loopback/auth/same-origin and canonical workspace boundaries.
- Keep event, HTTP, file-search, and initial-recovery work bounded. Catalog
  fan-out is work-conserving, max eight, with a one-second per-worker deadline.
- Only command-namespaced late ACP terminal evidence may reconcile an Ambiguous
  command, through the dedicated narrow API. Never reuse raw external IDs as
  internal ACP request IDs.

## Where to test

- `src/test/core_test.ml`: IDs, domain transitions, SQLite migrations/store.
- `src/control/audit_test.ml`: lifecycle/process and audit boundaries.
- `src/control/parallel_map_test.ml`: bounded catalog fan-out.
- `src/test/*.sh|*.py|*.mjs`: native integration/browser contracts.
- `web/*_test.ml`: browser decoding, projection, buffering, policy.

Never commit, push, deploy, alter credentials, or run authenticated model tests
unless the user explicitly requests it.
