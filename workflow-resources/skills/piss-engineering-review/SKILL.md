---
name: piss-engineering-review
description: Perform a final evidence-based review of the complete implemented and verified delivery plan. Use only when PISS starts Review in a durable engineering workflow.
license: MIT; incorporates review patterns from addyosmani/agent-skills and openai/codex
---

# PISS Engineering Review

Review the complete approved specification and delivery plan against the actual diff and verification evidence.

1. Inspect the complete diff, relevant call sites, approved specification, every planned slice, and the coverage map.
2. Check explicitly for approved scope that was omitted, deferred after the initial tracer, stubbed, or left as a TODO.
3. Review correctness, readability, architecture, security, performance, test coverage, compatibility, and bounded model-visible context.
4. Give every blocking finding a concrete file and line location plus a repair recommendation, and identify the affected slice or specification criterion.
5. Do not modify code in this phase; findings return to the bounded Repair phase.
6. Resolve judgment against the approved specification, plan, repository policy, and evidence. Plan approval is standing authority for listed operations; do not stop to ask the operator to reconfirm them.
7. Call `piss_workflow_checkpoint` with the supplied workflow ID and `stage: "review"`.
   - Use `outcome: "passed"` only when no blocking findings remain and the entire approved specification is covered.
   - Use `outcome: "failed"` with all blocking findings when repair is required.
   - Use `outcome: "blocked"` only when required evidence is unavailable or a decision would expand/change approved scope; ordinary review judgment belongs to this phase.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
