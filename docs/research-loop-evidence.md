# Research-loop implementation evidence

Research snapshot: 2026-08-04. Links are pinned to immutable commits. This document distinguishes local codebase exploration, external prior-art research, and metric-driven experimentation; the three solve different problems and should not be collapsed into one unbounded agent loop.

## Executive conclusion

No mainstream coding workspace inspected implements Piss's desired feature end to end. T3 Code, OpenCode, and Codex provide useful pieces—read-only planning, web-search events, and isolated subagents—but do not make external prior-art research a durable prerequisite of a delivery plan. Arbor is the closest architectural match: it combines source-grounded ideation, a durable hypothesis tree, isolated experiments, held-out evaluation, and checkpoint/resume.

The first Piss tracer should therefore add a durable **Research** phase between Define and Plan, not embed a general autoresearch extension. Research should produce a source-pinned brief that Plan must consume. Metric-driven hypothesis experiments can be a later, explicitly bounded mode built on managed worktrees.

## Evidence matrix

| Project | Shipped behavior inspected | Gap relative to Piss | Reusable lesson |
| --- | --- | --- | --- |
| T3 Code (`ece05087…`) | Plan mode permits non-mutating truth gathering and requires one targeted repository exploration pass before asking discoverable questions ([`CodexDeveloperInstructions.ts` L14-L62](https://github.com/pingdotgg/t3code/blob/ece05087a70e94efcd57441337fa1249559362ba/apps/server/src/provider/CodexDeveloperInstructions.ts#L14-L62)). Provider events are normalized so web tools and task/agent tools appear as `web_search` and `collab_agent_tool_call` activity ([`OpenCodeAdapter.ts` L286-L315](https://github.com/pingdotgg/t3code/blob/ece05087a70e94efcd57441337fa1249559362ba/apps/server/src/provider/Layers/OpenCodeAdapter.ts#L286-L315)). | Grounding is local and prompt-driven. T3 does not own a durable external-research artifact, source ledger, coverage gate, or research loop; it delegates those capabilities to its providers. | Keep research read-only before planning, and make research/subagent activity visible as typed timeline events rather than hiding it in prose. |
| OpenCode (`f516651…`) | Its Plan prompt directs up to three focused Explore agents to inspect existing implementations, related components, and tests before design ([`plan-mode.txt` L8-L26](https://github.com/anomalyco/opencode/blob/f51665191af10f1e4e0512af3708e9c2c58ecb8d/packages/opencode/src/session/prompt/plan-mode.txt#L8-L26)). The built-in Explore agent has a deny-by-default, read/search-oriented permission set that includes web fetch and web search ([`agent.ts` L196-L217](https://github.com/anomalyco/opencode/blob/f51665191af10f1e4e0512af3708e9c2c58ecb8d/packages/opencode/src/agent/agent.ts#L196-L217)). Task invocations create child sessions with derived permissions and can be resumed by task ID ([`task.ts` L92-L172](https://github.com/anomalyco/opencode/blob/f51665191af10f1e4e0512af3708e9c2c58ecb8d/packages/opencode/src/tool/task.ts#L92-L172)). | Findings return as subagent text and are not a typed, durable plan prerequisite. Current Plan instructions also describe a General-agent design pass while the built-in Plan permission set denies General tasks ([`agent.ts` L156-L180](https://github.com/anomalyco/opencode/blob/f51665191af10f1e4e0512af3708e9c2c58ecb8d/packages/opencode/src/agent/agent.ts#L156-L180)), illustrating how prompt-only phase orchestration can drift from enforcement. | Use focused parallel researchers only for independent questions; bind outputs to structured workflow state and enforce phase rules in the control plane. |
| OpenCode Scout experiment (`1e0246c…`, removed by `a639fe7…`) | OpenCode briefly shipped an experimental read-only `scout` specialist for external repositories. Its prompt required direct source/docs evidence, multiple-repository inspection, and explicit uncertainty ([`scout.txt` L1-L36](https://github.com/anomalyco/opencode/blob/1e0246cdc81c58d6ef533e928b047ea604f47eaf/packages/opencode/src/agent/prompt/scout.txt#L1-L36)). Scout received web/search/read plus managed `repo_clone` and `repo_overview` tools ([`agent.ts` L192-L218](https://github.com/anomalyco/opencode/blob/1e0246cdc81c58d6ef533e928b047ea604f47eaf/packages/opencode/src/agent/agent.ts#L192-L218)); clone targets were cached, locked, permission-gated, and returned a commit SHA ([`repo_clone.ts` L37-L139](https://github.com/anomalyco/opencode/blob/1e0246cdc81c58d6ef533e928b047ea604f47eaf/packages/opencode/src/tool/repo_clone.ts#L37-L139)). | The entire Scout agent and 925 lines of related tools/tests were removed shortly afterward ([removal commit](https://github.com/anomalyco/opencode/commit/a639fe7a08dfa27084685b808d4c44a086a5c20b), [PR #30435](https://github.com/anomalyco/opencode/pull/30435)). The removal gives no public product rationale, so none should be inferred. Current docs still mention Scout although current source no longer defines it. | A dedicated worker is useful, but cloning/search infrastructure should be a narrow capability behind a stable research contract—not a second loosely coupled workflow whose documentation and implementation can drift. Persist immutable source identity in Piss even if fetched bytes remain in a disposable cache. |
| OpenAI Codex (`e9a692d…`) | Codex has first-class `webSearch` and `collabToolCall` protocol items, including query/results and child-thread identities ([app-server `README.md` L1538-L1545](https://github.com/openai/codex/blob/e9a692d53ba55d981c353ced88650dd1595c2b5f/codex-rs/app-server/README.md#L1538-L1545)). Its Explorer role encourages multiple independent, reusable codebase investigations ([`role.rs` L361-L385](https://github.com/openai/codex/blob/e9a692d53ba55d981c353ced88650dd1595c2b5f/codex-rs/core/src/agent/role.rs#L361-L385)). Delegation guidance requires explicit user/skill authority, bounded non-duplicated subtasks, and parallelism only for independent questions ([`multi_agents_spec.rs` L710-L744](https://github.com/openai/codex/blob/e9a692d53ba55d981c353ced88650dd1595c2b5f/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L710-L744)). | Codex supplies primitives, not a mandatory source-grounded engineering phase or durable research-completeness invariant. | Piss should explicitly authorize research delegation in its workflow skill, cap it, preserve child/research identities, and avoid duplicate main-agent/subagent work. |
| Arbor (`65ffcc8…`) | Arbor stores each hypothesis with status, result, score/split, branch, prior-art annotation, and grounding citations in a durable Idea Tree ([`idea_tree.py` L28-L127](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/idea_tree.py#L28-L127)). Its external-research tool separates source-grounded ideation from a fresh post-experiment novelty audit, runs verbose search in isolated context, returns a compact digest, and drops citations to sources the search agent never opened ([`research_ctx.py` L1-L27](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/tools/research_ctx.py#L1-L27), [`research_ctx.py` L58-L100](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/tools/research_ctx.py#L58-L100), [`research_ctx.py` L103-L187](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/tools/research_ctx.py#L103-L187)). Experiments use isolated git worktrees and preserve branches after cleanup ([`worktree.py` L1-L6](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/tools/worktree.py#L1-L6), [`worktree.py` L58-L137](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/tools/worktree.py#L58-L137)). Checkpoints bind phase, tree, messages, git topology, in-flight executors, and pending human input and are written atomically ([`checkpoint.py` L45-L93](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/checkpoint.py#L45-L93), [`checkpoint.py` L130-L169](https://github.com/RUC-NLPIR/Arbor/blob/65ffcc8fdf23a64a781940e6a3cfb6369d6d887e/src/coordinator/checkpoint.py#L130-L169)). | Arbor assumes an objective metric and experiment harness. Ordinary product engineering often has multiple non-comparable criteria, so its hypothesis/merge loop cannot be made the default Piss workflow. | Adopt the durable evidence model, isolated search context, citation-integrity check, bounded budgets, and later worktree-based experiment mode. Keep delivery criteria—not a single score—as the ordinary workflow completion boundary. |
| Karpathy autoresearch (`228791f…`) | The minimal loop fixes one editable file, one immutable evaluator, one metric and time budget, logs every outcome, and keeps or resets each commit ([`program.md` L21-L39](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L21-L39), [`program.md` L64-L112](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L64-L112)). | It does not systematically search external projects, has no held-out gate, and assumes broad git autonomy. It is unsafe to embed directly in a dirty/shared Piss workspace. | Optimization must have a fixed measurable objective, immutable evaluation boundary, explicit scope, and isolation. It should be an optional mode, not the meaning of every engineering loop. |
| `opencode-workflow` (`4ba679d…`, small third-party plugin) | It makes Research a gated, repeatable phase before Plan and persists indexed research artifacts plus task metadata ([`README.md` L51-L96](https://github.com/chethann/opencode-tasks/blob/4ba679dad69067b3f6065f33944a7d5c31e526cd/README.md#L51-L96)). Its research template records relevant files, architecture, patterns, dependencies, risks, tests, and open questions ([`research.md` L7-L80](https://github.com/chethann/opencode-tasks/blob/4ba679dad69067b3f6065f33944a7d5c31e526cd/commands/research.md#L7-L80)). | This is local codebase research only, stored as workspace Markdown, with no source identity, privacy policy, or control-plane replay protection. Adoption is too small to treat it as validation of the product design. | The simple phase boundary and versioned artifact are good; Piss should keep the artifact in durable workflow state and validate its structure instead of trusting filenames. |

## Design implications for Piss

### 1. Separate three loops

1. **Grounding loop:** inspect the local repository and external prior art until the specification's material uncertainties are covered.
2. **Delivery loop:** Build → Verify → Review → bounded Repair, which Piss already owns.
3. **Experiment loop:** generate competing hypotheses, evaluate them under a fixed metric, and keep the winner. Add this only for plans that declare a trustworthy evaluation contract.

Calling all three “autoresearch” would obscure different authority, privacy, and completion rules.

### 2. Proposed ordinary workflow

```text
Define → Research → Plan → Approve & Run → Build → Verify → Review
                     ↑                         ↖──── Repair ────┘
                     └── revise questions when research changes scope
```

Research should be control-plane-owned and resumable. A terminal Research checkpoint should contain:

- stable research-question IDs mapped to specification criteria;
- coverage status: `answered`, `unsupported`, or `not_applicable`;
- source records with canonical URL, repository, immutable revision/tag/SHA when available, title, and access time;
- findings that distinguish verified facts from inference;
- approach records with `adopt`, `adapt`, or `reject` and local rationale;
- unresolved questions that force another Define turn or block Plan;
- explicit external-research policy and exhausted budget state.

Plan must report which research question/finding IDs it applied, just as it currently acknowledges durable operator guidance. A Plan checkpoint should be rejected when a required research question is unresolved or a cited repository source lacks immutable identity.

### 3. External research is an explicit disclosure boundary

Starting a workflow should choose a policy such as:

- `local_only` — inspect only the approved workspace;
- `targeted_external` — search when a material uncertainty exists, with bounded query/source budgets;
- `required_external` — require external coverage for every research question before Plan.

The UI must explain that external search sends queries to configured providers. Queries should default to redacted technical descriptions rather than repository names, customer data, paths, or secrets. The policy is bound at workflow start so Define/Research do not need repeated confirmations.

### 4. First tracer

**Observable behavior:** A user starts a `targeted_external` engineering workflow; after Define, Piss runs a read-only Research phase, publishes a durable source-pinned research brief, and refuses to enter Plan until every required research question is answered or explicitly marked unsupported.

**Acceptance:**

- one real source-backed question crosses UI → workflow state → Pi research run → structured checkpoint → UI;
- research runs with a bounded read-only tool set and cannot edit the approved workspace;
- external capability absence is represented as `unsupported`, not fabricated evidence;
- cited GitHub evidence includes an immutable commit SHA;
- restart resumes the same research run without duplicating accepted findings;
- Plan receives and acknowledges the research brief;
- ordinary local-only workflows remain compatible;
- no experiment branching, scoring, merge automation, or broad autoresearch integration is included yet.

### 5. Later experiment tracer

After managed Piss worktrees exist, add an optional plan slice with an explicit evaluation contract:

- immutable baseline revision;
- editable paths and forbidden paths;
- primary metric, direction, budget, and stopping rule;
- correctness/backpressure checks;
- dev signal and, where feasible, held-out acceptance signal;
- one worktree per hypothesis;
- durable hypothesis/result/insight records;
- merge remains a separately approved typed operation.

This borrows Arbor's strongest ideas without turning every product change into a benchmark competition.
