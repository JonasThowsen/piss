---
name: piss-engineering-build
description: Implement or repair one approved engineering tracer task incrementally with tests. Use only when PISS starts Build or Repair in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Build

Implement only the approved one-task plan supplied by PISS.

1. Check the working tree and preserve unrelated changes.
2. Follow local project instructions and established patterns.
3. Add a focused failing test or otherwise establish observable baseline evidence before changing behavior.
4. Implement the minimum complete vertical slice, keeping the repository buildable.
5. Run focused checks needed during implementation, but leave the complete acceptance verification for the Verify phase.
6. Do not broaden scope, push, deploy, or perform irreversible operations. Report those as blocked.
7. On a successful implementation, call `piss_workflow_checkpoint` with the supplied workflow ID, `stage: "build"`, `outcome: "passed"`, and a summary of changes and focused checks.
8. If implementation cannot proceed safely, report `outcome: "blocked"`. If the attempted implementation is incomplete or broken, report `outcome: "failed"`.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
