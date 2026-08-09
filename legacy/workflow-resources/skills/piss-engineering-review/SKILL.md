---
name: piss-engineering-review
description: Perform a final evidence-based review of the complete implemented and verified delivery plan. Use only when PISS starts Review in a durable engineering workflow.
license: MIT; incorporates review patterns from addyosmani/agent-skills and openai/codex
---

# PISS Engineering Review

Review the complete specification/plan against the actual diff and verification evidence.

1. Inspect the complete diff, relevant call sites, every slice/criterion, durable progress, operation receipts, applied guidance, and coverage map.
2. Check for omitted, deferred, stubbed, or TODO-only approved scope and for missing evidence.
3. Review correctness, architecture, security, performance, compatibility, accessibility, tests, and bounded model-visible context.
4. Call `piss_workflow_progress` with exact workflow/plan/phase-run identity for current review activity, criteria evidence, applied guidance IDs, condition, and next action.
5. Give each blocking finding a file/line, repair recommendation, affected slice, and criterion. Do not edit code in Review.
6. Plan approval remains standing authority for listed operations. Do not ask the operator to reconfirm them; use the exact approved operation ID if an internal extension insists on a structured authority check.
7. Call `piss_workflow_checkpoint` with exact identity and `stage: "review"`: `passed` only when every planned slice/criterion has durable evidence and no blocking finding remains; `failed` with all findings for Repair; `blocked` only for genuinely unavailable external evidence or a decision that changes approved scope.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
