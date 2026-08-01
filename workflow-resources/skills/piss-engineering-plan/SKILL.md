---
name: piss-engineering-plan
description: Convert an approved specification into the smallest verifiable vertical implementation plan. Use only when PISS starts the Plan phase of a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Plan

Plan from the approved specification and the real repository. Do not implement yet.

1. Re-read the approved specification supplied by PISS and inspect relevant code and tests.
2. Identify dependencies and the riskiest assumption.
3. Select one smallest useful vertical tracer task that crosses the real production boundaries.
4. Give the task a stable ID, explicit acceptance criteria, likely files, and exact verification commands.
5. State deliberate deferrals and irreversible or high-risk operations that require user approval.
6. Keep commit, push, migration, and deployment outside this tracer unless the approved specification explicitly permits them.
7. Call `piss_workflow_checkpoint` with the supplied workflow ID, `stage: "plan"`, `outcome: "ready"`, a concise summary, and the complete one-task plan Markdown in `artifact`.
8. Report `outcome: "blocked"` when the specification does not support a safe plan.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
