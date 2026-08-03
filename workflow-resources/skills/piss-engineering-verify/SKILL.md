---
name: piss-engineering-verify
description: Verify the complete implemented delivery plan against the approved specification with runtime evidence. Use only when PISS starts Verify in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Verify

Prove the complete approved specification works; do not rely on a prose claim or evidence from only the first tracer.

1. Re-read every specification acceptance criterion, every planned slice, the coverage map, and the exact verification commands.
2. Confirm that no approved slice or criterion remains deferred, stubbed, or represented only by a TODO.
3. Run slice-level checks, the relevant broader regression suite, and a production-style build or realistic end-to-end check where applicable.
4. Exercise the full user-visible journey and real boundaries required by the specification, not only the initial tracer path.
5. Inspect failures and distinguish implementation defects from unrelated infrastructure failures.
6. Plan approval remains standing authorization for every verification operation and side effect explicitly listed in the plan. Do not request another confirmation for approved production checks or bounded operations.
7. Do not weaken tests, skip required checks, or change acceptance criteria to obtain a pass.
8. Call `piss_workflow_checkpoint` with the supplied workflow ID and `stage: "verify"`.
   - Use `outcome: "passed"` only when all approved scope has passing evidence.
   - Use `outcome: "failed"` with exact incomplete slices, failing commands, and symptoms when repair is needed.
   - Use `outcome: "blocked"` only for a concrete missing capability, unavailable required evidence, new ambiguity outside the approved plan, or an unsafe contradiction—not for permission already granted by Plan approval.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
