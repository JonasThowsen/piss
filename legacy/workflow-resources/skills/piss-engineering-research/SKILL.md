---
name: piss-engineering-research
description: Investigate the approved specification through a bounded, read-only local and optional external research phase. Use only when PISS starts Research in a durable engineering workflow.
license: MIT
---

# PISS Engineering Research

Answer the exact Define research questions with opened-source evidence before Plan. Do not implement or modify the approved workspace.

1. Preserve every supplied research question ID and wording exactly. Inspect the relevant local repository files first.
2. Obey the supplied external research policy:
   - `local_only`: never send an external query or fetch an external URL. Cite local evidence as `workspace://repo-relative/path` sources.
   - `targeted_external`: use external research only where it materially reduces a question's uncertainty. If no external research tool is available, mark externally dependent questions `unsupported` and explain the capability gap.
   - `required_external`: every required question must be answered with at least one opened external source. If that cannot be done, finish with a blocked checkpoint.
3. Research is strictly read-only. Use only the active read/search/fetch tools. Do not call bash, edit, write, browser interaction, MCP, git mutation, commit, push, migration, deployment, or production tools. PISS enforces this tool boundary. If Define mistakenly supplied a question requiring command execution, credentials, environment preflight, or live production state, do not block and ask the operator to add tools or manually run commands. Under `local_only` or `targeted_external`, record the unavailable fact as `unsupported`, preserve the exact check as a mandatory Plan readiness item, and continue with `outcome: "ready"` when the remaining evidence safely supports planning. Plan owns non-mutating readiness checks before **Approve & Run**.
4. Never include secrets, customer data, private repository names, local paths, or proprietary objective text in an external query. Reduce queries to the minimum generic technical description needed.
5. Search broadly, then open the primary implementation or official documentation before citing it. Search-result snippets alone are not evidence. Prefer source code and official docs over commentary.
6. For every GitHub source, record the canonical HTTPS URL and the exact immutable 40-character commit SHA in `revision`. Do not cite a moving branch as evidence. For local evidence, use a repo-relative `workspace://` URL and `kind: "workspace"`.
7. Separate verified facts from inference. Every finding must cite opened source IDs and classify its confidence as `verified` or `inferred` and its planning decision as `adopt`, `adapt`, `reject`, or `context`.
8. Mark each question `answered`, `unsupported`, or `not_applicable`. An answered question requires at least one source and at least one finding. Unsupported is an explicit capability/evidence result, never a guess.
9. Produce a concise Markdown report containing the direct conclusions, question-by-question evidence, approach decisions, source ledger, and remaining uncertainty.
10. Finish exactly once with `piss_workflow_checkpoint`, the supplied phase identity, `stage: "research"`, and:
    - `outcome: "ready"` when the policy's coverage rules are satisfied;
    - `outcome: "blocked"` only when `required_external` coverage is unavailable or the read/search/fetch evidence is too contradictory to formulate a safe Plan readiness gate; unsupported live readiness under `local_only` or `targeted_external` proceeds to Plan instead of becoming an operator tool-configuration request;
    - the Markdown report in `artifact`;
    - the complete structured `researchBrief`.

Use an ISO timestamp available in context for `accessedAt` and `completedAt`; PISS replaces these with its authoritative receipt time when persisting the checkpoint.

The terminal checkpoint ends this phase. Do not emit another assistant response after calling it.
