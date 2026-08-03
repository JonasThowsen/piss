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
6. Treat Plan approval as the final interactive authority checkpoint before unattended execution. The approved plan grants standing authorization to perform every operation it explicitly lists, including commits, pushes, migrations, deployments, and production reads or writes. Do not insert later confirmation gates for listed operations.
7. Put an **Autonomy envelope** near the top of the plan that plainly lists permitted side effects, environments, data boundaries, rollback/verification requirements, and operations that remain outside scope. Perform non-mutating readiness checks for every required repository, service, browser session, credential-backed capability, deployment target, and evidence source without exposing secrets. Surface every unresolved choice, missing capability, required external approver, or unavailable safety prerequisite now as one consolidated Plan blocker; do not defer a foreseeable question into Build.
8. Keep commit, push, migration, deployment, and production mutation outside the delivery plan unless the approved specification explicitly permits them. When included, specify bounded targets and acceptance evidence precisely enough for unattended execution.
9. Call `piss_workflow_checkpoint` with the supplied workflow ID, `stage: "plan"`, `outcome: "ready"`, a concise summary, and the complete delivery plan Markdown in `artifact`.
10. Report `outcome: "blocked"` when the specification is too ambiguous or unsafe to cover completely.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
