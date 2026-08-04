#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.FAKE_PI_SESSION_ROOT;
mkdirSync(root, { recursive: true });
const sessionFile = join(root, `workflow-${process.pid}.jsonl`);
writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: `fake-${process.pid}`, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
const model = { provider: "test", id: "workflow-model", name: "Workflow model", reasoning: true, thinkingLevelMap: { off: "off", medium: "medium", high: "high" } };
let buffer = "";
let defineTurns = 0;
let verifyRuns = 0;
let heldBuild;
let outsideRequested = false;
let approvedRequested = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (command, data = {}) => send({ id: command.id, type: "response", command: command.type, success: true, data });
const settled = () => setTimeout(() => send({ type: "agent_settled" }), 20);
const identity = (message) => ({
  workflowId: /Workflow ID: ([^\n]+)/.exec(message)?.[1],
  phaseRunId: /Phase run ID: ([^\n]+)/.exec(message)?.[1],
  planRevision: Number(/Plan revision: (\d+)/.exec(message)?.[1] ?? 0),
  runtimeId: /Runtime generation: ([^\n]+)/.exec(message)?.[1],
  workflowRevision: Number(/Workflow revision: (\d+)/.exec(message)?.[1] ?? 0),
  consultationId: /Consultation ID: ([^\n]+)/.exec(message)?.[1],
  eventId: /Advice event ID: ([^\n]+)/.exec(message)?.[1],
});
const tool = (toolCallId, toolName, details) => send({ type: "tool_execution_end", toolCallId, toolName, result: { content: [{ type: "text", text: toolName }], details }, isError: false });
const checkpoint = (stage, outcome, args, artifact) => {
  tool(`checkpoint-${stage}-${Date.now()}`, "piss_workflow_checkpoint", { ...args, stage, outcome, summary: `${stage} ${outcome} in real-boundary fixture`, ...(artifact ? { artifact } : {}) });
  settled();
};
const dossier = {
  revision: 1,
  criteria: [{ id: "AC-AUTH", title: "Structured authority is enforced" }, { id: "AC-PROGRESS", title: "Progress and guidance are durable" }],
  slices: [{ id: "S-AUTH", title: "Authority tracer", criterionIds: ["AC-AUTH"], dependencies: [] }, { id: "S-PROGRESS", title: "Guidance and repair", criterionIds: ["AC-PROGRESS"], dependencies: ["S-AUTH"] }],
  verificationRequirements: ["Verify every criterion after one repair"],
  operations: [{ id: "approved-edit", kind: "workspace_write", target: "shared/", constraints: ["repository-local"], receiptRequired: true, idempotencyKey: "approved-edit-once", description: "Apply the approved local edit", recovery: "Targeted rollback", evidence: "Authority decision event" }],
  recoveryRequirements: ["Preserve unrelated work"], exclusions: ["Production deployment"], readiness: [{ id: "repo", label: "Repository", status: "passed", detail: "Ready" }], unresolved: [],
};
const handlePrompt = (command) => {
  response(command);
  send({ type: "agent_start" });
  send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } });
  const args = identity(command.message);
  if (command.message.startsWith("/skill:piss-engineering-define")) {
    defineTurns += 1;
    const appliedGuidanceIds = [...command.message.matchAll(/\[Workflow guidance ([^ —\]]+)(?: — [^\]]+)?\]/g)].map((match) => match[1]);
    if (appliedGuidanceIds.length) tool(`progress-define-guidance-${defineTurns}`, "piss_workflow_progress", { ...args, eventId: `progress-define-guidance-${defineTurns}`, activity: "Applied refinement guidance", appliedGuidanceIds, condition: "working", nextAction: "Continue refining the specification" });
    if (defineTurns === 1) tool("draft-define-1", "piss_workflow_draft", { ...args, stage: "define", summary: "Clarify the primary reliability boundary", specification: "# Draft specification\n\nPreserve authority safely.", questions: ["Which reliability boundary matters most?"] });
    else if (defineTurns === 2) tool("draft-define-2", "piss_workflow_draft", { ...args, stage: "define", summary: "Clarify acceptable recovery behavior", specification: "# Refined specification\n\nPreserve authority and recover automatically.", questions: ["Should recoverable failures enter bounded Repair automatically?"] });
    else return checkpoint("define", "ready", { ...args, researchQuestions: [{ id: "RQ-FIXTURE", prompt: "How should the existing durable workflow boundary be extended?", required: true }] }, "# Approved specification\n\nEnforce authority, durable guidance, automatic repair, and restored progress.");
    settled();
    return;
  }
  if (command.message.startsWith("/skill:piss-engineering-research")) {
    const policy = /External research policy: (local_only|targeted_external|required_external)/.exec(command.message)?.[1] ?? "local_only";
    const researchBrief = {
      policy,
      questions: [{ id: "RQ-FIXTURE", prompt: "How should the existing durable workflow boundary be extended?", status: "answered", summary: "Extend the existing state machine and persistence boundary.", sourceIds: ["SRC-FIXTURE"] }],
      sources: [{ id: "SRC-FIXTURE", kind: "workspace", title: "Engineering workflow control plane", url: "workspace://shared/engineeringWorkflow.ts", accessedAt: new Date().toISOString() }],
      findings: [{ id: "F-FIXTURE", questionIds: ["RQ-FIXTURE"], sourceIds: ["SRC-FIXTURE"], confidence: "verified", decision: "adapt", summary: "Adapt the current durable phase transition rather than creating a parallel workflow." }],
      summary: "Read-only local architecture research completed.",
      completedAt: new Date().toISOString(),
    };
    return checkpoint("research", "ready", { ...args, researchBrief }, "# Research brief\n\nAdapt the existing durable workflow boundary.");
  }
  if (command.message.startsWith("/skill:piss-engineering-plan")) return checkpoint("plan", "ready", { ...args, dossier, appliedResearchFindingIds: ["F-FIXTURE"] }, "# Complete delivery plan\n\nTwo ordered slices, bounded local authority, verification, and one automatic repair.");
  if (command.message.startsWith("/skill:piss-engineering-build")) {
    if (command.message.includes("Repair attempt")) return checkpoint("build", "passed", args);
    heldBuild = args;
    tool("progress-build-start", "piss_workflow_progress", { ...args, eventId: "progress-build-start", activity: "Completed the first of two slices", currentSliceId: "S-PROGRESS", completedSliceIds: ["S-AUTH"], passedCriterionIds: [], condition: "working", nextAction: "Apply operator guidance and finish the second slice" });
    if (!outsideRequested) {
      outsideRequested = true;
      const authority = { ...args, operationId: "production-deploy", kind: "deployment", target: "production", constraints: ["external approval required"], title: "Confirm production deployment", message: "This operation is outside the approved plan." };
      send({ type: "tool_execution_start", toolCallId: "authority-outside", toolName: "piss_workflow_authority_request", args: authority });
      send({ type: "extension_ui_request", id: "authority-outside-confirm", method: "confirm", title: `[PISS authority:authority-outside] ${authority.title}`, message: authority.message });
    }
    return;
  }
  if (command.message.startsWith("/skill:piss-engineering-verify")) {
    verifyRuns += 1;
    return checkpoint("verify", verifyRuns === 1 ? "failed" : "passed", args);
  }
  if (command.message.startsWith("/skill:piss-engineering-review")) return checkpoint("review", "passed", args);
  if (command.message.startsWith("/skill:piss-engineering-supervisor")) {
    tool("supervisor-advice", "piss_workflow_supervisor_advice", { workflowId: args.workflowId, eventId: args.eventId, consultationId: args.consultationId, phaseRunId: args.phaseRunId, planRevision: args.planRevision, workflowRevision: args.workflowRevision, runtimeId: args.runtimeId, action: "enter_repair", problem: "Verification found one recoverable fixture defect.", summary: "Enter the approved bounded repair", guidance: "Repair and re-run verification", basis: "Approved repair budget" });
    return settled();
  }
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
  settled();
};
const requestApprovedAuthority = () => {
  if (!heldBuild || approvedRequested) return;
  approvedRequested = true;
  const authority = { ...heldBuild, operationId: "approved-edit", kind: "workspace_write", target: "shared/", constraints: ["repository-local"], idempotencyKey: "approved-edit-once", title: "Confirm approved workspace edit", message: "Continue with the exact approved operation?" };
  send({ type: "tool_execution_start", toolCallId: "authority-approved", toolName: "piss_workflow_authority_request", args: authority });
  send({ type: "extension_ui_request", id: "authority-approved-confirm", method: "confirm", title: `[PISS authority:authority-approved] ${authority.title}`, message: authority.message });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") response(command, { sessionId: `fake-${process.pid}`, sessionFile, model, thinkingLevel: "high", isStreaming: false, autoCompactionEnabled: true, pendingMessageCount: 0 });
    else if (command.type === "get_available_models") response(command, { models: [model] });
    else if (command.type === "get_commands") response(command, { commands: [] });
    else if (command.type === "get_session_stats") response(command, { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: 0, contextWindow: 100000, percent: 0 } });
    else if (command.type === "prompt") handlePrompt(command);
    else if (command.type === "steer") {
      response(command);
      const guidanceId = /Workflow guidance ([^ —\]]+)/.exec(command.message)?.[1];
      if (heldBuild) {
        tool("progress-guidance", "piss_workflow_progress", { ...heldBuild, eventId: "progress-guidance", activity: "Applied guidance and completed both slices", currentSliceId: null, completedSliceIds: ["S-AUTH", "S-PROGRESS"], passedCriterionIds: ["AC-AUTH", "AC-PROGRESS"], evidence: [{ criterionId: "AC-AUTH", summary: "Approved authority auto-resolved while production stayed blocked" }, { criterionId: "AC-PROGRESS", summary: "Guidance applied before automatic repair" }], appliedGuidanceIds: guidanceId ? [guidanceId] : [], receipt: { operationId: "approved-edit", idempotencyKey: "approved-edit-once", status: "completed", target: "shared/", evidence: "Authority and workflow evidence recorded" }, condition: "working", nextAction: "Run verification" });
        checkpoint("build", "passed", heldBuild);
      }
    } else if (command.type === "abort") { response(command); settled(); }
    else if (command.type === "extension_ui_response") {
      if (command.id === "authority-outside-confirm") {
        tool("authority-outside", "piss_workflow_authority_request", { confirmed: false });
        requestApprovedAuthority();
      } else if (command.id === "authority-approved-confirm" && command.confirmed === true) {
        tool("authority-approved", "piss_workflow_authority_request", { confirmed: true });
        tool("progress-approved-started", "piss_workflow_progress", { ...heldBuild, eventId: "progress-approved-started", activity: "Completed the first of two slices; started the approved workspace operation", receipt: { operationId: "approved-edit", idempotencyKey: "approved-edit-once", status: "started", target: "shared/" }, condition: "working", nextAction: "Complete the approved operation with evidence" });
      }
    } else if (command.id) response(command);
  }
});
