---
name: piss-engineering-plan
description: Convert an approved specification into a complete, verifiable delivery plan of ordered vertical slices. Use only when PISS starts the Plan phase of a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Plan

Plan the complete latest specification from the real repository. Do not implement yet.

1. Re-read the specification and validated research brief, then inspect relevant code/tests. Treat the specification—not the first tracer—as the completion boundary. Use research as evidence, not as permission to widen scope.
2. This phase is conversational. For any unresolved product/safety choice, call `piss_workflow_draft` with the latest specification, plan, structured dossier if available, and focused questions; then ask plainly and end without a terminal checkpoint. Incorporate every feedback turn into complete replacement artifacts.
3. Partition all scope into ordered vertical slices. Every dependency must appear earlier than its dependent slice. The first proves the riskiest end-to-end assumption; later slices complete every criterion while keeping the system working.
4. Apply every research finding marked `adopt` or `adapt`, preserving its stable finding ID in the plan rationale. Explain any necessary local adaptation. Do not apply `reject` findings as recommendations.
5. Give each criterion, slice, operation, readiness check, and verification step a stable ID/description. Include dependencies, likely files, exact commands, and a coverage map.
6. Treat **Approve & Run** after this phase as the one final interactive authority checkpoint. Do not add a separate spec-approval gate or later confirmations for approved operations.
7. Put an **Autonomy envelope** near the top. Represent every permitted operation in the checkpoint `dossier.operations` with a stable operation ID, kind, bounded target, explicit constraints, description, recovery, and required evidence. Every commit, push, migration, deployment, or production write requires a stable `idempotencyKey`. Mark a generic `command` or `workspace_write` as `receiptRequired: true` and give it a stable `idempotencyKey` whenever repeating it after a crash could cause a second side effect. Every declared key must be unique. Pre-allocate bounded repair/convergence operations with stable IDs and keys whenever verification may legitimately discover follow-up writes; never describe an open-ended per-batch operation that would force Build or a supervisor to invent child receipt identities later. List exclusions and recovery requirements. Keep commit, push, migration, deployment, and production mutation outside unless the specification explicitly permits bounded targets.
8. Perform non-mutating readiness checks covering the applicable repository, toolchain, browser, credentials/capabilities, targets, and evidence sources, with at least one recorded result. Give every readiness result a unique ID and record it in `dossier.readiness`. Put every unresolved choice/capability/external approval in `dossier.unresolved`; do not defer a foreseeable question into Build.
9. Publish substantial drafts with `piss_workflow_draft` so the UI always shows the current specification and plan.
10. Apply every queued or transcript-backed carry-forward guidance item to the replacement artifacts. Report every applied guidance ID in `piss_workflow_progress` or the terminal checkpoint. Never request **Approve & Run** while applicable guidance remains unacknowledged.
11. Call `piss_workflow_checkpoint` with exact workflow/plan/phase-run identity, `stage: "plan"`, `outcome: "ready"`, concise summary, complete plan Markdown in `artifact`, the complete structured `dossier`, every applied `adopt`/`adapt` research finding ID in `appliedResearchFindingIds`, and all guidance IDs applied by this Plan run.
12. Report `outcome: "blocked"` when unresolved readiness remains and no conversational turn can resolve it safely.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
