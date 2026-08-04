---
name: piss-engineering-build
description: Implement or repair the complete approved engineering delivery plan incrementally. Use only when PISS starts Build or Repair in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Build

Implement the complete approved plan. The first tracer is a starting increment, not the stopping condition.

1. Check the worktree and preserve unrelated changes. Follow local project instructions.
2. Reconcile the durable execution state, completed slices, evidence, operation receipts, and unapplied guidance before acting. Never repeat a completed receipt. For a `reconciliation_required` operation, inspect the approved system-of-record check or block—do not guess.
3. Work through every slice in dependency order. At each meaningful boundary call `piss_workflow_progress` with exact workflow/plan/phase-run identity, factual activity, current/completed slices, passed criteria/evidence, applied guidance IDs, condition/next action, and any operation receipt.
4. Before any dossier operation whose kind inherently requires a receipt or whose entry has `receiptRequired: true`, resolve any PISS-owned internal extension gate first by calling `piss_workflow_authority_request` with the exact approved operation ID, kind, bounded target, constraints, and dossier idempotency key. After that gate resolves and immediately before the side effect, record the `started` receipt with that exact dossier key; record `completed` plus evidence after success. Never invent alternate receipt keys. A pre-existing `started` receipt is an ambiguous execution boundary to reconcile, not a reason to request authority again.
5. Plan approval is standing authorization for every listed operation. Execute approved edits, tests, commits, pushes, migrations, deployments, and bounded production operations without asking again. Reconcile worker-authored prose gates; the structured authority request above exists only for an internal extension that technically requires a confirmation.
6. Never infer wider authority, fabricate credentials/evidence, or bypass external policy. Report a blocker only for new scope, unavailable capability/evidence, distinct external-role approval, or unsafe contradiction—not because approved work is consequential.
7. Keep completed slices working while broadening. Before completion compare progress with the plan coverage map; do not checkpoint after only the tracer.
8. Guidance must be applied at a safe boundary and acknowledged by its ID in the next progress/checkpoint. If guidance changes scope/authority, report that concretely rather than silently widening the plan.
9. On full implementation, call `piss_workflow_checkpoint` with exact identity, `stage: "build"`, `outcome: "passed"`, all applied guidance IDs, and a summary of every completed slice/focused check.
10. Use `outcome: "failed"` for implementation/repair defects needing another bounded repair. Use `blocked` only for a genuine human boundary.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
