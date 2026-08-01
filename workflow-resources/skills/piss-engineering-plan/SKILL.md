---
name: piss-engineering-plan
description: Convert an approved specification into a complete, verifiable delivery plan of ordered vertical slices. Use only when PISS starts the Plan phase of a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Plan

Plan the complete approved specification from the real repository. Do not implement yet.

1. Re-read the approved specification supplied by PISS and inspect relevant code and tests.
2. Treat the specification—not the first tracer—as the workflow's completion boundary.
3. Partition all approved scope into the smallest sensible sequence of vertical delivery slices. Use the first slice to prove the riskiest end-to-end assumption, then broaden through subsequent slices while keeping the system working.
4. Give every slice a stable ID, explicit acceptance criteria, dependencies, likely files, and exact verification commands.
5. Include a coverage map showing where every specification acceptance criterion is delivered and verified. Do not silently omit approved scope.
6. State irreversible or high-risk operations that require user approval. A deferral is valid only when the approved specification explicitly marks that work out of scope; do not defer work merely to keep the first tracer small.
7. Keep commit, push, migration, and deployment outside the delivery plan unless the approved specification explicitly permits them.
8. Call `piss_workflow_checkpoint` with the supplied workflow ID, `stage: "plan"`, `outcome: "ready"`, a concise summary, and the complete delivery plan Markdown in `artifact`.
9. Report `outcome: "blocked"` when the specification is too ambiguous or unsafe to cover completely.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
