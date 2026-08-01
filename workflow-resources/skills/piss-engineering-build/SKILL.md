---
name: piss-engineering-build
description: Implement or repair the complete approved engineering delivery plan incrementally. Use only when PISS starts Build or Repair in a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Build

Implement the complete approved delivery plan supplied by PISS. The first vertical tracer is a starting increment, not the stopping condition.

1. Check the working tree and preserve unrelated changes.
2. Follow local project instructions and established patterns.
3. Work through the plan's vertical slices in dependency order. For each slice, establish focused baseline evidence, implement the smallest complete behavior, and run focused checks before continuing.
4. Keep completed slices working while broadening into the remaining approved scope.
5. Do not call the build checkpoint after only the first tracer. Before completion, compare the worktree against the plan's specification coverage map and implement every approved criterion.
6. Run focused checks needed during implementation, but leave complete acceptance verification for the Verify phase.
7. Do not push, deploy, or perform irreversible operations unless the approved specification explicitly permits them. Report required but unapproved operations as blocked.
8. On successful completion of the entire delivery plan, call `piss_workflow_checkpoint` with the supplied workflow ID, `stage: "build"`, `outcome: "passed"`, and a summary of completed slices and focused checks.
9. If implementation cannot proceed safely, report `outcome: "blocked"`. If the attempted implementation is incomplete or broken, report `outcome: "failed"` with the remaining or failing slices.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
