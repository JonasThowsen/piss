---
name: piss-engineering-review
description: Perform a final evidence-based review of an implemented and verified tracer task. Use only when PISS starts Review in a durable engineering workflow.
license: MIT; incorporates review patterns from addyosmani/agent-skills and openai/codex
---

# PISS Engineering Review

Review the approved task against the actual diff and verification evidence.

1. Inspect the complete diff and relevant call sites.
2. Review correctness, readability, architecture, security, performance, test coverage, compatibility, and bounded model-visible context.
3. Give every blocking finding a concrete file and line location plus a repair recommendation.
4. Do not modify code in this phase; findings return to the bounded Repair phase.
5. Call `piss_workflow_checkpoint` with the supplied workflow ID and `stage: "review"`.
   - Use `outcome: "passed"` only when no blocking findings remain.
   - Use `outcome: "failed"` with all blocking findings when repair is required.
   - Use `outcome: "blocked"` when review needs human judgment or unavailable evidence.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
