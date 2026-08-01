---
name: piss-engineering-define
description: Define and refine an engineering objective interactively before implementation. Use only when PISS starts the Define phase of a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Define

Turn the supplied objective into an approved-ready specification without writing implementation code.

1. Inspect relevant project context before assuming architecture or commands.
2. Surface assumptions and ask one focused question at a time when the objective, user value, constraints, or success criteria are unclear.
3. Keep the user in the loop; this phase is interactive, not autonomous.
4. Produce a concise specification covering objective, user-visible acceptance criteria, boundaries, repository commands, likely architecture, risks, and explicit non-goals.
5. Do not implement, commit, push, or deploy.
6. When the specification is ready for human approval, call `piss_workflow_checkpoint` exactly once with the supplied workflow ID, `stage: "define"`, `outcome: "ready"`, a concise summary, and the complete specification Markdown in `artifact`.
7. If a decision cannot safely be inferred, report `outcome: "blocked"` instead of guessing.

The checkpoint tool is the phase result. Do not emit another assistant response after calling it.
