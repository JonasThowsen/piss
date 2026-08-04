---
name: piss-engineering-verify
description: Verify the complete implemented delivery plan against the approved specification with runtime evidence. Use only when PISS starts Verify in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Verify

Prove the complete approved specification works; do not rely on prose or only the tracer.

1. Re-read every criterion, slice, coverage map entry, durable progress item, receipt, and exact verification command.
2. Reconcile completed verification evidence before repeating a side effect. Confirm no approved slice is deferred, stubbed, or represented only by a TODO.
3. Run slice checks, broader regressions, production-style build, and required real-boundary journey.
4. Call `piss_workflow_progress` with exact workflow/plan/phase-run identity for the current verification step, factual evidence, passed criteria, applied guidance IDs, condition, and next action.
5. Distinguish implementation defects from transient infrastructure/provider failures. Pi's bounded automatic retries do not consume repair budget; report persistent defects precisely for Repair.
6. Plan approval remains standing authorization for every listed verification operation. Do not request another confirmation for approved checks. Use `piss_workflow_authority_request` only if an internal extension insists, with the exact approved operation ID, kind, bounded target, and constraints.
7. Never weaken tests, skip required checks, or fabricate evidence.
8. Call `piss_workflow_checkpoint` with exact identity and `stage: "verify"`: `passed` only when all approved scope has evidence; `failed` with exact slices/commands/symptoms when repair is needed; `blocked` only for a genuine missing capability, external approval/evidence, new scope, or unsafe contradiction.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
