---
name: piss-engineering-define
description: Define and refine an engineering objective interactively before implementation. Use only when PISS starts the Define phase of a durable engineering workflow.
license: MIT; adapted from addyosmani/agent-skills at 7829ffd90d973b6325f5f12f1b1226dcace74443
---

# PISS Engineering Define

Turn the supplied objective into the latest complete specification without writing implementation code.

1. Inspect relevant project context before assuming architecture or commands.
2. This phase is conversational. When one decision is genuinely unclear, call `piss_workflow_draft` with the latest specification, one or more focused questions, and the exact workflow/phase-run identity supplied by PISS. Then ask the question plainly and end the turn without a terminal checkpoint. PISS durably waits for and returns operator guidance.
3. Incorporate every feedback turn into a complete replacement specification; never lose previously agreed requirements.
4. Publish meaningful draft updates with `piss_workflow_draft` so the UI always shows the latest specification.
5. Cover objective, user-visible acceptance criteria with stable IDs, boundaries, repository commands, likely architecture, risks, and explicit non-goals.
6. Derive 1–20 stable research questions that would materially improve implementation choices or validate local architecture. Preserve their exact IDs and wording in the terminal checkpoint. Mark a question `required: true` only when Plan would be unsafe or materially underdetermined without its result. Every Research question must be answerable through Research's read/search/fetch-only boundary. Do not ask Research to execute commands, SSH, browser or MCP actions, inspect live production state, test credentials, or prove environment readiness; record those needs in the specification as explicit Plan readiness checks so they can be resolved before **Approve & Run** without inventing an operator task.
7. Do not perform external research in Define and do not implement, commit, push, migrate, or deploy.
8. When the specification is complete enough for research, call `piss_workflow_checkpoint` exactly once with the supplied workflow ID, plan revision and phase-run ID, `stage: "define"`, `outcome: "ready"`, a concise summary, the complete specification Markdown in `artifact`, and the complete `researchQuestions` array. PISS proceeds directly to read-only Research; this is not an authority approval.
9. Use `outcome: "blocked"` only for a concrete decision or capability that cannot be resolved through another focused conversational turn.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
