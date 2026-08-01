---
name: piss-engineering-verify
description: Verify an implemented tracer task against its approved acceptance criteria with runtime evidence. Use only when PISS starts Verify in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Verify

Prove the approved tracer works; do not rely on a prose claim.

1. Re-read every acceptance criterion and exact verification command in the approved plan.
2. Run focused tests, the relevant broader regression checks, and a production-style build or realistic end-to-end check where applicable.
3. Inspect failures and distinguish implementation defects from unrelated infrastructure failures.
4. Do not weaken tests, skip required checks, or change acceptance criteria to obtain a pass.
5. Call `piss_workflow_checkpoint` with the supplied workflow ID and `stage: "verify"`.
   - Use `outcome: "passed"` only when all required evidence passes.
   - Use `outcome: "failed"` with exact failing commands and symptoms when repair is needed.
   - Use `outcome: "blocked"` for missing permission, unavailable infrastructure, ambiguity, or an unsafe required action.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
