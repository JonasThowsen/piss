import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AppConfig, type AppConfigShape } from "../server/config.ts";
import { FileMentionSearch } from "../server/files/FileMentionSearch.ts";
import { appendBoundedEvent, cloneSession, interruptedWorkflowRecoveryPhase, PiRuntimeSupervisor, PiRuntimeSupervisorLive, processArguments, projectEventData, projectEventWithDetachedOutput, reconcilePersistedWorkflow, reconcileTranscriptGuidance, reconcileWorkflowAfterRestart, replayEventsFromTranscriptEntry, transcriptGuidanceIds, workflowGuidanceForDispatch, workflowPhasePrompt } from "../server/runtimes/PiRuntimeSupervisor.ts";
import { PushNotifications } from "../server/notifications/PushNotifications.ts";
import { WorkspaceDirectory } from "../server/workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepository } from "../server/workspaces/WorkspaceRepository.ts";
import { WORKFLOW_SUPERSEDED_REASON_MAX_LENGTH, WorkspaceId, type EngineeringWorkflow, type EngineeringWorkflowMutationInput, type OwnedSession, type OwnedSessionEvent, type Workspace } from "../shared/domain.ts";
import { applyWorkflowCheckpoint, initialWorkflowProgress } from "../shared/engineeringWorkflow.ts";

const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);

function guardedWorkflowMutation(
  session: Pick<OwnedSession, "runtimeId" | "workflow">,
  input:
    | { readonly action: "approve" | "accept" | "cancel" }
    | { readonly action: "resume"; readonly feedback?: string }
    | { readonly action: "continueRepairs"; readonly additionalRepairAttempts: number }
    | { readonly action: "revise" | "intervene"; readonly feedback: string; readonly scopeChange?: boolean },
  mutationId: string,
): EngineeringWorkflowMutationInput {
  if (!session.workflow) throw new Error("Expected an active workflow");
  return {
    ...input,
    runtimeId: session.runtimeId,
    workflowId: session.workflow.id,
    mutationId,
    expectedRevision: session.workflow.revision ?? 0,
    expectedPhase: session.workflow.phase,
    ...(session.workflow.phaseRun ? { expectedPhaseRunId: session.workflow.phaseRun.id } : {}),
  } as EngineeringWorkflowMutationInput;
}

async function fakePi(directory: string, lazySessionFile = false): Promise<string> {
  const path = join(directory, "fake-pi.mjs");
  await writeFile(
    path,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.FAKE_PI_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");
const sessionFile = process.env.FAKE_PI_SESSION_FILE;
const writeHeader = () => writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
if (${lazySessionFile ? "false" : "true"} && !existsSync(sessionFile)) writeHeader();
const models = [
  { provider: "test", id: "model-a", name: "Model A", reasoning: true, baseUrl: "https://credential@example.invalid", headers: { Authorization: "Bearer super-secret" }, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
  { provider: "test", id: "model-b", name: "Model B", reasoning: false }
];
let currentModel = models[0];
let currentThinking = "medium";
let buffer = "";
let compactAttempts = 0;
let workflowInterventionMode = false;
let workflowScopeChangeMode = false;
let workflowScopeChangeAborted = false;
let workflowGuidanceFailureMode = false;
let workflowFailureMode = false;
let workflowSupervisorMode = false;
let workflowAuthorityMode = false;
let workflowStaleCancelMode = false;
let workflowDispatchFailureMode = false;
let workflowDispatchFailures = 0;
let workflowAuthorityReported = false;
let workflowOutsideAuthorityReported = false;
let workflowSupervisorBlockReported = false;
let workflowCheckpointSequence = 0;
let heldBuildArgs;
let heldAuthorityArgs;
let pendingAppliedGuidanceIds = [];
let activeWorkflowArgs;
const emitBeforeSettle = (...events) => {
  const payload = events.map((event) => JSON.stringify(event)).join("\\n") + "\\n";
  process.stdout.write(payload, () => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"));
};
const stageRejectedVideo = (recordingId) => {
  const path = process.env.PISS_BROWSER_ARTIFACT_STAGING_DIR + "/" + recordingId + ".webm";
  writeFileSync(path, "rejected-video-bytes");
  if (process.env.FAKE_PI_STAGED_VIDEO_PATHS) appendFileSync(process.env.FAKE_PI_STAGED_VIDEO_PATHS, path + "\\n");
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (process.env.FAKE_PI_COMMANDS) appendFileSync(process.env.FAKE_PI_COMMANDS, command.type + "\\n");
    if (command.type === "get_state" && process.env.FAKE_PI_HANG !== "1") {
      console.log(JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi-test-session", sessionFile, model: currentModel, thinkingLevel: currentThinking, isStreaming: false, autoCompactionEnabled: true, pendingMessageCount: 0 } }));
    }
    if (command.type === "get_available_models") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_available_models", success: true, data: { models } }));
    if (command.type === "get_commands") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: [
      { name: "review", description: "Review changes", source: "extension", sourceInfo: { path: "/secret/extension.ts", source: "test", scope: "user", origin: "top-level" } },
      { name: "fix-tests", description: "Fix tests", source: "prompt", sourceInfo: { path: "/secret/fix-tests.md", source: "test", scope: "project", origin: "top-level" } }
    ] } }));
    if (command.type === "get_session_stats") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 10, tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 50, total: 1750 }, cost: 0.25, contextUsage: { tokens: 30000, contextWindow: 200000, percent: 15 } } }));
    if (command.type === "compact") {
      compactAttempts += 1;
      console.log(JSON.stringify({ type: "compaction_start", reason: "manual" }));
      if (compactAttempts === 1) {
        console.log(JSON.stringify({ id: command.id, type: "response", command: "compact", success: true, data: { tokensBefore: 30000, estimatedTokensAfter: 9000 } }));
        console.log(JSON.stringify({ type: "compaction_end", reason: "manual", result: { tokensBefore: 30000, estimatedTokensAfter: 9000 }, aborted: false, willRetry: false }));
      } else {
        console.log(JSON.stringify({ id: command.id, type: "response", command: "compact", success: false, error: "simulated compaction failure" }));
        console.log(JSON.stringify({ type: "compaction_end", reason: "manual", result: null, aborted: false, willRetry: false, errorMessage: "simulated compaction failure" }));
      }
    }
    if (command.type === "set_auto_compaction") console.log(JSON.stringify({ id: command.id, type: "response", command: "set_auto_compaction", success: true }));
    if (command.type === "get_entries") {
      const entries = readFileSync(sessionFile, "utf8").trim().split("\\n").slice(1).map(JSON.parse);
      console.log(JSON.stringify({ id: command.id, type: "response", command: "get_entries", success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } }));
    }
    if (command.type === "set_model") {
      currentModel = models.find((model) => model.provider === command.provider && model.id === command.modelId) ?? currentModel;
      currentThinking = currentModel.reasoning ? "medium" : "off";
      console.log(JSON.stringify({ id: command.id, type: "response", command: "set_model", success: true, data: currentModel }));
    }
    if (command.type === "set_thinking_level") {
      currentThinking = command.level;
      console.log(JSON.stringify({ id: command.id, type: "response", command: "set_thinking_level", success: true }));
    }
    if (command.type === "prompt") {
      const requestedWorkflowSkill = /^\\/skill:piss-engineering-([^\\n]+)/.exec(command.message)?.[1];
      if (workflowDispatchFailureMode && requestedWorkflowSkill === "build" && workflowDispatchFailures < 3) {
        workflowDispatchFailures += 1;
        console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: false, error: "simulated transient workflow dispatch failure" }));
        continue;
      }
      if (command.message === "/extension-notify") {
        console.log(JSON.stringify({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "MCP Server Status:\\n\\n✓ test: connected", notifyType: "info" }));
        console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
        continue;
      }
      if (command.message === "/extension-hang") continue;
      const acceptPrompt = () => {
        if (!existsSync(sessionFile)) writeHeader();
        appendFileSync(sessionFile, JSON.stringify({ type: "message", id: command.id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: command.message }] } }) + "\\n");
        console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
        if (command.message === "Delay prompt acknowledgement") console.log(JSON.stringify({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 190000, estimatedTokensAfter: 30000 }, aborted: false, willRetry: false }));
        console.log(JSON.stringify({ type: "agent_start" }));
        console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } }));
        if (command.message.startsWith("/skill:piss-engineering-")) {
          const workflowId = /Workflow ID: ([^\\n]+)/.exec(command.message)?.[1];
          const skill = /^\\/skill:piss-engineering-([^\\n]+)/.exec(command.message)?.[1];
          if (skill === "supervisor") {
            const advice = { workflowId, eventId: /Advice event ID: ([^\\n]+)/.exec(command.message)?.[1], consultationId: /Consultation ID: ([^\\n]+)/.exec(command.message)?.[1], phaseRunId: /Phase run ID: ([^\\n]+)/.exec(command.message)?.[1], planRevision: Number(/Plan revision: (\\d+)/.exec(command.message)?.[1] ?? 0), workflowRevision: Number(/Workflow revision: (\\d+)/.exec(command.message)?.[1] ?? 0), runtimeId: /Runtime generation: ([^\\n]+)/.exec(command.message)?.[1], action: "resume_with_guidance", problem: "The build needs to retry the documented recovery procedure.", summary: "Use the approved deterministic recovery path", guidance: "Retry with the documented bounded recovery procedure", basis: "Approved delivery plan recovery section" };
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-supervisor-advice", toolName: "piss_workflow_supervisor_advice", result: { content: [{ type: "text", text: "advice" }], details: advice }, isError: false }));
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-supervisor-advice-duplicate", toolName: "piss_workflow_supervisor_advice", result: { content: [{ type: "text", text: "duplicate advice" }], details: advice }, isError: false }));
            setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 25);
            return;
          }
          const stage = skill === "define" ? "define" : skill === "research" ? "research" : skill === "plan" ? "plan" : skill === "build" ? "build" : skill === "verify" ? "verify" : "review";
          if (stage === "define" && command.message.includes("Exercise workflow user interventions")) workflowInterventionMode = true;
          if (stage === "define" && command.message.includes("Exercise scope-changing guidance")) workflowScopeChangeMode = true;
          if (stage === "define" && command.message.includes("Exercise failed guidance delivery")) workflowGuidanceFailureMode = true;
          if (stage === "define" && command.message.includes("Exercise failed workflow continuation")) workflowFailureMode = true;
          if (stage === "define" && command.message.includes("Exercise automatic supervisor recovery")) workflowSupervisorMode = true;
          if (stage === "define" && command.message.includes("Exercise stale cancellation")) workflowStaleCancelMode = true;
          if (stage === "define" && command.message.includes("Exercise dispatch failure recovery")) workflowDispatchFailureMode = true;
          if (stage === "define" && command.message.includes("Exercise structured workflow authority")) workflowAuthorityMode = true;
          if (stage === "define" && command.message.includes("Exercise approved structured workflow authority")) {
            workflowAuthorityMode = true;
            workflowOutsideAuthorityReported = true;
          }
          const phaseRunId = /Phase run ID: ([^\\n]+)/.exec(command.message)?.[1];
          const planRevision = Number(/Plan revision: (\\d+)/.exec(command.message)?.[1] ?? 0);
          const runtimeId = /Runtime generation: ([^\\n]+)/.exec(command.message)?.[1];
          const supervisorBlocksBuild = workflowSupervisorMode && stage === "build" && !workflowSupervisorBlockReported;
          if (supervisorBlocksBuild) workflowSupervisorBlockReported = true;
          const outcome = stage === "define" || stage === "research" || stage === "plan" ? "ready" : supervisorBlocksBuild ? "blocked" : workflowFailureMode && stage === "review" ? "failed" : "passed";
          const authorityDossier = { revision: 1, criteria: [{ id: "AC-AUTH", title: "Approved authority is applied" }], slices: [{ id: "S-AUTH", title: "Authority tracer", criterionIds: ["AC-AUTH"], dependencies: [] }], verificationRequirements: ["Inspect authority decision"], operations: [{ id: "approved-edit", kind: "workspace_write", target: "shared/", description: "Approved workspace edit", recovery: "Targeted rollback", evidence: "Authority event" }], recoveryRequirements: ["Preserve unrelated work"], exclusions: ["Deployment"], readiness: [{ id: "repo", label: "Repository", status: "passed", detail: "ready" }], unresolved: [] };
          const standardDossier = { revision: 1, criteria: [{ id: "AC-GENERIC", title: "Complete the workflow fixture" }], slices: [{ id: "S-GENERIC", title: "Workflow fixture", criterionIds: ["AC-GENERIC"], dependencies: [] }], verificationRequirements: ["Inspect the fixture checkpoint"], operations: [{ id: "workspace-write", kind: "workspace_write", target: "shared/", description: "Fixture workspace write", recovery: "Targeted rollback", evidence: "Fixture progress" }], recoveryRequirements: ["Preserve unrelated work"], exclusions: ["Production operations"], readiness: [{ id: "repo", label: "Repository", status: "passed", detail: "ready" }], unresolved: [] };
          const scopeDossier = { ...standardDossier, criteria: [{ id: "AC-PRIOR", title: "Preserve prior revision evidence" }], slices: [{ id: "S-PRIOR", title: "Prior revision tracer", criterionIds: ["AC-PRIOR"], dependencies: [] }], operations: [{ ...standardDossier.operations[0], receiptRequired: true, idempotencyKey: "scope-write-once" }] };
          const planDossier = workflowAuthorityMode ? authorityDossier : workflowScopeChangeMode ? scopeDossier : standardDossier;
          const queuedGuidanceIds = [...command.message.matchAll(/\\[Workflow guidance ([^ —\\]]+)(?: — [^\\]]+)?\\]/g)].map((match) => match[1]);
          const deliveredGuidanceIds = /Previously delivered guidance IDs \\(do not apply twice; acknowledge from transcript evidence\\): ([^\\n]+)/.exec(command.message)?.[1]
            ?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
          const appliedGuidanceIds = [...new Set([...queuedGuidanceIds, ...deliveredGuidanceIds])];
          const researchQuestions = [{ id: "RQ-LOCAL", prompt: "How does the current workspace implement the affected workflow boundary?", required: true }];
          const researchPolicy = /External research policy: (local_only|targeted_external|required_external)/.exec(command.message)?.[1] ?? "local_only";
          const researchBrief = { policy: researchPolicy, questions: [{ id: "RQ-LOCAL", prompt: researchQuestions[0].prompt, status: "answered", summary: "The local workflow boundary is implemented in shared engineering workflow state.", sourceIds: ["SRC-LOCAL"] }], sources: [{ id: "SRC-LOCAL", kind: "workspace", title: "Engineering workflow state", url: "workspace://shared/engineeringWorkflow.ts", accessedAt: "2026-01-01T00:00:00.000Z" }], findings: [{ id: "F-LOCAL", questionIds: ["RQ-LOCAL"], sourceIds: ["SRC-LOCAL"], confidence: "verified", decision: "adapt", summary: "Extend the existing control-plane state machine rather than adding a parallel workflow." }], summary: "Local architecture research completed.", completedAt: "2026-01-01T00:00:00.000Z" };
          const args = { workflowId, stage, outcome, summary: supervisorBlocksBuild ? "Recoverable build blocker" : stage + " checkpoint", ...(phaseRunId && phaseRunId !== "legacy" ? { phaseRunId, planRevision, runtimeId } : {}), ...(appliedGuidanceIds.length > 0 ? { appliedGuidanceIds } : {}), ...(stage === "define" ? { artifact: "# Approved specification", researchQuestions } : stage === "research" ? { artifact: "# Research brief", researchBrief } : stage === "plan" ? { artifact: "# Complete delivery plan", dossier: planDossier, appliedResearchFindingIds: ["F-LOCAL"] } : {}) };
          activeWorkflowArgs = args;
          const emitCheckpoint = () => {
            workflowCheckpointSequence += 1;
            const checkpointArgs = pendingAppliedGuidanceIds.length > 0 ? { ...args, appliedGuidanceIds: [...new Set([...(args.appliedGuidanceIds ?? []), ...pendingAppliedGuidanceIds])] } : args;
            pendingAppliedGuidanceIds = [];
            const completion = stage === "build" && outcome === "passed" && !workflowAuthorityMode ? { type: "tool_execution_end", toolCallId: "workflow-build-completion-" + workflowCheckpointSequence, toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "progress" }], details: { workflowId, eventId: "build-completion-" + workflowCheckpointSequence, phaseRunId, planRevision, runtimeId, activity: "Completed the planned fixture slice", currentSliceId: null, completedSliceIds: [workflowScopeChangeMode ? "S-PRIOR" : "S-GENERIC"], passedCriterionIds: [workflowScopeChangeMode ? "AC-PRIOR" : "AC-GENERIC"], evidence: [{ criterionId: workflowScopeChangeMode ? "AC-PRIOR" : "AC-GENERIC", summary: "Fixture completion evidence" }], condition: "working", nextAction: "Verify the completed fixture" } }, isError: false } : null;
            emitBeforeSettle(...(completion ? [completion] : []), { type: "tool_execution_end", toolCallId: "workflow-" + stage + "-" + workflowCheckpointSequence, toolName: "piss_workflow_checkpoint", result: { content: [{ type: "text", text: "checkpoint" }], details: checkpointArgs }, isError: false });
          };
          if (supervisorBlocksBuild) {
            console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Please confirm that I may continue with the already approved recovery procedure." }], stopReason: "stop" } }));
            setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 25);
            return;
          }
          if (workflowAuthorityMode && stage === "build" && !workflowOutsideAuthorityReported) {
            workflowOutsideAuthorityReported = true;
            heldAuthorityArgs = args;
            const authorityArgs = { workflowId, phaseRunId, planRevision, runtimeId, operationId: "production-deploy", kind: "deployment", target: "production", constraints: ["external approval required"], title: "Confirm production deployment", message: "Deploy outside the approved plan?" };
            console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "workflow-outside-authority-request", toolName: "piss_workflow_authority_request", args: authorityArgs }));
            console.log(JSON.stringify({ type: "extension_ui_request", id: "workflow-outside-authority-confirm", method: "confirm", title: "[PISS authority:workflow-outside-authority-request] " + authorityArgs.title, message: authorityArgs.message }));
            return;
          }
          if (workflowAuthorityMode && stage === "build" && !workflowAuthorityReported) {
            workflowAuthorityReported = true;
            heldAuthorityArgs = args;
            console.log(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 1000000, delayMs: 10, errorMessage: "simulated transient provider failure" }));
            console.log(JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1 }));
            const authorityArgs = { workflowId, phaseRunId, planRevision, runtimeId, operationId: "approved-edit", kind: "workspace_write", target: "shared/", constraints: [], title: "Confirm approved workspace edit", message: "Continue with the operation already listed in the approved plan?" };
            const interleavedArgs = { ...authorityArgs, operationId: "unrelated-edit", target: "outside/", title: "Unrelated authority request" };
            console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "workflow-authority-interleaved", toolName: "piss_workflow_authority_request", args: interleavedArgs }));
            console.log(JSON.stringify({ type: "extension_ui_request", id: "workflow-raw-input", method: "input", title: "Raw workflow prompt", message: "This must not leak into the operator UI." }));
            console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "workflow-authority-request", toolName: "piss_workflow_authority_request", args: authorityArgs }));
            console.log(JSON.stringify({ type: "extension_ui_request", id: "workflow-authority-confirm", method: "confirm", title: "[PISS authority:workflow-authority-request] " + authorityArgs.title, message: authorityArgs.message }));
            console.log(JSON.stringify({ type: "extension_ui_request", id: "workflow-authority-confirm", method: "confirm", title: "[PISS authority:workflow-authority-request] " + authorityArgs.title, message: authorityArgs.message }));
            return;
          }
          if (workflowScopeChangeMode && !workflowScopeChangeAborted && stage === "build" && !heldBuildArgs) {
            heldBuildArgs = args;
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-scope-started", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "progress" }], details: { workflowId, eventId: "scope-started", phaseRunId, planRevision, runtimeId, activity: "Started prior-revision operation", receipt: { operationId: "workspace-write", idempotencyKey: "scope-write-once", status: "started", target: "shared/" }, condition: "working", nextAction: "Complete the prior-revision tracer" } }, isError: false }));
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-scope-progress", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "progress" }], details: { workflowId, eventId: "scope-progress", phaseRunId, planRevision, runtimeId, activity: "Completed prior-revision tracer", currentSliceId: null, completedSliceIds: ["S-PRIOR"], passedCriterionIds: ["AC-PRIOR"], evidence: [{ criterionId: "AC-PRIOR", summary: "Prior revision evidence" }], receipt: { operationId: "workspace-write", idempotencyKey: "scope-write-once", status: "completed", target: "shared/", evidence: "prior write evidence" }, condition: "working", nextAction: "Wait for scope guidance" } }, isError: false }));
            return;
          }
          if (workflowGuidanceFailureMode && stage === "build" && !heldBuildArgs) {
            heldBuildArgs = args;
            return;
          }
          if (workflowInterventionMode && stage === "build" && !heldBuildArgs) {
            heldBuildArgs = args;
            console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Waiting for build guidance" } }));
            return;
          }
          if (workflowInterventionMode && stage === "verify") {
            setTimeout(emitCheckpoint, 250);
            return;
          }
          if (workflowStaleCancelMode && stage === "build") {
            setTimeout(emitCheckpoint, 150);
            return;
          }
          emitCheckpoint();
          return;
        }
        if (command.message.startsWith("Continue the task that was interrupted by the PISS control-plane restart.") || command.message.startsWith("The previous run ended after tool execution without a final response.")) {
          const recoveredText = command.message.startsWith("Continue the task") ? "Recovered final response after restart" : "Recovered missing final response";
          const message = { role: "assistant", content: [{ type: "text", text: recoveredText }], stopReason: "stop" };
          appendFileSync(sessionFile, JSON.stringify({ type: "message", id: command.id + "-assistant", parentId: command.id, timestamp: new Date().toISOString(), message }) + "\\n");
          console.log(JSON.stringify({ type: "message_end", message }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        if (command.message === "Recover context overflow") {
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Your input exceeds the context window of this model" } }));
          console.log(JSON.stringify({ type: "compaction_start", reason: "overflow" }));
          console.log(JSON.stringify({ type: "compaction_end", reason: "overflow", result: { tokensBefore: 200000, estimatedTokensAfter: 24000 }, aborted: false, willRetry: true }));
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" } }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        if (command.message === "Crash after browser artifacts") {
          const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
          for (let index = 0; index < 24; index += 1) {
            const suffix = index.toString(16).padStart(12, "0");
            const artifactId = "2c240f9a-6091-49a9-8cfa-" + suffix;
            writeFileSync(process.env.PISS_BROWSER_ARTIFACT_STAGING_DIR + "/" + artifactId + ".png", png);
            const artifact = { id: artifactId, kind: "browser-screenshot", mediaType: "image/png", byteCount: png.length, width: 1, height: 1, pageUrl: "http://127.0.0.1:4000/", pageTitle: "Crash fixture", createdAt: new Date().toISOString() };
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "crash-browser-" + index, toolName: "piss_browser_screenshot", result: { content: [{ type: "text", text: "captured" }], details: { pissBrowserArtifact: { version: 1, stagingName: artifactId + ".png", artifact } } }, isError: false }));
          }
          setTimeout(() => process.exit(17), 5);
          return;
        }
        if (command.message === "Malformed browser artifact") {
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "malformed-browser", toolName: "piss_browser_screenshot", result: { content: [{ type: "text", text: "captured" }], details: { pissBrowserArtifact: { version: 99, stagingName: "not-an-artifact.png", artifact: {} } } }, isError: false }));
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Malformed capture handled" }], stopReason: "stop" } }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        if (command.message === "Malformed browser video") {
          const recordingId = "663dd98b-a517-48f6-a85d-639ae76077e9";
          const ignoredId = "2c240f9a-6091-49a9-bcfa-0c49e6e3aa41";
          stageRejectedVideo(recordingId);
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "failed-video-start", toolName: "piss_browser_video_start", result: { details: { pissBrowserRecording: { version: 1, state: "started", recordingId: ignoredId } } }, isError: true }));
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "wrong-close-state", toolName: "piss_browser_close", result: { details: { pissBrowserRecording: { version: 1, state: "started", recordingId: ignoredId } } }, isError: false }));
          for (let replay = 0; replay < 2; replay += 1) console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "video-start", toolName: "piss_browser_video_start", result: { content: [{ type: "text", text: "started" }], details: { pissBrowserRecording: { version: 1, state: "started", recordingId } } }, isError: false }));
          for (let replay = 0; replay < 2; replay += 1) console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "video-stop", toolName: "piss_browser_video_stop", result: { content: [{ type: "text", text: "stopped" }], details: { pissBrowserRecording: { version: 1, state: "finalized", recordingId }, pissBrowserArtifact: { version: 99, stagingName: recordingId + ".webm", artifact: {} } } }, isError: false }));
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Malformed video handled" }], stopReason: "stop" } }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        if (command.message === "Unmatched browser video") {
          const recordingId = "79f4dd97-5ca4-4ea6-9418-e1d3ea35f18a";
          stageRejectedVideo(recordingId);
          const artifact = { id: recordingId, kind: "browser-video", mediaType: "video/webm", byteCount: 20, width: 320, height: 240, durationMs: 1000, pageUrl: "http://127.0.0.1:4000/", pageTitle: "Unmatched", createdAt: new Date().toISOString() };
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "unmatched-video-stop", toolName: "piss_browser_video_stop", result: { content: [{ type: "text", text: "stopped" }], details: { pissBrowserRecording: { version: 1, state: "finalized", recordingId }, pissBrowserArtifact: { version: 1, stagingName: recordingId + ".webm", artifact } } }, isError: false }));
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Unmatched video handled" }], stopReason: "stop" } }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }));
        if (command.message === "Settle after tools without final response") {
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "missing-final-tool", toolName: "bash", result: { content: [{ type: "text", text: "tool completed" }] }, isError: false }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        if (command.message === "Hold long run open") {
          for (let index = 0; index < 800; index += 1) {
            console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "long-tool-" + index, toolName: "bash", result: { content: [{ type: "text", text: "completed " + index }] }, isError: false }));
          }
          return;
        }
        if (command.message === "Request interactive input") {
          console.log(JSON.stringify({ type: "extension_ui_request", id: "request-select", method: "select", title: "Choose safely", options: ["Allow", "Block"] }));
        } else if (command.message === "Request timed input") {
          console.log(JSON.stringify({ type: "extension_ui_request", id: "request-timeout", method: "input", title: "Answer quickly", timeout: 20 }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 150);
        } else if (command.message !== "Hold run open") {
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
        }
      };
      if (command.message === "Delay prompt acknowledgement") {
        console.log(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        setTimeout(acceptPrompt, 10_100);
      } else {
        acceptPrompt();
      }
    }
    if (command.type === "extension_ui_response") {
      if (command.id === "workflow-raw-input" && command.cancelled === true) {
        continue;
      } else if (command.id === "workflow-outside-authority-confirm" && command.confirmed !== true && heldAuthorityArgs) {
        heldAuthorityArgs = undefined;
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-outside-authority-request", toolName: "piss_workflow_authority_request", result: { content: [{ type: "text", text: "not authorized" }], details: { confirmed: false } }, isError: false }));
      } else if (command.id === "workflow-authority-confirm" && command.confirmed === true && heldAuthorityArgs) {
        if (process.env.FAKE_PI_AUTHORITY_MARKER && process.env.FAKE_PI_METADATA) {
          const metadata = JSON.parse(readFileSync(process.env.FAKE_PI_METADATA, "utf8"));
          const durable = metadata.sessions?.some((session) => session.workflow?.authorityDecisions?.some((decision) => decision.eventId === "authority:workflow-authority-request" && decision.allowed === true));
          appendFileSync(process.env.FAKE_PI_AUTHORITY_MARKER, JSON.stringify({ durable }) + "\\n");
        }
        const args = heldAuthorityArgs;
        heldAuthorityArgs = undefined;
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-authority-interleaved", toolName: "piss_workflow_authority_request", result: { content: [{ type: "text", text: "interleaved request ended" }], details: { confirmed: false } }, isError: true }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-authority-request", toolName: "piss_workflow_authority_request", result: { content: [{ type: "text", text: "authorized" }], details: { confirmed: true } }, isError: false }));
        emitBeforeSettle(
          { type: "tool_execution_end", toolCallId: "workflow-authority-progress", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "progress" }], details: { workflowId: args.workflowId, eventId: "authority-progress", phaseRunId: args.phaseRunId, planRevision: args.planRevision, runtimeId: args.runtimeId, activity: "Completed approved authority tracer", currentSliceId: null, completedSliceIds: ["S-AUTH"], passedCriterionIds: ["AC-AUTH"], evidence: [{ criterionId: "AC-AUTH", summary: "Structured authority request was automatically allowed" }], condition: "working", nextAction: "Verify the approved result" } }, isError: false },
          { type: "tool_execution_end", toolCallId: "workflow-build-authorized", toolName: "piss_workflow_checkpoint", result: { content: [{ type: "text", text: "checkpoint" }], details: args }, isError: false },
        );
      } else if (command.id === "workflow-authority-confirm" && command.confirmed === true) {
        continue;
      } else console.log(JSON.stringify({ type: "agent_settled" }));
    }
    if (command.type === "steer") {
      if (workflowGuidanceFailureMode) {
        console.log(JSON.stringify({ id: command.id, type: "response", command: "steer", success: false, error: "simulated guidance delivery failure" }));
        continue;
      }
      console.log(JSON.stringify({ id: command.id, type: "response", command: "steer", success: true }));
      if (command.message.startsWith("[Workflow guidance")) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } }));
  const guidanceId = /\\[Workflow guidance ([^ —\\]]+)/.exec(command.message)?.[1];
  if (guidanceId) {
    pendingAppliedGuidanceIds.push(guidanceId);
    if (activeWorkflowArgs?.workflowId) console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "workflow-guidance-applied-" + guidanceId, toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "guidance applied" }], details: { workflowId: activeWorkflowArgs.workflowId, eventId: "guidance-applied-" + guidanceId, phaseRunId: activeWorkflowArgs.phaseRunId, planRevision: activeWorkflowArgs.planRevision, runtimeId: activeWorkflowArgs.runtimeId, activity: "Applied operator guidance", appliedGuidanceIds: [guidanceId], condition: "working", nextAction: "Continue the current phase" } }, isError: false }));
  }
}
      if (heldBuildArgs) {
        const args = heldBuildArgs;
        heldBuildArgs = undefined;
        emitBeforeSettle(
          { type: "tool_execution_end", toolCallId: "workflow-build-guided-progress", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "progress" }], details: { workflowId: args.workflowId, eventId: "workflow-build-guided-progress", phaseRunId: args.phaseRunId, planRevision: args.planRevision, runtimeId: args.runtimeId, activity: "Completed the guided fixture slice", currentSliceId: null, completedSliceIds: ["S-GENERIC"], passedCriterionIds: ["AC-GENERIC"], evidence: [{ criterionId: "AC-GENERIC", summary: "Guided fixture evidence" }], appliedGuidanceIds: pendingAppliedGuidanceIds, condition: "working", nextAction: "Verify the guided fixture" } }, isError: false },
          { type: "tool_execution_end", toolCallId: "workflow-build-guided", toolName: "piss_workflow_checkpoint", result: { content: [{ type: "text", text: "checkpoint" }], details: pendingAppliedGuidanceIds.length > 0 ? { ...args, appliedGuidanceIds: pendingAppliedGuidanceIds } : args }, isError: false },
        );
pendingAppliedGuidanceIds = [];
      }
    }
    if (command.type === "follow_up") {
      console.log(JSON.stringify({ id: command.id, type: "response", command: "follow_up", success: true }));
      if (command.message.startsWith("[Queued workflow guidance")) console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } }));
    }
    if (command.type === "abort") {
      if (String(command.id).includes(":cancel:") && activeWorkflowArgs?.workflowId) {
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "late-cancel-progress", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "late" }], details: { workflowId: activeWorkflowArgs.workflowId, eventId: "late-after-cancel", phaseRunId: activeWorkflowArgs.phaseRunId, planRevision: activeWorkflowArgs.planRevision, runtimeId: activeWorkflowArgs.runtimeId, activity: "Late progress must be ignored", condition: "working" } }, isError: false }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "late-cancel-checkpoint", toolName: "piss_workflow_checkpoint", result: { content: [{ type: "text", text: "late" }], details: { ...activeWorkflowArgs, outcome: "passed", summary: "Late checkpoint must be ignored" } }, isError: false }));
      }
      if (String(command.id).includes(":scope-change:") && heldBuildArgs) {
        const args = heldBuildArgs;
        heldBuildArgs = undefined;
        workflowScopeChangeAborted = true;
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "late-scope-progress", toolName: "piss_workflow_progress", result: { content: [{ type: "text", text: "late" }], details: { workflowId: args.workflowId, eventId: "late-after-scope", phaseRunId: args.phaseRunId, planRevision: args.planRevision, runtimeId: args.runtimeId, activity: "Late old-revision progress must be ignored", completedSliceIds: ["S-LATE"], passedCriterionIds: ["AC-LATE"], evidence: [{ criterionId: "AC-LATE", summary: "Must not survive scope change" }], condition: "working" } }, isError: false }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "late-scope-checkpoint", toolName: "piss_workflow_checkpoint", result: { content: [{ type: "text", text: "late" }], details: { ...args, eventId: "late-scope-checkpoint", outcome: "passed", summary: "Late old-revision checkpoint must be ignored" } }, isError: false }));
      }
      console.log(JSON.stringify({ id: command.id, type: "response", command: "abort", success: true }));
      if (String(command.id).includes(":scope-change:")) setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 10);
    }
  }
});
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

function runtimeLayer(config: AppConfigShape, workspace: Workspace) {
  const dependencies = Layer.merge(
    Layer.merge(
      Layer.succeed(AppConfig, AppConfig.of(config)),
      Layer.succeed(
        WorkspaceRepository,
        WorkspaceRepository.of({
          list: Effect.succeed([workspace]),
          findById: (id) => Effect.succeed(id === workspace.id ? workspace : undefined),
          ensureCapacity: Effect.void,
          add: () => Effect.die("not used by runtime tests"),
          rename: () => Effect.die("not used by runtime tests"),
          remove: () => Effect.die("not used by runtime tests"),
        }),
      ),
    ),
    Layer.mergeAll(
      Layer.succeed(WorkspaceDirectory, WorkspaceDirectory.of({
        search: () => Effect.succeed([]),
        prepare: (path) => Effect.succeed(path),
        authorize: (path) => Effect.succeed(path),
        openAuthorized: (path) => Effect.promise(() => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)),
        rollbackCreated: () => Effect.die("not used by runtime tests"),
      })),
      Layer.succeed(FileMentionSearch, FileMentionSearch.of({
        search: (_root, query) => Effect.succeed([{ path: `src/${query}.ts`, name: `${query}.ts`, kind: "file" }]),
        release: () => Effect.void,
      })),
      Layer.succeed(PushNotifications, PushNotifications.of({
        capability: { supported: true, vapidPublicKey: "test" },
        subscribe: () => Effect.void,
        unsubscribe: () => Effect.void,
        notify: () => Effect.void,
      })),
    ),
  );
  return PiRuntimeSupervisorLive.pipe(Layer.provideMerge(dependencies));
}

test("blocked phase guidance is included when the workflow resumes", () => {
  const workflow: EngineeringWorkflow = {
    id: "workflow-blocked",
    phase: "building",
    objective: "Bootstrap production safely",
    repairAttempts: 0,
    maxRepairAttempts: 5,
    specification: "# Approved specification",
    plan: "# Approved delivery plan",
    dossier: {
      revision: 3,
      criteria: [{ id: "AC-LEDGER", title: "Resume with the exact operation ledger" }],
      slices: [{ id: "SL-LEDGER", title: "Ledger recovery", criterionIds: ["AC-LEDGER"], dependencies: [] }],
      verificationRequirements: ["Verify the exact receipt identity"],
      operations: [{ id: "OP-LEDGER", kind: "git_push", target: "origin main", constraints: ["No force"], receiptRequired: true, idempotencyKey: "workflow-ledger-push-v3", description: "Push the verified branch", recovery: "Read local and remote refs before retry", evidence: "Local and remote refs are equal" }],
      recoveryRequirements: ["Never replay a completed receipt"],
      exclusions: ["Force push"],
      readiness: [{ id: "RD-LEDGER", label: "Ledger available", status: "passed", detail: "Persisted by the control plane" }],
      unresolved: [],
    },
    checkpoint: null,
    blockedFromPhase: null,
    createdAt: "2026-08-02T20:00:00.000Z",
    updatedAt: "2026-08-02T20:01:00.000Z",
    error: null,
  };

  const prompt = workflowPhasePrompt(workflow, "Use approved runbook /runbooks/bootstrap.md and change CHG-42.");
  assert.match(prompt, /Operator guidance for this phase/);
  assert.match(prompt, /\/runbooks\/bootstrap\.md/);
  assert.match(prompt, /CHG-42/);
  assert.match(prompt, /standing execution authority/i);
  assert.match(prompt, /Do not stop to request confirmation again/i);
  assert.match(prompt, /Approved structured autonomy dossier/);
  assert.match(prompt, /OP-LEDGER/);
  assert.match(prompt, /workflow-ledger-push-v3/);
});

test("repair prompts expose the control-plane finding instead of a passing Review summary", () => {
  const at = "2026-08-02T20:00:00.000Z";
  const workflow: EngineeringWorkflow = {
    id: "workflow-review-guard",
    phase: "repairing",
    objective: "Finish once",
    repairAttempts: 21,
    maxRepairAttempts: 30,
    specification: "# Approved specification",
    plan: "# Approved delivery plan",
    checkpoint: {
      stage: "review",
      outcome: "passed",
      summary: "Review passes with no findings",
      artifact: null,
      toolCallId: "review-pass",
      sequence: 114,
      receivedAt: at,
      eventId: "review-pass",
      phaseRunId: "review-run",
      planRevision: 0,
      runtimeId: "runtime-current",
    },
    blockedFromPhase: null,
    error: "Review reported success but the control plane rejected completion. Missing criterion evidence: AC7",
    createdAt: at,
    updatedAt: at,
  };

  const prompt = workflowPhasePrompt(workflow);
  const findings = prompt.slice(prompt.indexOf("Failure or review findings to repair:"));
  assert.match(findings, /Missing criterion evidence: AC7/);
  assert.doesNotMatch(findings, /Failure or review findings to repair:\s*Review passes with no findings/);
});

test("draft and supervisor events require exact run and consultation identity", () => {
  const defining: EngineeringWorkflow = {
    id: "workflow-identity",
    phase: "defining",
    objective: "Enforce event identity",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: null,
    plan: null,
    checkpoint: null,
    blockedFromPhase: null,
    revision: 2,
    artifactRevision: 0,
    phaseRun: { id: "define-run", phase: "defining", attempt: 0, planRevision: 0, runtimeId: "runtime-current", startedAt: "2026-01-01T00:00:00.000Z" },
    progress: initialWorkflowProgress("2026-01-01T00:00:00.000Z"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
  };
  const missingIdentity = reconcilePersistedWorkflow(defining, [{ sequence: 1, type: "tool_execution_end", timestamp: "2026-01-01T00:01:00.000Z", data: { type: "tool_execution_end", toolCallId: "draft-missing", toolName: "piss_workflow_draft", result: { details: { workflowId: defining.id, eventId: "draft-missing", stage: "define", summary: "Must not apply", specification: "# Stale" } } } }]);
  assert.equal(missingIdentity.specification, null);
  const exactIdentity = reconcilePersistedWorkflow(defining, [{ sequence: 2, type: "tool_execution_end", timestamp: "2026-01-01T00:02:00.000Z", data: { type: "tool_execution_end", toolCallId: "draft-exact", toolName: "piss_workflow_draft", result: { details: { workflowId: defining.id, eventId: "draft-exact", phaseRunId: "define-run", planRevision: 0, runtimeId: "runtime-current", stage: "define", summary: "Current draft", specification: "# Current" } } } }]);
  assert.equal(exactIdentity.specification, "# Current");

  const blocked: EngineeringWorkflow = {
    ...defining,
    phase: "blocked",
    specification: "# Specification",
    plan: "# Plan",
    blockedFromPhase: "building",
    revision: 7,
    artifactRevision: 1,
    phaseRun: { id: "build-run", phase: "building", attempt: 0, planRevision: 1, runtimeId: "runtime-current", startedAt: "2026-01-01T00:00:00.000Z" },
    supervisor: { sessionId: "supervisor-session", status: "consulting", consultations: 2, blockerFingerprint: "blocker", repeatedBlockerCount: 1, pendingGuidance: null, lastAdvice: null, activeConsultationId: "consult-current", consultationPhaseRunId: "build-run", consultationPlanRevision: 1, consultationWorkflowRevision: 7 },
  };
  const advice = { workflowId: blocked.id, eventId: "advice-current", consultationId: "consult-current", phaseRunId: "build-run", planRevision: 1, workflowRevision: 7, runtimeId: "runtime-current", action: "resume_with_guidance", problem: "Recoverable gate", summary: "Resume", guidance: "Continue", basis: "Approved plan", automaticRecovery: true };
  const staleAdvice = reconcilePersistedWorkflow(blocked, [{ sequence: 3, type: "workflow_supervisor_advice", timestamp: "2026-01-01T00:03:00.000Z", data: { ...advice, consultationId: "consult-old" } }]);
  assert.equal(staleAdvice.phase, "blocked");
  const applied = reconcilePersistedWorkflow(blocked, [
    { sequence: 4, type: "workflow_supervisor_advice", timestamp: "2026-01-01T00:04:00.000Z", data: advice },
    { sequence: 5, type: "workflow_supervisor_advice", timestamp: "2026-01-01T00:05:00.000Z", data: advice },
  ]);
  assert.equal(applied.phase, "building");
  assert.equal(applied.processedEventIds?.filter((id) => id === "advice-current").length, 1);
});

test("research blockers cannot be routed into implementation Repair", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const blocked: EngineeringWorkflow = {
    id: "workflow-research-blocked",
    phase: "blocked",
    objective: "Research prior art",
    researchPolicy: "required_external",
    researchQuestions: [{ id: "RQ1", prompt: "What does prior art establish?", required: true }],
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: null,
    checkpoint: { stage: "research", outcome: "blocked", summary: "External capability unavailable", artifact: null, toolCallId: "research-blocked", sequence: 1, receivedAt: at, eventId: "research-blocked", phaseRunId: "research-run", planRevision: 1, runtimeId: "runtime-current" },
    blockedFromPhase: "researching",
    revision: 4,
    artifactRevision: 1,
    phaseRun: { id: "research-run", phase: "researching", attempt: 0, planRevision: 1, runtimeId: "runtime-current", startedAt: at },
    progress: initialWorkflowProgress(at, "blocked"),
    supervisor: { sessionId: "supervisor-research", status: "consulting", consultations: 1, blockerFingerprint: "research", repeatedBlockerCount: 1, pendingGuidance: null, lastAdvice: null, activeConsultationId: "consult-research", consultationPhaseRunId: "research-run", consultationPlanRevision: 1, consultationWorkflowRevision: 4 },
    createdAt: at,
    updatedAt: at,
    error: "External capability unavailable",
  };
  const advice = { workflowId: blocked.id, eventId: "advice-research-repair", consultationId: "consult-research", phaseRunId: "research-run", planRevision: 1, workflowRevision: 4, runtimeId: "runtime-current", action: "enter_repair", problem: "Research is unavailable", summary: "Do not enter Repair", guidance: "Configure research", basis: "Missing capability", automaticRecovery: true };
  const result = reconcilePersistedWorkflow(blocked, [{ sequence: 2, type: "workflow_supervisor_advice", timestamp: at, data: advice }]);
  assert.equal(result.phase, "blocked");
  assert.equal(result.repairAttempts, 0);
  assert.equal(result.supervisor?.lastAdvice?.action, "enter_repair");
});

test("capacity-bound blocked checkpoints retain one exact supervisor recovery decision", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const building: EngineeringWorkflow = {
    id: "workflow-capacity-supervisor",
    phase: "building",
    objective: "Recover at capacity",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: "# Plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 4_095,
    artifactRevision: 1,
    phaseRun: { id: "build-capacity", phase: "building", attempt: 0, planRevision: 1, runtimeId: "runtime-current", startedAt: at },
    progress: initialWorkflowProgress(at),
    processedEventIds: Array.from({ length: 4_095 }, (_, index) => `progress-${index}`),
    createdAt: at,
    updatedAt: at,
    error: null,
  };
  const blocked = applyWorkflowCheckpoint(building, {
    stage: "build",
    outcome: "blocked",
    summary: "Needs bounded supervisor recovery",
    artifact: null,
    toolCallId: "capacity-blocked",
    sequence: 4_096,
    receivedAt: at,
    eventId: "capacity-blocked",
    phaseRunId: "build-capacity",
    planRevision: 1,
    runtimeId: "runtime-current",
  });
  assert.equal(blocked.processedEventIds?.length, 4_096);
  const consultationRevision = (blocked.revision ?? 0) + 1;
  const consulting: EngineeringWorkflow = {
    ...blocked,
    revision: consultationRevision,
    supervisor: {
      sessionId: "supervisor-capacity",
      status: "consulting",
      consultations: 1,
      blockerFingerprint: "capacity-blocker",
      repeatedBlockerCount: 1,
      pendingGuidance: null,
      lastAdvice: null,
      activeConsultationId: "consult-capacity",
      consultationPhaseRunId: "build-capacity",
      consultationPlanRevision: 1,
      consultationWorkflowRevision: consultationRevision,
    },
  };
  const advice = {
    workflowId: consulting.id,
    eventId: "advice-at-capacity",
    consultationId: "consult-capacity",
    phaseRunId: "build-capacity",
    planRevision: 1,
    workflowRevision: consultationRevision,
    runtimeId: "runtime-current",
    action: "resume_with_guidance",
    problem: "Recoverable capacity boundary",
    summary: "Resume from the approved boundary",
    guidance: "Continue without repeating completed work",
    basis: "Approved recovery plan",
    automaticRecovery: true,
  };
  const recovered = reconcilePersistedWorkflow(consulting, [
    { sequence: 4_097, type: "workflow_supervisor_advice", timestamp: at, data: advice },
    { sequence: 4_098, type: "workflow_supervisor_advice", timestamp: at, data: advice },
  ]);
  assert.equal(recovered.phase, "building");
  assert.equal(recovered.supervisor?.lastAdvice?.eventId, "advice-at-capacity");
  assert.equal(recovered.processedEventIds?.length, 4_096, "the separate consultation receipt does not evict phase-run event IDs");
  assert.equal(recovered.revision, consultationRevision + 1, "duplicate advice applies exactly once");
});

test("timeline reconciliation is idempotent for long phase-run event ledgers", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const events = Array.from({ length: 300 }, (_, index) => {
    const eventId = `progress-${index + 1}`;
    return {
      sequence: index + 1,
      type: "workflow_progress_recorded",
      timestamp: at,
      data: { workflowId: "workflow-long-run", event: { eventId, phaseRunId: "build-long", planRevision: 0, runtimeId: "runtime-current", activity: `Progress ${index + 1}`, receivedAt: at } },
    } satisfies OwnedSessionEvent;
  });
  const workflow: EngineeringWorkflow = {
    id: "workflow-long-run",
    phase: "building",
    objective: "Reconcile a long phase",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: "# Plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 300,
    artifactRevision: 0,
    phaseRun: { id: "build-long", phase: "building", attempt: 0, planRevision: 0, runtimeId: "runtime-current", startedAt: at },
    progress: { ...initialWorkflowProgress(at), activity: "Progress 300" },
    processedEventIds: events.map((event) => String((event.data as { event: { eventId: string } }).event.eventId)),
    createdAt: at,
    updatedAt: at,
    error: null,
  };
  const once = reconcilePersistedWorkflow(workflow, events);
  const twice = reconcilePersistedWorkflow(once, events);
  assert.equal(once.reconciledTimelineSequence, 300);
  assert.deepEqual(twice, once);
});

test("guidance restart reconciliation requires transcript evidence rather than a write-ahead reservation", () => {
  const current: EngineeringWorkflow = {
    id: "workflow-guidance-ack-window",
    phase: "building",
    objective: "Reconcile guidance",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Spec",
    plan: "# Plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 2,
    artifactRevision: 1,
    guidance: [{ id: "guide-ack", text: "Apply once", status: "queued", planRevision: 1, submittedRuntimeId: "runtime-old", commandId: "guide-command-ack", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: null, appliedAt: null }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
  };
  const beforeWrite = reconcileTranscriptGuidance(current, [], "2026-01-01T00:01:00.000Z");
  assert.equal(beforeWrite.guidance?.[0]?.status, "queued");
  assert.match(workflowGuidanceForDispatch(beforeWrite) ?? "", /Apply once/);

  const entries = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "[Workflow guidance guide-ack — BUILDING]\n\nApply once" }] } }];
  assert.deepEqual([...transcriptGuidanceIds(current, entries)], ["guide-ack"]);
  const acknowledged = reconcileTranscriptGuidance(current, entries, "2026-01-01T00:02:00.000Z");
  assert.equal(acknowledged.guidance?.[0]?.status, "delivered");
  assert.doesNotMatch(workflowGuidanceForDispatch(acknowledged) ?? "", /Apply once/);
  assert.match(workflowGuidanceForDispatch(acknowledged) ?? "", /do not apply twice/i);
});

test("delivered but unapplied guidance is included at a restart boundary without resetting delivery", () => {
  const workflow: EngineeringWorkflow = {
    id: "workflow-delivered-guidance",
    phase: "building",
    objective: "Resume safely",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: "# Plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 4,
    artifactRevision: 1,
    guidance: [{ id: "guide-delivered", text: "Keep this instruction", status: "delivered", planRevision: 1, submittedRuntimeId: "runtime-old", commandId: "guide-command", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: "2026-01-01T00:01:00.000Z", appliedAt: null }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    error: null,
  };
  const guidance = workflowGuidanceForDispatch(workflow);
  assert.match(guidance ?? "", /guide-delivered/);
  assert.doesNotMatch(guidance ?? "", /Keep this instruction/);
  assert.equal(workflow.guidance?.[0]?.status, "delivered");
});

test("replacement planning dispatches carry-forward guidance without leaking stale IDs into Build", () => {
  const base: EngineeringWorkflow = {
    id: "workflow-carried-guidance",
    phase: "planning",
    objective: "Replan safely",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: "# Prior plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 5,
    artifactRevision: 2,
    guidance: [
      { id: "carried-delivered", text: "Already present in the transcript", status: "delivered", planRevision: 1, applicationPlanRevision: 2, submittedRuntimeId: "runtime-old", commandId: "carried-delivered-command", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: "2026-01-01T00:01:00.000Z", appliedAt: null },
      { id: "carried-queued", text: "Retry this delivery in replacement Plan", status: "queued", planRevision: 1, applicationPlanRevision: 2, submittedRuntimeId: "runtime-old", commandId: "carried-queued-command", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: null, appliedAt: null },
      { id: "legacy-unbound", text: "Legacy carry-forward transcript text", status: "delivered", planRevision: 1, submittedRuntimeId: "runtime-old", commandId: "legacy-command", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: "2026-01-01T00:01:00.000Z", appliedAt: null },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    error: null,
  };
  const planningGuidance = workflowGuidanceForDispatch(base) ?? "";
  assert.match(planningGuidance, /carried-delivered/);
  assert.doesNotMatch(planningGuidance, /Already present in the transcript/);
  assert.match(planningGuidance, /Retry this delivery in replacement Plan/);
  assert.match(planningGuidance, /legacy-unbound/);
  assert.doesNotMatch(planningGuidance, /Legacy carry-forward transcript text/);

  const buildingGuidance = workflowGuidanceForDispatch({ ...base, phase: "building" });
  assert.equal(buildingGuidance, undefined);
});

test("restart reconciliation preserves completed receipts and blocks ambiguous destructive operations", () => {
  const base: EngineeringWorkflow = {
    id: "workflow-receipts",
    phase: "building",
    objective: "Deploy safely",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: "# Specification",
    plan: "# Plan",
    checkpoint: null,
    blockedFromPhase: null,
    revision: 4,
    artifactRevision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
    dossier: { revision: 1, criteria: [{ id: "AC1", title: "Deploy safely" }, { id: "AC2", title: "Verify deployment" }], slices: [{ id: "S1", title: "Deploy", criterionIds: ["AC1"], dependencies: [] }, { id: "S2", title: "Verify", criterionIds: ["AC2"], dependencies: ["S1"] }], verificationRequirements: ["Verify deployment"], operations: [{ id: "deploy", kind: "deployment", target: "staging", constraints: ["idempotency key required"], idempotencyKey: "deploy-1", description: "Deploy", recovery: "Rollback", evidence: "Deployment record" }], recoveryRequirements: ["Rollback on failure"], exclusions: [], readiness: [{ id: "runtime", label: "Runtime", status: "passed", detail: "Ready" }], unresolved: [] },
    phaseRun: { id: "run-build", phase: "building", attempt: 0, planRevision: 1, runtimeId: "runtime-old", startedAt: "2026-01-01T00:00:00.000Z" },
    progress: { ...initialWorkflowProgress("2026-01-01T00:00:00.000Z"), currentSliceId: "S1" },
    guidance: [{ id: "guide-restart", text: "Keep evidence", status: "queued", planRevision: 1, submittedRuntimeId: "runtime-old", commandId: "guide-restart-command", submittedAt: "2026-01-01T00:00:00.000Z", deliveredAt: null, appliedAt: null }],
    operationReceipts: [],
  };
  const recovered = reconcilePersistedWorkflow(base, [
    { sequence: 0, type: "workflow_progress_recorded", timestamp: "2026-01-01T00:00:30.000Z", data: { workflowId: base.id, event: { eventId: "old-child-progress", phaseRunId: "run-build", planRevision: 1, runtimeId: "runtime-replaced", activity: "Stale old-child output", completedSliceIds: ["S2"], receivedAt: "2026-01-01T00:00:30.000Z" } } },
    { sequence: 1, type: "workflow_guidance_delivery", timestamp: "2026-01-01T00:01:00.000Z", data: { workflowId: base.id, event: { eventId: "guidance-delivered:guide-restart-command", guidanceId: "guide-restart", commandId: "guide-restart-command", planRevision: 1, deliveredAt: "2026-01-01T00:01:00.000Z" } } },
    { sequence: 2, type: "tool_execution_end", timestamp: "2026-01-01T00:02:00.000Z", data: { type: "tool_execution_end", toolCallId: "durable-progress-started", toolName: "piss_workflow_progress", result: { details: { workflowId: base.id, eventId: "durable-progress-started", phaseRunId: "run-build", planRevision: 1, runtimeId: "runtime-old", activity: "Deployment started", receipt: { operationId: "deploy", idempotencyKey: "deploy-1", status: "started", target: "staging" } } } } },
    { sequence: 3, type: "tool_execution_end", timestamp: "2026-01-01T00:03:00.000Z", data: { type: "tool_execution_end", toolCallId: "durable-progress", toolName: "piss_workflow_progress", result: { details: { workflowId: base.id, eventId: "durable-progress", phaseRunId: "run-build", planRevision: 1, runtimeId: "runtime-old", activity: "Deployment completed", currentSliceId: "S2", completedSliceIds: ["S1"], passedCriterionIds: ["AC1"], evidence: [{ criterionId: "AC1", summary: "Deployment record verified" }], appliedGuidanceIds: ["guide-restart"], receipt: { operationId: "deploy", idempotencyKey: "deploy-1", status: "completed", target: "staging", evidence: "record-1" } } } } },
    { sequence: 4, type: "workflow_authority_decision", timestamp: "2026-01-01T00:04:00.000Z", data: { workflowId: base.id, eventId: "authority-recovered", operationId: "deploy", phaseRunId: "run-build", planRevision: 1, allowed: true, basis: "Exact envelope match", decidedAt: "2026-01-01T00:04:00.000Z" } },
  ]);
  assert.equal(recovered.processedEventIds?.includes("old-child-progress"), false);
  assert.equal(recovered.guidance?.[0]?.status, "applied");
  assert.deepEqual(recovered.progress?.completedSliceIds, ["S1"]);
  assert.equal(recovered.progress?.evidence[0]?.summary, "Deployment record verified");
  assert.equal(recovered.operationReceipts?.[0]?.status, "completed");
  assert.equal(recovered.authorityDecisions?.[0]?.allowed, true);
  const completed = reconcileWorkflowAfterRestart(recovered, "2026-01-02T00:00:00.000Z");
  assert.equal(completed.phase, "building");
  assert.equal(completed.operationReceipts?.[0]?.status, "completed");
  assert.equal(completed.progress?.currentSliceId, "S2");
  assert.match(completed.progress?.nextAction ?? "", /slice S2.*criterion AC2/i);
  const started = reconcileWorkflowAfterRestart({ ...base, operationReceipts: [{ operationId: "deploy", idempotencyKey: "deploy-1", status: "started", target: "staging", evidence: null, updatedAt: "2026-01-01T00:00:00.000Z" }] }, "2026-01-02T00:00:00.000Z");
  assert.equal(started.phase, "blocked");
  assert.equal(started.operationReceipts?.[0]?.status, "reconciliation_required");
  assert.match(started.error ?? "", /deploy-1/);

  const commitOperation = { id: "commit", kind: "git_commit" as const, target: "repository", idempotencyKey: "commit-once", description: "Commit", recovery: "Revert", evidence: "Commit ID" };
  const commitStarted = reconcileWorkflowAfterRestart({ ...base, dossier: { ...base.dossier!, operations: [commitOperation] }, operationReceipts: [{ operationId: "commit", idempotencyKey: "commit-once", status: "started", target: "repository", evidence: null, updatedAt: "2026-01-01T00:00:00.000Z" }] }, "2026-01-02T00:00:00.000Z");
  assert.equal(commitStarted.phase, "blocked");
  assert.equal(commitStarted.operationReceipts?.[0]?.status, "reconciliation_required");

  const genericOperation = { id: "external-command", kind: "command" as const, target: "approved system", receiptRequired: true, idempotencyKey: "command-once", description: "Mutate", recovery: "Restore", evidence: "System record" };
  const genericStarted = reconcileWorkflowAfterRestart({ ...base, dossier: { ...base.dossier!, operations: [genericOperation] }, operationReceipts: [{ operationId: "external-command", idempotencyKey: "command-once", status: "started", target: "approved system", evidence: null, updatedAt: "2026-01-01T00:00:00.000Z" }] }, "2026-01-02T00:00:00.000Z");
  assert.equal(genericStarted.phase, "blocked");
  assert.equal(genericStarted.operationReceipts?.[0]?.status, "reconciliation_required");
});

test("interrupted workflows recover from their preserved checkpoint", () => {
  const workflow: EngineeringWorkflow = {
    id: "workflow-interrupted",
    phase: "cancelled",
    objective: "Bootstrap production safely",
    repairAttempts: 0,
    maxRepairAttempts: 5,
    specification: "# Approved specification",
    plan: "# Approved delivery plan",
    checkpoint: {
      stage: "build",
      outcome: "blocked",
      summary: "Deployment completed; the next bounded operation needs a decision",
      artifact: null,
      toolCallId: "build-blocked",
      sequence: 8,
      receivedAt: "2026-08-02T20:02:00.000Z",
    },
    blockedFromPhase: null,
    createdAt: "2026-08-02T20:00:00.000Z",
    updatedAt: "2026-08-02T20:03:00.000Z",
    error: "The workflow was cancelled when its runtime stopped",
  };

  assert.equal(interruptedWorkflowRecoveryPhase(workflow), "building");
  assert.equal(interruptedWorkflowRecoveryPhase({ ...workflow, checkpoint: { ...workflow.checkpoint!, outcome: "passed" } }), "verifying");
  assert.equal(interruptedWorkflowRecoveryPhase({ ...workflow, blockedFromPhase: "reviewing" }), "reviewing");
});

test("loads PISS browser resources without trusting project-local resources", () => {
  const workspace = {
    id: decodeWorkspaceId("piss-browser-deadbeef"),
    name: "Browser test",
    root: "/tmp/browser-test",
    trustProjectResources: false,
    createdAt: new Date().toISOString(),
    sessionCount: 0,
    activeSessionCount: 0,
  } satisfies Workspace;
  const args = processArguments(workspace, "Browser session", "/opt/piss/workflow-resources");
  assert.ok(args.includes("/opt/piss/workflow-resources/piss-browser.ts"));
  assert.ok(args.includes("/opt/piss/workflow-resources/skills/piss-ui-verification"));
  assert.ok(args.includes("/opt/piss/workflow-resources/skills/piss-engineering-research"));
  assert.ok(args.includes("--no-approve"));
  assert.ok(!args.includes("--approve"));
  assert.equal(args[args.indexOf("--exclude-tools") + 1], "piss_workflow_supervisor_advice");

  const supervisorArgs = processArguments(workspace, "Supervisor", "/opt/piss/workflow-resources", undefined, true);
  const toolIndex = supervisorArgs.indexOf("--tools");
  assert.ok(supervisorArgs.includes("/opt/piss/workflow-resources/skills/piss-engineering-supervisor"));
  assert.equal(supervisorArgs[toolIndex + 1], "read,grep,find,ls,piss_workflow_supervisor_advice");
  assert.ok(!supervisorArgs.includes("--approve"));
});

test("session snapshots share immutable event payloads instead of deep-cloning them", () => {
  const event: OwnedSessionEvent = {
    sequence: 1,
    type: "message_end",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] } },
  };
  const source = {
    events: [event],
    interactiveRequests: [],
  } as unknown as OwnedSession;

  const snapshots = Array.from({ length: 100 }, () => cloneSession(source));

  assert.notEqual(snapshots[0], source);
  assert.notEqual(snapshots[0]?.events, source.events);
  assert.notEqual(snapshots[0]?.interactiveRequests, source.interactiveRequests);
  assert.ok(snapshots.every((snapshot) => snapshot.events[0] === event));
  assert.ok(snapshots.every((snapshot) => snapshot.events[0]?.data === event.data));
});

test("multi-megabyte tool output is detached from live event projections", () => {
  const fullText = "🧪 large output\n".repeat(200_000);
  const projected = projectEventWithDetachedOutput("session-large", 42, "tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "call-large",
    toolName: "bash",
    result: { content: [{ type: "text", text: fullText }] },
    isError: false,
  });
  const data = projected.data as Record<string, unknown>;
  assert.equal(data.outputRef, "session-large:42:tool-output");
  assert.equal(data.outputTruncated, true);
  assert.ok(Number(data.outputBytes) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.data)) < 4 * 1024);
  assert.equal((projected.output?.value as { content: Array<{ text: string }> }).content[0]?.text, fullText);
});

test("completed messages survive noisy streams while redundant progress is coalesced", () => {
  let events: ReadonlyArray<OwnedSessionEvent> = [];
  let bytes = 0;
  const append = (sequence: number, type: string, data: unknown) => {
    const retained = appendBoundedEvent(events, bytes, {
      sequence,
      type,
      timestamp: new Date(sequence * 1_000).toISOString(),
      data,
    });
    events = retained.events;
    bytes = retained.bytes;
  };

  append(1, "message_end", { message: { role: "user", content: [{ type: "text", text: "Keep my latest prompt" }] } });
  append(2, "message_start", { message: { role: "assistant", content: [] } });
  for (let sequence = 3; sequence <= 1_002; sequence += 1) {
    append(sequence, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
  }
  assert.equal(events.length, 750);
  assert.ok(events.some((event) => event.sequence === 1), "completed user messages are retained ahead of streaming noise");
  assert.equal(events.at(-1)?.sequence, 1_002);

  append(1_003, "tool_execution_start", { toolCallId: "tool-1", toolName: "bash", args: { command: "test" } });
  append(1_004, "tool_execution_update", { toolCallId: "tool-1", toolName: "bash", partialResult: "partial" });
  append(1_005, "tool_execution_update", { toolCallId: "tool-1", toolName: "bash", partialResult: "newer" });
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 1);
  append(1_006, "tool_execution_end", { toolCallId: "tool-1", toolName: "bash", result: "done" });
  append(1_007, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "done" } });
  append(1_008, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });

  assert.equal(events.filter((event) => event.type === "message_update").length, 0);
  assert.equal(events.filter((event) => event.type === "message_start").length, 0);
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 0);
  assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 0);
  assert.deepEqual(events.filter((event) => event.type === "message_end").map((event) => event.sequence), [1, 1_008]);
  assert.equal(events.find((event) => event.type === "tool_execution_end")?.sequence, 1_006);
});

test("reconstructs completed tool calls from a resumed Pi transcript", () => {
  assert.deepEqual(replayEventsFromTranscriptEntry({
    type: "message",
    id: "tool-entry",
    message: {
      role: "toolResult",
      toolCallId: "call-restored",
      toolName: "bash",
      content: [{ type: "text", text: "restored output" }],
      isError: false,
    },
  }), [{
    type: "tool_execution_end",
    data: {
      toolCallId: "call-restored",
      toolName: "bash",
      result: { content: [{ type: "text", text: "restored output" }] },
      isError: false,
    },
  }]);
});

test("bounded history does not discard newer completed tools ahead of older messages", () => {
  let events: ReadonlyArray<OwnedSessionEvent> = [];
  let bytes = 0;
  const append = (event: OwnedSessionEvent) => {
    const retained = appendBoundedEvent(events, bytes, event);
    events = retained.events;
    bytes = retained.bytes;
  };

  for (let sequence = 1; sequence <= 500; sequence += 1) {
    append({ sequence, type: "message_end", timestamp: new Date(sequence * 1_000).toISOString(), data: { message: { role: "assistant", content: [{ type: "text", text: `message ${sequence}` }] } } });
  }
  append({ sequence: 501, type: "tool_execution_end", timestamp: new Date(501_000).toISOString(), data: { toolCallId: "important-tool", toolName: "bash", result: "done" } });
  for (let sequence = 502; sequence <= 751; sequence += 1) {
    append({ sequence, type: "message_end", timestamp: new Date(sequence * 1_000).toISOString(), data: { message: { role: "assistant", content: [{ type: "text", text: `message ${sequence}` }] } } });
  }

  assert.equal(events.length, 750);
  assert.ok(events.some((event) => eventToolId(event) === "important-tool"));
  assert.ok(!events.some((event) => event.sequence === 1));
});

function eventToolId(event: OwnedSessionEvent): string | undefined {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
  const id = (event.data as Record<string, unknown>).toolCallId;
  return typeof id === "string" ? id : undefined;
}

test("bounded tool events retain lifecycle correlation identifiers", () => {
  const projected = projectEventData("tool_execution_update", {
    type: "tool_execution_update",
    toolCallId: "call-large",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "x".repeat(300_000) }] },
  });
  assert.equal((projected as Record<string, unknown>).truncated, true);
  assert.equal((projected as Record<string, unknown>).type, "tool_execution_update");
  assert.equal((projected as Record<string, unknown>).toolCallId, "call-large");
  assert.equal((projected as Record<string, unknown>).toolName, "bash");
  assert.ok(Number((projected as Record<string, unknown>).originalBytes) > 256 * 1024);
  assert.match(JSON.stringify((projected as Record<string, unknown>).partialResult), /truncated by PISS/);

  const failedTool = projectEventData("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "call-failed",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failure".repeat(60_000) }] },
    isError: true,
  }) as Record<string, unknown>;
  assert.equal(failedTool.toolCallId, "call-failed");
  assert.equal(failedTool.isError, true);
  assert.match(JSON.stringify(failedTool.result), /truncated by PISS/);

  const messageEnd = projectEventData("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider failure".repeat(30_000),
      content: [{ type: "text", text: "answer".repeat(60_000) }],
    },
  }) as { message: { role: string; errorMessage: string; content: Array<{ text: string }> } };
  assert.equal(messageEnd.message.role, "assistant");
  assert.match(messageEnd.message.content[0]?.text ?? "", /truncated by PISS/);
  assert.match(messageEnd.message.errorMessage, /truncated by PISS/);
  assert.ok(Buffer.byteLength(messageEnd.message.errorMessage) < 34 * 1024);

  const imageMessage = projectEventData("message_end", {
    message: {
      role: "user",
      content: [
        { type: "text", text: "Inspect this" },
        { type: "image", mimeType: "image/png", data: "sensitive-base64-data" },
      ],
    },
  }) as { message: { content: Array<Record<string, unknown>> } };
  assert.deepEqual(imageMessage.message.content[1], { type: "image", mimeType: "image/png" });
  assert.doesNotMatch(JSON.stringify(imageMessage), /sensitive-base64-data/);

  const agentEnd = projectEventData("agent_end", {
    messages: [{ role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: "another-secret" }] }],
    willRetry: false,
  });
  assert.deepEqual((agentEnd as { messages: Array<{ content: unknown[] }> }).messages[0]?.content[0], { type: "image", mimeType: "image/jpeg" });
  assert.doesNotMatch(JSON.stringify(agentEnd), /another-secret/);
});

test("reconciles a checkpoint from Pi's persisted tool result shape", () => {
  const workflow: EngineeringWorkflow = {
    id: "workflow-1",
    phase: "defining",
    objective: "Recover the approval gate",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: null,
    plan: null,
    checkpoint: null,
    blockedFromPhase: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    error: null,
  };
  const event: OwnedSessionEvent = {
    id: "session-1:7",
    sequence: 7,
    type: "tool_execution_end",
    timestamp: "2026-08-01T12:01:00.000Z",
    data: {
      type: "tool_execution_end",
      toolCallId: "define-checkpoint",
      toolName: "piss_workflow_checkpoint",
      result: {
        content: [{ type: "text", text: "Reported define checkpoint: ready" }],
        details: { workflowId: "workflow-1", stage: "define", outcome: "ready", summary: "Specification ready", artifact: "# Specification" },
        terminate: true,
      },
      isError: false,
    },
  };

  const reconciled = reconcilePersistedWorkflow(workflow, [event]);

  assert.equal(reconciled.phase, "planning");
  assert.equal(reconciled.specification, "# Specification");
  assert.equal(reconciled.checkpoint?.sequence, 7);
  assert.equal(reconciled.updatedAt, event.timestamp);
});

test("owns a Pi RPC process and projects its lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-runtime-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  const previousStagedVideoPaths = process.env.FAKE_PI_STAGED_VIDEO_PATHS;
  const previousAuthorityMarker = process.env.FAKE_PI_AUTHORITY_MARKER;
  const previousMetadata = process.env.FAKE_PI_METADATA;
  const stagedVideoPaths = join(directory, "staged-video-paths.txt");
  const authorityMarker = join(directory, "authority-response.jsonl");
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-test.jsonl");
  process.env.FAKE_PI_STAGED_VIDEO_PATHS = stagedVideoPaths;
  process.env.FAKE_PI_AUTHORITY_MARKER = authorityMarker;
  process.env.FAKE_PI_METADATA = join(directory, "owned-sessions.json");

  try {
    const piCommand = await fakePi(directory, true);
    const workspaceId = decodeWorkspaceId("piss-test-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "PISS test",
      root: directory,
      trustProjectResources: true,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };
    const live = runtimeLayer({ ...config, workflowResourceDir: join(process.cwd(), "workflow-resources") }, workspace);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* PiRuntimeSupervisor;
          const created = yield* supervisor.create({ workspaceId, name: "First owned session", prompt: "Say done" });
          let current = created;
          for (let attempt = 0; attempt < 100 && current.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Delay prompt acknowledgement");
          current = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && current.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Recover context overflow");
          let recoveredOverflow = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && recoveredOverflow.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            recoveredOverflow = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Settle after tools without final response");
          let recoveredFinalResponse = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 200 && (recoveredFinalResponse.status !== "finished" || !JSON.stringify(recoveredFinalResponse.events).includes("Recovered missing final response")); attempt += 1) {
            yield* Effect.sleep("10 millis");
            recoveredFinalResponse = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "/extension-notify");
          const notified = yield* supervisor.get(created.id);
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Malformed browser artifact");
          let malformedArtifact = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && (malformedArtifact.status !== "finished" || !malformedArtifact.events.some((event) => event.type === "browser_artifact_failed")); attempt += 1) {
            yield* Effect.sleep("10 millis");
            malformedArtifact = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Malformed browser video");
          let malformedVideo = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && (malformedVideo.status !== "finished" || !JSON.stringify(malformedVideo.events).includes("Browser video could not be published")); attempt += 1) {
            yield* Effect.sleep("10 millis");
            malformedVideo = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Unmatched browser video");
          let unmatchedVideo = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && (unmatchedVideo.status !== "finished" || !JSON.stringify(unmatchedVideo.events).includes("no matching active recording")); attempt += 1) {
            yield* Effect.sleep("10 millis");
            unmatchedVideo = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Unmatched browser video");
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const paths = yield* Effect.promise(() => readFile(stagedVideoPaths, "utf8").catch(() => ""));
            if (paths.trim().split("\n").length >= 3) break;
            yield* Effect.sleep("10 millis");
          }
          const hangingCommand = yield* supervisor
            .prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "/extension-hang")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.sleep("100 millis");
          yield* supervisor.abort({ sessionId: created.id, runtimeId: created.runtimeId });
          const hangingResult = yield* Fiber.await(hangingCommand);
          const afterHangingAbort = yield* supervisor.get(created.id);
          const models = yield* supervisor.listModels({ sessionId: created.id, runtimeId: created.runtimeId });
          const slashCommands = yield* supervisor.listCommands({ sessionId: created.id, runtimeId: created.runtimeId });
          const mentions = yield* supervisor.searchMentions({ sessionId: created.id, runtimeId: created.runtimeId }, "app");
          const configuredThinking = yield* supervisor.setThinkingLevel({ sessionId: created.id, runtimeId: created.runtimeId }, "high");
          const configuredModel = yield* supervisor.setModel({ sessionId: created.id, runtimeId: created.runtimeId }, "test", "model-b");
          const withUsage = yield* supervisor.refreshUsage({ sessionId: created.id, runtimeId: created.runtimeId });
          const compacted = yield* supervisor.compact({ sessionId: created.id, runtimeId: created.runtimeId });
          const compactionFailureTag = yield* supervisor.compact({ sessionId: created.id, runtimeId: created.runtimeId }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const compactionFailed = yield* supervisor.get(created.id);
          const autoCompaction = yield* supervisor.setAutoCompaction({ sessionId: created.id, runtimeId: created.runtimeId }, false);
          const startMutation = { runtimeId: created.runtimeId, action: "start" as const, objective: "Implement one workflow tracer", researchPolicy: "targeted_external" as const, maxRepairAttempts: 2, mutationId: "start-workflow-once" };
          const firstWorkflowStart = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            startMutation,
          );
          const duplicateWorkflowStart = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            startMutation,
          );
          assert.equal(duplicateWorkflowStart.workflow?.id, firstWorkflowStart.workflow?.id);
          assert.equal(duplicateWorkflowStart.workflow?.processedMutationIds?.filter((id) => id === startMutation.mutationId).length, 1);
          let workflowPlan = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && workflowPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            workflowPlan = yield* supervisor.get(created.id);
          }
          const workflowSpec = workflowPlan;
          yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            guardedWorkflowMutation(workflowPlan, { action: "approve" }, "approve-workflow-once"),
          );
          let workflowReady = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 300 && (workflowReady.workflow?.phase !== "readyToShip" || workflowReady.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            workflowReady = yield* supervisor.get(created.id);
          }
          const acceptMutation = { runtimeId: created.runtimeId, action: "accept" as const, workflowId: workflowReady.workflow!.id, mutationId: "accept-workflow-once", expectedRevision: workflowReady.workflow!.revision ?? 0, expectedPhase: "readyToShip" as const, ...(workflowReady.workflow!.phaseRun ? { expectedPhaseRunId: workflowReady.workflow!.phaseRun.id } : {}) };
          const workflowAccepted = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            acceptMutation,
          );
          const duplicateWorkflowAccepted = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            acceptMutation,
          );
          const staleWorkflowMutation = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            { ...acceptMutation, mutationId: "stale-accept", expectedRevision: Math.max(0, acceptMutation.expectedRevision - 1) },
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));

          const secondStartMutation = { runtimeId: created.runtimeId, action: "start" as const, objective: "Implement a second workflow tracer", maxRepairAttempts: 2, mutationId: "start-second-workflow-once" };
          yield* supervisor.mutateWorkflow({ sessionId: created.id, runtimeId: created.runtimeId }, secondStartMutation);
          let secondWorkflowPlan = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && secondWorkflowPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            secondWorkflowPlan = yield* supervisor.get(created.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            guardedWorkflowMutation(secondWorkflowPlan, { action: "approve" }, "approve-second-workflow-once"),
          );
          let secondWorkflowReady = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 300 && (secondWorkflowReady.workflow?.phase !== "readyToShip" || secondWorkflowReady.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            secondWorkflowReady = yield* supervisor.get(created.id);
          }
          const secondWorkflowAccepted = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            guardedWorkflowMutation(secondWorkflowReady, { action: "accept" }, "accept-second-workflow-once"),
          );
          const replayedFirstWorkflowStart = yield* supervisor.mutateWorkflow(
            { sessionId: created.id, runtimeId: created.runtimeId },
            startMutation,
          );

          const interventionSession = yield* supervisor.create({ workspaceId, name: "Workflow intervention" });
          yield* supervisor.mutateWorkflow(
            { sessionId: interventionSession.id, runtimeId: interventionSession.runtimeId },
            { runtimeId: interventionSession.runtimeId, mutationId: "start-intervention", action: "start", objective: "Exercise workflow user interventions", maxRepairAttempts: 2 },
          );
          let interventionPlan = yield* supervisor.get(interventionSession.id);
          for (let attempt = 0; attempt < 100 && interventionPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interventionPlan = yield* supervisor.get(interventionSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: interventionSession.id, runtimeId: interventionSession.runtimeId },
            guardedWorkflowMutation(interventionPlan, { action: "approve" }, "approve-intervention"),
          );
          let interventionBuild = yield* supervisor.get(interventionSession.id);
          for (let attempt = 0; attempt < 100 && interventionBuild.workflow?.phase !== "building"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interventionBuild = yield* supervisor.get(interventionSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: interventionSession.id, runtimeId: interventionSession.runtimeId },
            guardedWorkflowMutation(interventionBuild, { action: "intervene", feedback: "Keep the implementation slice narrow" }, "guide-intervention-build"),
          );
          let interventionVerify = yield* supervisor.get(interventionSession.id);
          for (let attempt = 0; attempt < 100 && interventionVerify.workflow?.phase !== "verifying"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interventionVerify = yield* supervisor.get(interventionSession.id);
          }
          const queuedVerification = yield* supervisor.mutateWorkflow(
            { sessionId: interventionSession.id, runtimeId: interventionSession.runtimeId },
            guardedWorkflowMutation(interventionVerify, { action: "intervene", feedback: "Summarize deployment risk after review" }, "guide-intervention-verify"),
          );
          let interventionReady = yield* supervisor.get(interventionSession.id);
          for (let attempt = 0; attempt < 300 && (interventionReady.workflow?.phase !== "readyToShip" || interventionReady.workflow.queuedIntervention || interventionReady.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            interventionReady = yield* supervisor.get(interventionSession.id);
          }
          yield* supervisor.stop({ sessionId: interventionSession.id, runtimeId: interventionSession.runtimeId });

          const scopeSession = yield* supervisor.create({ workspaceId, name: "Scope-changing workflow guidance" });
          yield* supervisor.mutateWorkflow(
            { sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId },
            { runtimeId: scopeSession.runtimeId, mutationId: "start-scope-change", action: "start", objective: "Exercise scope-changing guidance and Exercise failed guidance delivery", maxRepairAttempts: 2 },
          );
          let scopePlan = yield* supervisor.get(scopeSession.id);
          for (let attempt = 0; attempt < 100 && (scopePlan.workflow?.phase !== "awaitingPlanApproval" || scopePlan.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            scopePlan = yield* supervisor.get(scopeSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId },
            guardedWorkflowMutation(scopePlan, { action: "approve" }, "approve-scope-change"),
          );
          let scopeBuild = yield* supervisor.get(scopeSession.id);
          for (let attempt = 0; attempt < 100 && (scopeBuild.workflow?.phase !== "building" || !scopeBuild.workflow.progress?.completedSliceIds.includes("S-PRIOR")); attempt += 1) {
            yield* Effect.sleep("10 millis");
            scopeBuild = yield* supervisor.get(scopeSession.id);
          }
          const carryForwardFailureTag = yield* supervisor.mutateWorkflow(
            { sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId },
            guardedWorkflowMutation(scopeBuild, { action: "intervene", feedback: "Carry this failed-delivery guidance into replacement planning" }, "carry-before-scope"),
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
          const authoritativeScope = yield* supervisor.get(scopeSession.id);
          let scopeMutationError = "";
          const scopeChangeFeedback = `Add a newly discovered authority constraint\n${"x".repeat(WORKFLOW_SUPERSEDED_REASON_MAX_LENGTH)}`;
          const scopeMutationApplied = yield* supervisor.mutateWorkflow(
            { sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId },
            { runtimeId: scopeSession.runtimeId, action: "intervene", feedback: scopeChangeFeedback, scopeChange: true, workflowId: authoritativeScope.workflow!.id, mutationId: "scope-change-once", expectedRevision: authoritativeScope.workflow!.revision ?? 0, expectedPhase: "building", expectedPhaseRunId: authoritativeScope.workflow!.phaseRun?.id },
          ).pipe(Effect.as(true), Effect.catch((error) => Effect.sync(() => { scopeMutationError = `${error._tag}: ${error.message}`; return false; })));
          let replannedScope = yield* supervisor.get(scopeSession.id);
          for (let attempt = 0; attempt < 200 && (replannedScope.workflow?.phase !== "awaitingPlanApproval" || replannedScope.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            replannedScope = yield* supervisor.get(scopeSession.id);
          }
          assert.equal(replannedScope.workflow?.phase, "awaitingPlanApproval", JSON.stringify(replannedScope.workflow));
          const reapprovedScope = yield* supervisor.mutateWorkflow(
            { sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId },
            { runtimeId: scopeSession.runtimeId, action: "approve", workflowId: replannedScope.workflow!.id, mutationId: "scope-reapprove-once", expectedRevision: replannedScope.workflow!.revision ?? 0, expectedPhase: "awaitingPlanApproval", expectedPhaseRunId: replannedScope.workflow!.phaseRun?.id },
          );
          yield* supervisor.stop({ sessionId: scopeSession.id, runtimeId: scopeSession.runtimeId });

          const guidanceFailureSession = yield* supervisor.create({ workspaceId, name: "Failed workflow guidance delivery" });
          yield* supervisor.mutateWorkflow(
            { sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId },
            { runtimeId: guidanceFailureSession.runtimeId, mutationId: "start-guidance-failure", action: "start", objective: "Exercise failed guidance delivery", maxRepairAttempts: 2 },
          );
          let guidanceFailurePlan = yield* supervisor.get(guidanceFailureSession.id);
          for (let attempt = 0; attempt < 100 && (guidanceFailurePlan.workflow?.phase !== "awaitingPlanApproval" || guidanceFailurePlan.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            guidanceFailurePlan = yield* supervisor.get(guidanceFailureSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId },
            guardedWorkflowMutation(guidanceFailurePlan, { action: "approve" }, "approve-guidance-failure"),
          );
          let guidanceFailureBuild = yield* supervisor.get(guidanceFailureSession.id);
          for (let attempt = 0; attempt < 100 && guidanceFailureBuild.workflow?.phase !== "building"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            guidanceFailureBuild = yield* supervisor.get(guidanceFailureSession.id);
          }
          const guidanceFailureTag = yield* supervisor.mutateWorkflow(
            { sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId },
            guardedWorkflowMutation(guidanceFailureBuild, { action: "intervene", feedback: "Retain this guidance for deterministic retry" }, "guide-failure"),
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
          const guidanceFailureQueued = yield* supervisor.get(guidanceFailureSession.id);
          const guidanceFailureCancelMutation = { runtimeId: guidanceFailureSession.runtimeId, action: "cancel" as const, workflowId: guidanceFailureQueued.workflow!.id, mutationId: "cancel-guidance-failure", expectedRevision: guidanceFailureQueued.workflow!.revision ?? 0, expectedPhase: "building" as const, expectedPhaseRunId: guidanceFailureQueued.workflow!.phaseRun?.id };
          const guidanceFailureCancelled = yield* supervisor.mutateWorkflow(
            { sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId },
            guidanceFailureCancelMutation,
          );
          const duplicateGuidanceFailureCancelled = yield* supervisor.mutateWorkflow(
            { sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId },
            guidanceFailureCancelMutation,
          );
          yield* supervisor.stop({ sessionId: guidanceFailureSession.id, runtimeId: guidanceFailureSession.runtimeId });

          const failedWorkflowSession = yield* supervisor.create({ workspaceId, name: "Failed workflow continuation" });
          yield* supervisor.mutateWorkflow(
            { sessionId: failedWorkflowSession.id, runtimeId: failedWorkflowSession.runtimeId },
            { runtimeId: failedWorkflowSession.runtimeId, mutationId: "start-failed-workflow", action: "start", objective: "Exercise failed workflow continuation", maxRepairAttempts: 1 },
          );
          let failedWorkflowPlan = yield* supervisor.get(failedWorkflowSession.id);
          for (let attempt = 0; attempt < 100 && failedWorkflowPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            failedWorkflowPlan = yield* supervisor.get(failedWorkflowSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: failedWorkflowSession.id, runtimeId: failedWorkflowSession.runtimeId },
            guardedWorkflowMutation(failedWorkflowPlan, { action: "approve" }, "approve-failed-workflow"),
          );
          let firstFailedWorkflow = yield* supervisor.get(failedWorkflowSession.id);
          for (let attempt = 0; attempt < 300 && firstFailedWorkflow.workflow?.phase !== "failed"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            firstFailedWorkflow = yield* supervisor.get(failedWorkflowSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: failedWorkflowSession.id, runtimeId: failedWorkflowSession.runtimeId },
            guardedWorkflowMutation(firstFailedWorkflow, { action: "continueRepairs", additionalRepairAttempts: 2 }, "extend-failed-workflow"),
          );
          let continuedFailedWorkflow = yield* supervisor.get(failedWorkflowSession.id);
          for (let attempt = 0; attempt < 300 && (continuedFailedWorkflow.workflow?.phase !== "failed" || continuedFailedWorkflow.workflow.repairAttempts <= firstFailedWorkflow.workflow!.repairAttempts); attempt += 1) {
            yield* Effect.sleep("10 millis");
            continuedFailedWorkflow = yield* supervisor.get(failedWorkflowSession.id);
          }
          yield* supervisor.stop({ sessionId: failedWorkflowSession.id, runtimeId: failedWorkflowSession.runtimeId });

          const supervisedSession = yield* supervisor.create({ workspaceId, name: "Automatically supervised workflow" });
          yield* supervisor.mutateWorkflow(
            { sessionId: supervisedSession.id, runtimeId: supervisedSession.runtimeId },
            { runtimeId: supervisedSession.runtimeId, mutationId: "start-supervised", action: "start", objective: "Exercise automatic supervisor recovery", maxRepairAttempts: 2 },
          );
          let supervisedPlan = yield* supervisor.get(supervisedSession.id);
          for (let attempt = 0; attempt < 100 && supervisedPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            supervisedPlan = yield* supervisor.get(supervisedSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: supervisedSession.id, runtimeId: supervisedSession.runtimeId },
            guardedWorkflowMutation(supervisedPlan, { action: "approve" }, "approve-supervised"),
          );
          let supervisedReady = yield* supervisor.get(supervisedSession.id);
          for (let attempt = 0; attempt < 500 && supervisedReady.workflow?.phase !== "readyToShip"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            supervisedReady = yield* supervisor.get(supervisedSession.id);
          }
          const supervisorSibling = supervisedReady.workflow?.supervisor
            ? yield* supervisor.get(supervisedReady.workflow.supervisor.sessionId)
            : undefined;
          yield* supervisor.stop({ sessionId: supervisedSession.id, runtimeId: supervisedSession.runtimeId });
          if (supervisorSibling) yield* supervisor.stop({ sessionId: supervisorSibling.id, runtimeId: supervisorSibling.runtimeId });

          const staleCancelSession = yield* supervisor.create({ workspaceId, name: "Stale cancellation stays isolated" });
          yield* supervisor.mutateWorkflow(
            { sessionId: staleCancelSession.id, runtimeId: staleCancelSession.runtimeId },
            { runtimeId: staleCancelSession.runtimeId, action: "start", objective: "Exercise stale cancellation", maxRepairAttempts: 2, mutationId: "start-stale-cancel" },
          );
          let staleCancelPlan = yield* supervisor.get(staleCancelSession.id);
          for (let attempt = 0; attempt < 100 && (staleCancelPlan.workflow?.phase !== "awaitingPlanApproval" || staleCancelPlan.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            staleCancelPlan = yield* supervisor.get(staleCancelSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: staleCancelSession.id, runtimeId: staleCancelSession.runtimeId },
            guardedWorkflowMutation(staleCancelPlan, { action: "approve" }, "approve-stale-cancel"),
          );
          let staleCancelBuild = yield* supervisor.get(staleCancelSession.id);
          for (let attempt = 0; attempt < 100 && staleCancelBuild.workflow?.phase !== "building"; attempt += 1) {
            yield* Effect.sleep("5 millis");
            staleCancelBuild = yield* supervisor.get(staleCancelSession.id);
          }
          const staleCancelTag = yield* supervisor.mutateWorkflow(
            { sessionId: staleCancelSession.id, runtimeId: staleCancelSession.runtimeId },
            { runtimeId: staleCancelSession.runtimeId, action: "cancel", workflowId: staleCancelBuild.workflow!.id, mutationId: "stale-cancel", expectedRevision: Math.max(0, (staleCancelBuild.workflow!.revision ?? 1) - 1), expectedPhase: "building", expectedPhaseRunId: staleCancelBuild.workflow!.phaseRun?.id },
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
          let staleCancelReady = yield* supervisor.get(staleCancelSession.id);
          for (let attempt = 0; attempt < 400 && staleCancelReady.workflow?.phase !== "readyToShip"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            staleCancelReady = yield* supervisor.get(staleCancelSession.id);
          }
          assert.equal(staleCancelTag, "PiCommandError");
          assert.equal(staleCancelReady.workflow?.phase, "readyToShip", JSON.stringify({ workflow: staleCancelReady.workflow, events: staleCancelReady.events.slice(-20) }));
          yield* supervisor.stop({ sessionId: staleCancelSession.id, runtimeId: staleCancelSession.runtimeId });

          const dispatchRecoverySession = yield* supervisor.create({ workspaceId, name: "Dispatch failure recovery" });
          yield* supervisor.mutateWorkflow(
            { sessionId: dispatchRecoverySession.id, runtimeId: dispatchRecoverySession.runtimeId },
            { runtimeId: dispatchRecoverySession.runtimeId, action: "start", objective: "Exercise dispatch failure recovery", maxRepairAttempts: 2, mutationId: "start-dispatch-recovery" },
          );
          let dispatchRecoveryPlan = yield* supervisor.get(dispatchRecoverySession.id);
          for (let attempt = 0; attempt < 100 && (dispatchRecoveryPlan.workflow?.phase !== "awaitingPlanApproval" || dispatchRecoveryPlan.status !== "finished"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            dispatchRecoveryPlan = yield* supervisor.get(dispatchRecoverySession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: dispatchRecoverySession.id, runtimeId: dispatchRecoverySession.runtimeId },
            guardedWorkflowMutation(dispatchRecoveryPlan, { action: "approve" }, "approve-dispatch-recovery"),
          );
          let dispatchRecoveryReady = yield* supervisor.get(dispatchRecoverySession.id);
          for (let attempt = 0; attempt < 500 && dispatchRecoveryReady.workflow?.phase !== "readyToShip"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            dispatchRecoveryReady = yield* supervisor.get(dispatchRecoverySession.id);
          }
          assert.equal(dispatchRecoveryReady.workflow?.phase, "readyToShip");
          assert.equal(dispatchRecoveryReady.workflow?.repairAttempts, 0);
          assert.equal(dispatchRecoveryReady.workflow?.progress?.retryAttempt, 2);
          assert.match(JSON.stringify(dispatchRecoveryReady.events), /Retrying a transient workflow dispatch failure/);
          assert.match(JSON.stringify(dispatchRecoveryReady.events), /workflow_supervisor_advice/);
          const dispatchSupervisor = dispatchRecoveryReady.workflow?.supervisor
            ? yield* supervisor.get(dispatchRecoveryReady.workflow.supervisor.sessionId)
            : undefined;
          yield* supervisor.stop({ sessionId: dispatchRecoverySession.id, runtimeId: dispatchRecoverySession.runtimeId });
          if (dispatchSupervisor) yield* supervisor.stop({ sessionId: dispatchSupervisor.id, runtimeId: dispatchSupervisor.runtimeId });

          const authoritySession = yield* supervisor.create({ workspaceId, name: "Structured workflow authority" });
          yield* supervisor.mutateWorkflow(
            { sessionId: authoritySession.id, runtimeId: authoritySession.runtimeId },
            { runtimeId: authoritySession.runtimeId, mutationId: "start-authority-outside", action: "start", objective: "Exercise structured workflow authority", maxRepairAttempts: 2 },
          );
          let authorityPlan = yield* supervisor.get(authoritySession.id);
          for (let attempt = 0; attempt < 200 && authorityPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            authorityPlan = yield* supervisor.get(authoritySession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: authoritySession.id, runtimeId: authoritySession.runtimeId },
            guardedWorkflowMutation(authorityPlan, { action: "approve" }, "approve-authority-outside"),
          );
          let authorityOutside = yield* supervisor.get(authoritySession.id);
          for (let attempt = 0; attempt < 200 && authorityOutside.workflow?.authorityDecisions?.at(-1)?.operationId !== "production-deploy"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            authorityOutside = yield* supervisor.get(authoritySession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: authoritySession.id, runtimeId: authoritySession.runtimeId },
            guardedWorkflowMutation(authorityOutside, { action: "cancel" }, "cancel-outside-authority"),
          );
          yield* supervisor.stop({ sessionId: authoritySession.id, runtimeId: authoritySession.runtimeId });
          yield* supervisor.remove({ sessionId: authoritySession.id, runtimeId: authoritySession.runtimeId });

          const authorityApprovedSession = yield* supervisor.create({ workspaceId, name: "Approved structured workflow authority" });
          yield* supervisor.mutateWorkflow(
            { sessionId: authorityApprovedSession.id, runtimeId: authorityApprovedSession.runtimeId },
            { runtimeId: authorityApprovedSession.runtimeId, mutationId: "start-authority-approved", action: "start", objective: "Exercise approved structured workflow authority", maxRepairAttempts: 2 },
          );
          let authorityApprovedPlan = yield* supervisor.get(authorityApprovedSession.id);
          for (let attempt = 0; attempt < 200 && authorityApprovedPlan.workflow?.phase !== "awaitingPlanApproval"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            authorityApprovedPlan = yield* supervisor.get(authorityApprovedSession.id);
          }
          yield* supervisor.mutateWorkflow(
            { sessionId: authorityApprovedSession.id, runtimeId: authorityApprovedSession.runtimeId },
            guardedWorkflowMutation(authorityApprovedPlan, { action: "approve" }, "approve-authority-approved"),
          );
          let authorityReady = yield* supervisor.get(authorityApprovedSession.id);
          for (let attempt = 0; attempt < 400 && authorityReady.workflow?.phase !== "readyToShip"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            authorityReady = yield* supervisor.get(authorityApprovedSession.id);
          }
          yield* supervisor.stop({ sessionId: authorityApprovedSession.id, runtimeId: authorityApprovedSession.runtimeId });

          const staleResult = yield* supervisor.abort({ sessionId: created.id, runtimeId: "stale-runtime" }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Request interactive input");
          let interactiveBlocked = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && interactiveBlocked.status !== "blocked"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveBlocked = yield* supervisor.get(created.id);
          }
          const staleInteractive = yield* supervisor.respondInteractive(
            { sessionId: created.id, runtimeId: "stale-runtime" },
            { requestId: "request-select", value: "Allow" },
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
          yield* supervisor.respondInteractive(
            { sessionId: created.id, runtimeId: created.runtimeId },
            { requestId: "request-select", value: "Allow" },
          );
          let interactiveFinished = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && interactiveFinished.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveFinished = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Request timed input");
          let interactiveTimedOut = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && !interactiveTimedOut.error?.includes("timed out"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveTimedOut = yield* supervisor.get(created.id);
          }
          const archived = yield* supervisor.create({ workspaceId, name: "Archived while active" });
          const activeRemovalResult = yield* supervisor.remove({ sessionId: archived.id, runtimeId: archived.runtimeId }).pipe(
            Effect.as("archived"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const archivedLookup = yield* supervisor.get(archived.id).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const concurrentTarget = yield* supervisor.create({ workspaceId, name: "Concurrent archive" });
          yield* supervisor.stop({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId });
          const concurrentRemovalResults = yield* Effect.all([
            supervisor.remove({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId }).pipe(
              Effect.as("removed"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            ),
            supervisor.remove({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId }).pipe(
              Effect.as("removed"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            ),
          ], { concurrency: "unbounded" });
          const removedLookup = yield* supervisor.get(concurrentTarget.id).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.stop({ sessionId: created.id, runtimeId: created.runtimeId });
          const stopped = yield* supervisor.get(created.id);
          const existingActiveRuntimes = (yield* supervisor.list).filter((session) => session.status !== "stopped" && session.status !== "crashed").length;
          const capacitySessions = yield* Effect.forEach(
            Array.from({ length: Math.max(0, 50 - existingActiveRuntimes) }, (_, index) => index),
            (index) => supervisor.create({ workspaceId, name: `Capacity ${index + 1}` }),
          );
          const activeLimitResult = yield* supervisor.create({ workspaceId, name: "Over capacity" }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* Effect.forEach(
            capacitySessions,
            (session) => supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId }),
            { discard: true },
          );
          const concurrentSessions = yield* Effect.all([
            supervisor.create({ workspaceId, name: "Concurrent one" }),
            supervisor.create({ workspaceId, name: "Concurrent two" }),
          ], { concurrency: "unbounded" });
          yield* Effect.forEach(
            concurrentSessions,
            (session) => supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId }),
            { discard: true },
          );
          const empty = yield* supervisor.create({ workspaceId, name: "" });
          yield* supervisor.prompt({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Hold run open");
          const configurationWhileWorking = yield* supervisor.setModel({ sessionId: empty.id, runtimeId: empty.runtimeId }, "test", "model-a").pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.prompt({ sessionId: empty.id, runtimeId: empty.runtimeId }, "/review");
          yield* supervisor.steer({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Steer while working");
          yield* supervisor.followUp({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Follow up after settling");
          let prompted = yield* supervisor.get(empty.id);
          for (let attempt = 0; attempt < 100 && !prompted.events.some((event) => event.type === "message_update"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            prompted = yield* supervisor.get(empty.id);
          }
          yield* supervisor.stop({ sessionId: empty.id, runtimeId: empty.runtimeId });
          return { current, recoveredOverflow, recoveredFinalResponse, notified, malformedArtifact, malformedVideo, unmatchedVideo, hangingResult, afterHangingAbort, models, slashCommands, mentions, configuredThinking, configuredModel, withUsage, compacted, compactionFailureTag, compactionFailed, autoCompaction, workflowSpec, workflowPlan, workflowReady, workflowAccepted, duplicateWorkflowAccepted, staleWorkflowMutation, secondWorkflowAccepted, replayedFirstWorkflowStart, queuedVerification, interventionReady, scopeMutationApplied, scopeMutationError, carryForwardFailureTag, authoritativeScope, replannedScope, reapprovedScope, guidanceFailureTag, guidanceFailureQueued, guidanceFailureCancelled, duplicateGuidanceFailureCancelled, firstFailedWorkflow, continuedFailedWorkflow, supervisedReady, supervisorSibling, authorityOutside, authorityReady, staleResult, interactiveBlocked, interactiveFinished, interactiveTimedOut, staleInteractive, archived, activeRemovalResult, archivedLookup, concurrentRemovalResults, removedLookup, stopped, activeLimitResult, concurrentSessions, empty, configurationWhileWorking, prompted };
        }).pipe(Effect.provide(live)),
      ),
    );

    assert.equal(result.current.status, "finished");
    assert.equal(result.current.piSessionId, "pi-test-session");
    assert.equal(result.current.sessionFile, join(directory, "pi-test.jsonl"));
    assert.ok(result.current.events.some((event) => event.type === "message_update"));
    assert.equal(result.recoveredOverflow.status, "finished");
    assert.equal(result.recoveredOverflow.error, null, "successful overflow recovery clears the transient provider error");
    assert.equal(result.recoveredOverflow.compaction.status, "succeeded");
    assert.equal(result.recoveredOverflow.compaction.reason, "overflow");
    assert.equal(result.recoveredFinalResponse.status, "finished");
    assert.match(JSON.stringify(result.recoveredFinalResponse.events), /Recovered missing final response/);
    assert.equal(result.notified.status, "finished", "handled extension commands do not strand the session as working");
    assert.match(JSON.stringify(result.notified.events), /MCP Server Status/);
    assert.match(JSON.stringify(result.malformedArtifact.events), /browser_artifact_failed/);
    assert.match(JSON.stringify(result.malformedArtifact.events), /descriptor is invalid/);
    assert.match(JSON.stringify(result.malformedVideo.events), /Browser video could not be published/);
    assert.equal(result.malformedVideo.events.filter((event) => event.type === "browser_recording_started").length, 1);
    assert.equal(result.malformedVideo.events.filter((event) => event.type === "browser_artifact_failed" && JSON.stringify(event.data).includes("663dd98b-a517-48f6-a85d-639ae76077e9")).length, 1);
    assert.doesNotMatch(JSON.stringify(result.malformedVideo.events.filter((event) => event.type.startsWith("browser_"))), /2c240f9a-6091-49a9-bcfa-0c49e6e3aa41/);
    assert.equal(result.unmatchedVideo.events.filter((event) => event.type === "browser_artifact_failed" && JSON.stringify(event.data).includes("79f4dd97-5ca4-4ea6-9418-e1d3ea35f18a")).length, 1);
    const rejectedStagingPaths = (await readFile(stagedVideoPaths, "utf8")).trim().split("\n");
    assert.equal(rejectedStagingPaths.length, 3, "malformed, unmatched, and replayed handoffs each staged bytes");
    for (const path of rejectedStagingPaths) await assert.rejects(readFile(path), /ENOENT/);
    assert.equal(Exit.isFailure(result.hangingResult), true);
    assert.equal(result.afterHangingAbort.status, "finished", "aborting an unacknowledged extension command keeps the session usable");
    assert.deepEqual(result.models.map((model) => model.id), ["model-a", "model-b"]);
    assert.deepEqual(result.models[0]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
    assert.deepEqual(result.slashCommands, [
      { name: "review", description: "Review changes", source: "extension", scope: "user" },
      { name: "fix-tests", description: "Fix tests", source: "prompt", scope: "project" },
    ]);
    assert.doesNotMatch(JSON.stringify(result.slashCommands), /secret/);
    assert.deepEqual(result.mentions, [{ path: "src/app.ts", name: "app.ts", kind: "file" }]);
    assert.equal(result.configuredThinking.thinkingLevel, "high");
    assert.equal(result.configuredModel.model?.id, "model-b");
    assert.equal(result.configuredModel.thinkingLevel, "off");
    assert.equal(result.withUsage.usage?.contextUsage?.percent, 15);
    assert.equal(result.withUsage.usage?.cost, 0.25);
    assert.equal(result.compacted.compaction.status, "succeeded");
    assert.equal(result.compacted.compaction.tokensBefore, 30000);
    assert.equal(result.compacted.compaction.estimatedTokensAfter, 9000);
    assert.equal(result.compactionFailureTag, "PiCommandError");
    assert.equal(result.compactionFailed.compaction.status, "failed");
    assert.match(result.compactionFailed.compaction.error ?? "", /simulated compaction failure/);
    assert.equal(result.autoCompaction.autoCompactionEnabled, false);
    assert.equal(result.workflowSpec.workflow?.specification, "# Approved specification");
    assert.equal(result.workflowPlan.workflow?.researchPolicy, "targeted_external");
    assert.equal(result.workflowPlan.workflow?.researchBrief?.findings[0]?.id, "F-LOCAL");
    assert.deepEqual(result.workflowPlan.workflow?.appliedResearchFindingIds, ["F-LOCAL"]);
    assert.equal(result.workflowPlan.workflow?.plan, "# Complete delivery plan");
    assert.match(JSON.stringify(result.workflowReady.events), /Approved complete delivery plan/);
    assert.doesNotMatch(JSON.stringify(result.workflowReady.events), /Approved one-task plan/);
    assert.equal(result.workflowReady.workflow?.phase, "readyToShip");
    assert.equal(result.workflowReady.workflow?.repairAttempts, 0, "a successful Review does not dispatch or count a no-op Repair");
    assert.equal(result.workflowReady.events.filter((event) => event.type === "message_end" && JSON.stringify(event.data).includes("Repair attempt")).length, 0);
    assert.equal(result.workflowReady.workflow?.executionAuthority?.mode, "approved_plan");
    assert.equal(result.workflowReady.status, "finished");
    assert.equal(result.workflowAccepted.workflow?.phase, "accepted");
    assert.equal(result.duplicateWorkflowAccepted.workflow?.revision, result.workflowAccepted.workflow?.revision);
    assert.deepEqual(result.duplicateWorkflowAccepted.workflow?.processedMutationIds, ["start-workflow-once", "approve-workflow-once", "accept-workflow-once"]);
    assert.equal(result.staleWorkflowMutation, "PiCommandError");
    assert.equal(result.replayedFirstWorkflowStart.workflow?.id, result.secondWorkflowAccepted.workflow?.id);
    assert.equal(result.replayedFirstWorkflowStart.workflow?.phase, "accepted");
    assert.equal(result.replayedFirstWorkflowStart.workflow?.objective, "Implement a second workflow tracer");
    assert.equal(result.replayedFirstWorkflowStart.workflow?.revision, result.secondWorkflowAccepted.workflow?.revision);
    assert.match(JSON.stringify(result.interventionReady.events), /Workflow guidance .*BUILD/);
    assert.ok(["queued", "delivered"].includes(result.queuedVerification.workflow?.guidance?.at(-1)?.status ?? ""));
    assert.equal(result.interventionReady.workflow?.guidance?.at(-1)?.status, "applied", JSON.stringify({ workflow: result.interventionReady.workflow, events: result.interventionReady.events.slice(-30) }));
    assert.equal(result.interventionReady.workflow?.queuedIntervention, undefined);
    assert.equal(result.interventionReady.workflow?.guidance?.at(-1)?.text, "Summarize deployment risk after review");
    assert.equal(result.scopeMutationApplied, true, result.scopeMutationError);
    assert.equal(result.carryForwardFailureTag, "PiCommandError");
    assert.equal(result.authoritativeScope.workflow?.guidance?.find((item) => item.id === "carry-before-scope")?.status, "queued");
    assert.equal(result.replannedScope.workflow?.phase, "awaitingPlanApproval");
    assert.equal(result.replannedScope.workflow?.executionAuthority, undefined);
    assert.ok((result.replannedScope.workflow?.artifactRevision ?? 0) > (result.authoritativeScope.workflow?.executionAuthority?.planRevision ?? 0));
    assert.equal(result.reapprovedScope.workflow?.executionAuthority?.planRevision, result.replannedScope.workflow?.artifactRevision);
    assert.ok((result.reapprovedScope.workflow?.executionAuthority?.planRevision ?? 0) > (result.authoritativeScope.workflow?.executionAuthority?.planRevision ?? 0));
    assert.equal(result.replannedScope.workflow?.processedEventIds?.includes("late-after-scope"), false);
    assert.equal(result.replannedScope.workflow?.processedEventIds?.includes("late-scope-checkpoint"), false);
    assert.match(JSON.stringify(result.replannedScope.events), /Add a newly discovered authority constraint/);
    assert.match(JSON.stringify(result.replannedScope.events), /Carry this failed-delivery guidance into replacement planning/);
    assert.equal(result.replannedScope.events.filter((event) => event.type === "workflow_guidance_delivery" && JSON.stringify(event.data).includes("scope-change-once")).length, 1);
    assert.equal(result.replannedScope.events.filter((event) => event.type === "workflow_guidance_delivery" && JSON.stringify(event.data).includes("carry-before-scope")).length, 1);
    assert.equal(result.replannedScope.workflow?.guidance?.find((item) => item.id === "scope-change-once")?.status, "applied");
    assert.equal(result.replannedScope.workflow?.guidance?.find((item) => item.id === "carry-before-scope")?.status, "applied");
    assert.equal(result.replannedScope.workflow?.guidance?.find((item) => item.id === "carry-before-scope")?.planRevision, result.authoritativeScope.workflow?.artifactRevision);
    assert.equal(result.replannedScope.workflow?.guidance?.find((item) => item.id === "carry-before-scope")?.applicationPlanRevision, result.replannedScope.workflow?.artifactRevision);
    assert.equal(result.replannedScope.workflow?.guidance?.find((item) => item.id === "scope-change-once")?.planRevision, result.replannedScope.workflow?.artifactRevision);
    assert.deepEqual(result.replannedScope.workflow?.supersededRevisions?.at(-1)?.completedSliceIds, ["S-PRIOR"]);
    assert.deepEqual(result.replannedScope.workflow?.supersededRevisions?.at(-1)?.passedCriterionIds, ["AC-PRIOR"]);
    assert.equal(result.replannedScope.workflow?.supersededRevisions?.at(-1)?.evidence[0]?.summary, "Prior revision evidence");
    assert.equal(result.replannedScope.workflow?.supersededRevisions?.at(-1)?.reason.length, WORKFLOW_SUPERSEDED_REASON_MAX_LENGTH);
    assert.match(result.replannedScope.workflow?.supersededRevisions?.at(-1)?.reason ?? "", /^Add a newly discovered authority constraint/u);
    assert.ok((result.replannedScope.workflow?.guidance?.find((item) => item.id === "scope-change-once")?.text.length ?? 0) > WORKFLOW_SUPERSEDED_REASON_MAX_LENGTH);
    assert.equal(result.replannedScope.workflow?.processedMutationIds?.includes("scope-change-once"), true);
    assert.equal(result.guidanceFailureTag, "PiCommandError");
    assert.equal(result.guidanceFailureQueued.workflow?.guidance?.at(-1)?.status, "queued");
    assert.equal(result.guidanceFailureCancelled.workflow?.phase, "cancelled");
    assert.equal(result.guidanceFailureCancelled.workflow?.cancellationMutationId, "cancel-guidance-failure");
    assert.equal(result.duplicateGuidanceFailureCancelled.workflow?.revision, result.guidanceFailureCancelled.workflow?.revision);
    assert.equal(result.guidanceFailureCancelled.workflow?.guidance?.at(-1)?.status, "queued");
    assert.doesNotMatch(result.guidanceFailureCancelled.workflow?.progress?.activity ?? "", /Late progress/);
    assert.notEqual(result.guidanceFailureCancelled.workflow?.checkpoint?.summary, "Late checkpoint must be ignored");
    assert.equal(result.firstFailedWorkflow.workflow?.phase, "failed");
    assert.equal(result.firstFailedWorkflow.workflow?.repairAttempts, 1);
    assert.equal(result.firstFailedWorkflow.workflow?.maxRepairAttempts, 1);
    assert.equal(result.continuedFailedWorkflow.workflow?.phase, "failed", JSON.stringify(result.continuedFailedWorkflow.workflow));
    assert.equal(result.continuedFailedWorkflow.workflow?.repairAttempts, 3);
    assert.equal(result.continuedFailedWorkflow.workflow?.maxRepairAttempts, 3);
    assert.equal(result.supervisedReady.workflow?.phase, "readyToShip");
    assert.equal(result.supervisedReady.workflow?.repairAttempts, 0);
    assert.equal(result.supervisedReady.workflow?.supervisor?.lastAdvice?.action, "resume_with_guidance");
    assert.equal(result.supervisedReady.workflow?.supervisor?.lastAdvice?.problem, "The build needs to retry the documented recovery procedure.");
    assert.match(JSON.stringify(result.supervisedReady.events), /workflow_supervisor_consulting/);
    assert.match(JSON.stringify(result.supervisedReady.events), /workflow_supervisor_advice/);
    assert.equal(result.supervisedReady.events.filter((event) => event.type === "workflow_supervisor_advice").length, 1);
    assert.equal(result.supervisedReady.workflow?.processedEventIds?.some((id) => id.startsWith("supervisor-advice:")), false);
    assert.ok(result.supervisorSibling?.name.startsWith("Supervisor ·"));
    assert.deepEqual(result.authorityOutside.interactiveRequests, [], "authority outside the approved plan is denied without leaking a raw Pi modal");
    assert.equal(result.authorityOutside.workflow?.authorityDecisions?.at(-1)?.allowed, false);
    assert.equal(result.authorityOutside.workflow?.authorityDecisions?.at(-1)?.operationId, "production-deploy");
    assert.equal(result.authorityReady.workflow?.phase, "readyToShip", JSON.stringify(result.authorityReady.workflow));
    assert.equal(result.authorityReady.workflow?.authorityDecisions?.at(-1)?.operationId, "approved-edit");
    assert.equal(result.authorityReady.workflow?.authorityDecisions?.at(-1)?.allowed, true);
    assert.equal(result.authorityReady.workflow?.authorityDecisions?.at(-1)?.source, "piss_workflow_authority_request");
    assert.equal(result.authorityReady.workflow?.authorityDecisions?.at(-1)?.correlationId, "workflow-authority-request");
    assert.equal(result.authorityReady.workflow?.authorityDecisions?.filter((decision) => decision.operationId === "approved-edit").length, 1);
    assert.equal(result.authorityReady.workflow?.repairAttempts, 0);
    assert.equal(result.authorityReady.workflow?.progress?.maxTransientRetries, 2);
    assert.match(JSON.stringify(result.authorityReady.events), /auto_retry_start/);
    assert.deepEqual(result.authorityReady.interactiveRequests, []);
    assert.match(JSON.stringify(result.authorityReady.events), /workflow_authority_decision/);
    assert.match(JSON.stringify(result.authorityReady.events), /workflow_interactive_request_rejected/);
    assert.doesNotMatch(JSON.stringify({ models: result.models, events: result.configuredModel.events }), /super-secret|credential@example/);
    assert.equal(result.staleResult, "StaleRuntimeGenerationError");
    assert.equal(result.interactiveBlocked.status, "blocked");
    assert.equal(result.interactiveBlocked.interactiveRequests[0]?.method, "select");
    assert.equal(result.interactiveFinished.status, "finished");
    assert.deepEqual(result.interactiveFinished.interactiveRequests, []);
    assert.deepEqual(result.interactiveTimedOut.interactiveRequests, []);
    assert.match(result.interactiveTimedOut.error ?? "", /timed out/i);
    assert.equal(result.staleInteractive, "StaleRuntimeGenerationError");
    assert.equal(result.archived.workspaceId, result.current.workspaceId);
    assert.equal(result.archived.status, "idle");
    assert.equal(result.activeRemovalResult, "archived");
    assert.equal(result.archivedLookup, "SessionNotFoundError");
    assert.deepEqual([...result.concurrentRemovalResults].sort(), ["SessionNotFoundError", "removed"]);
    assert.equal(result.removedLookup, "SessionNotFoundError");
    assert.equal(result.stopped.status, "stopped");
    assert.equal(result.activeLimitResult, "ActiveRuntimeLimitError");
    assert.equal(result.concurrentSessions.length, 2);
    assert.ok(result.concurrentSessions.every((session) => session.workspaceId === result.current.workspaceId));
    assert.equal(result.empty.name, "New session");
    assert.equal(result.empty.status, "idle");
    assert.equal(result.empty.events.length, 0);
    assert.equal(result.configurationWhileWorking, "PiCommandError");
    assert.ok(result.prompted.events.some((event) => event.type === "message_update"));
    const authorityResponses = (await readFile(authorityMarker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { durable: boolean });
    assert.deepEqual(authorityResponses, [{ durable: true }], "the approved response is released only after its authority decision is durable");
    const persisted = JSON.parse(await readFile(join(directory, "owned-sessions.json"), "utf8")) as { sessions: Array<{ id: string; sessionFileIdentity: unknown }> };
    assert.ok(persisted.sessions.find((session) => session.id === result.current.id)?.sessionFileIdentity, "lazy Pi transcript identity is captured after the run settles");
    const wireCommands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.ok(wireCommands.includes("steer"));
    assert.ok(wireCommands.includes("follow_up"));
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    for (const args of argumentSets) {
      assert.ok(args.includes("--mode"));
      assert.ok(args.includes("rpc"));
      if (args.includes("--tools")) {
        assert.ok(args.includes("--no-approve"));
        assert.ok(!args.includes("--approve"));
      } else assert.ok(args.includes("--approve"));
      assert.ok(args.includes("--extension"));
      assert.ok(args.some((arg) => arg.endsWith("/piss-browser.ts")));
      assert.ok(args.includes("--skill"));
      assert.ok(args.some((arg) => arg.endsWith("/skills/piss-ui-verification")));
    }
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    if (previousStagedVideoPaths === undefined) delete process.env.FAKE_PI_STAGED_VIDEO_PATHS;
    else process.env.FAKE_PI_STAGED_VIDEO_PATHS = previousStagedVideoPaths;
    if (previousAuthorityMarker === undefined) delete process.env.FAKE_PI_AUTHORITY_MARKER;
    else process.env.FAKE_PI_AUTHORITY_MARKER = previousAuthorityMarker;
    if (previousMetadata === undefined) delete process.env.FAKE_PI_METADATA;
    else process.env.FAKE_PI_METADATA = previousMetadata;
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports a validated Pi transcript and resumes it in an owned runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-import-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const sessionFile = join(directory, "pi-import.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = sessionFile;

  try {
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: directory }),
      JSON.stringify({ type: "message", id: "imported-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Preserved import" }] } }),
      "",
    ].join("\n"));
    const piCommand = await fakePi(directory);
    const workspaceId = decodeWorkspaceId("piss-import-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Import test",
      root: directory,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const imported = yield* supervisor.import({ workspaceId, name: "Imported session", sessionFile });
      const duplicate = yield* supervisor.import({ workspaceId, name: "Duplicate", sessionFile }).pipe(
        Effect.as("unexpected"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const resumed = yield* supervisor.resume({ sessionId: imported.id, runtimeId: imported.runtimeId });
      return { imported, duplicate, resumed };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(result.imported.status, "stopped");
    assert.equal(result.imported.piSessionId, "pi-test-session");
    assert.equal(result.imported.sessionFile, sessionFile);
    assert.equal(result.duplicate, "SessionResumeError");
    assert.equal(result.resumed.id, result.imported.id);
    assert.notEqual(result.resumed.runtimeId, result.imported.runtimeId);
    assert.ok(result.resumed.events.some((event) => JSON.stringify(event.data).includes("Preserved import")));
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(argumentSets[0]?.includes("--session"));
    assert.ok(argumentSets[0]?.includes(sessionFile));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupting creation terminates the child and preserves a visible failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-interrupt-"));
  const argsFile = join(directory, "args.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousHang = process.env.FAKE_PI_HANG;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_HANG = "1";
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-test.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceId = decodeWorkspaceId("piss-interrupt-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Interrupt test",
      root: directory,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* PiRuntimeSupervisor;
          const fiber = yield* supervisor
            .create({ workspaceId, name: "Interrupted", prompt: "Never accepted" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.sleep("30 millis");
          yield* Fiber.interrupt(fiber);
          const sessions = yield* supervisor.list;
          return sessions[0];
        }).pipe(Effect.provide(runtimeLayer(config, workspace))),
      ),
    );

    assert.ok(result);
    assert.equal(result.status, "crashed");
    assert.match(result.error ?? "", /interrupted/i);
    if (result.pid !== null) assert.throws(() => process.kill(result.pid!, 0));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousHang === undefined) delete process.env.FAKE_PI_HANG;
    else process.env.FAKE_PI_HANG = previousHang;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime resume waits for screenshot handoffs from the crashed runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-artifact-resume-"));
  const argsFile = join(directory, "args.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-artifact-resume.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceId = decodeWorkspaceId("piss-artifact-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Artifact resume test",
      root: directory,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const created = yield* supervisor.create({ workspaceId, name: "Crash capture" });
      yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Crash after browser artifacts");
      let crashed = yield* supervisor.get(created.id);
      for (let attempt = 0; attempt < 200 && crashed.status !== "crashed"; attempt += 1) {
        yield* Effect.sleep("5 millis");
        crashed = yield* supervisor.get(created.id);
      }
      assert.equal(crashed.status, "crashed");
      const resumed = yield* supervisor.resume({ sessionId: crashed.id, runtimeId: crashed.runtimeId });
      return yield* supervisor.get(resumed.id);
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(result.events.filter((event) => event.type === "browser_artifact_created").length, 24);
    assert.equal(result.events.some((event) => event.type === "browser_artifact_failed"), false);
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recreates an unmaterialized idle runtime under the same session after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-lazy-restart-"));
  const argsFile = join(directory, "args.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-lazy-restart.jsonl");

  try {
    const piCommand = await fakePi(directory, true);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-lazy-restart-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Lazy restart test",
      root: workspaceRoot,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: join(directory, "state"),
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const created = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      return yield* supervisor.create({ workspaceId, name: "Blank but durable" });
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const resumed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = (yield* supervisor.list)[0]!;
      yield* supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId });
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(resumed.id, created.id);
    assert.notEqual(resumed.runtimeId, created.runtimeId);
    assert.equal(resumed.status, "idle");
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(argumentSets.length, 2);
    assert.ok(argumentSets.every((arguments_) => !arguments_.includes("--session")));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart reconciles persisted approval guidance before granting authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-approval-guidance-restart-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-approval-guidance-restart.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-approval-guidance-restart-deadbeef");
    const workspace: Workspace = { id: workspaceId, name: "Approval guidance restart test", root: workspaceRoot, trustProjectResources: false, createdAt: new Date().toISOString(), sessionCount: 0, activeSessionCount: 0 };
    const config: AppConfigShape = { host: "127.0.0.1", port: 4318, stateDir: join(directory, "state"), publicDir: directory, piCommand, piSessionRoots: [directory], browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() }, workspaceSeeds: [], workspaceDiscoveryRoots: [] };

    const beforeRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = yield* supervisor.create({ workspaceId, name: "Persisted approval guidance" });
      yield* supervisor.mutateWorkflow(
        { sessionId: session.id, runtimeId: session.runtimeId },
        { runtimeId: session.runtimeId, mutationId: "start-persisted-approval-guidance", action: "start", objective: "Exercise persisted approval guidance", maxRepairAttempts: 2 },
      );
      let approval = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 300 && (approval.workflow?.phase !== "awaitingPlanApproval" || approval.status !== "finished"); attempt += 1) {
        yield* Effect.sleep("10 millis");
        approval = yield* supervisor.get(session.id);
      }
      assert.equal(approval.workflow?.phase, "awaitingPlanApproval");
      return approval;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const metadataPath = join(config.stateDir, "owned-sessions.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { sessions: Array<{ workflow?: EngineeringWorkflow; resumeAfterRestart?: boolean; resumeRunAfterRestart?: boolean }> };
    const persisted = metadata.sessions[0]?.workflow;
    if (!persisted) throw new Error("Expected persisted approval workflow");
    const revision = persisted.artifactRevision ?? persisted.dossier?.revision ?? 1;
    const priorRevision = Math.max(0, revision - 1);
    const { executionAuthority: _authority, phaseRun: _phaseRun, ...unapproved } = persisted;
    metadata.sessions[0]!.workflow = {
      ...unapproved,
      phase: "awaitingPlanApproval",
      guidance: [
        { id: "persisted-current", text: "Apply current persisted scope", status: "delivered", planRevision: revision, submittedRuntimeId: beforeRestart.runtimeId, commandId: "persisted-current-command", submittedAt: persisted.updatedAt, deliveredAt: persisted.updatedAt, appliedAt: null },
        { id: "persisted-explicit", text: "Apply explicit carried scope", status: "delivered", planRevision: priorRevision, applicationPlanRevision: revision, submittedRuntimeId: beforeRestart.runtimeId, commandId: "persisted-explicit-command", submittedAt: persisted.updatedAt, deliveredAt: persisted.updatedAt, appliedAt: null },
        { id: "persisted-legacy", text: "Apply legacy carried scope", status: "delivered", planRevision: priorRevision, submittedRuntimeId: beforeRestart.runtimeId, commandId: "persisted-legacy-command", submittedAt: persisted.updatedAt, deliveredAt: persisted.updatedAt, appliedAt: null },
      ],
    };
    metadata.sessions[0]!.resumeAfterRestart = false;
    metadata.sessions[0]!.resumeRunAfterRestart = false;
    await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });

    const afterRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      let approval = (yield* supervisor.list)[0]!;
      for (let attempt = 0; attempt < 500 && (approval.workflow?.phase !== "awaitingPlanApproval" || approval.status !== "finished" || approval.workflow.guidance?.some((item) => item.status !== "applied")); attempt += 1) {
        yield* Effect.sleep("10 millis");
        approval = yield* supervisor.get(approval.id);
      }
      assert.notEqual(approval.runtimeId, beforeRestart.runtimeId);
      assert.equal(approval.workflow?.phase, "awaitingPlanApproval");
      assert.equal(approval.workflow?.executionAuthority, undefined);
      assert.deepEqual(approval.workflow?.guidance?.map((item) => item.status), ["applied", "applied", "applied"]);
      const approved = yield* supervisor.mutateWorkflow(
        { sessionId: approval.id, runtimeId: approval.runtimeId },
        guardedWorkflowMutation(approval, { action: "approve" }, "approve-reconciled-guidance"),
      );
      assert.ok(approved.workflow?.executionAuthority);
      assert.notEqual(approved.workflow?.phase, "planning");
      let completed = approved;
      for (let attempt = 0; attempt < 400 && (completed.workflow?.phase !== "readyToShip" || completed.status !== "finished"); attempt += 1) {
        yield* Effect.sleep("10 millis");
        completed = yield* supervisor.get(approval.id);
      }
      assert.equal(completed.workflow?.phase, "readyToShip");
      return { approval, approved, completed };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(afterRestart.approval.workflow?.processedMutationIds?.includes("approve-reconciled-guidance"), false);
    assert.equal(afterRestart.approved.workflow?.processedMutationIds?.includes("approve-reconciled-guidance"), true);
    assert.equal(afterRestart.completed.workflow?.executionAuthority?.planRevision, revision);
    const commands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.ok(commands.filter((command) => command === "prompt").length >= 3, "Define, initial Plan, and recovered Plan were dispatched");
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("restarts an active workflow from durable progress and completed receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-workflow-restart-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-workflow-restart.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-workflow-restart-deadbeef");
    const workspace: Workspace = { id: workspaceId, name: "Workflow restart test", root: workspaceRoot, trustProjectResources: false, createdAt: new Date().toISOString(), sessionCount: 0, activeSessionCount: 0 };
    const config: AppConfigShape = { host: "127.0.0.1", port: 4318, stateDir: join(directory, "state"), publicDir: directory, piCommand, piSessionRoots: [directory], browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() }, workspaceSeeds: [], workspaceDiscoveryRoots: [] };

    const beforeRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = yield* supervisor.create({ workspaceId, name: "Workflow survives restart" });
      yield* supervisor.mutateWorkflow({ sessionId: session.id, runtimeId: session.runtimeId }, { runtimeId: session.runtimeId, mutationId: "start-restart-workflow", action: "start", objective: "Exercise scope-changing guidance and Exercise failed guidance delivery", maxRepairAttempts: 2 });
      let plan = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 200 && (plan.workflow?.phase !== "awaitingPlanApproval" || plan.status !== "finished"); attempt += 1) {
        yield* Effect.sleep("10 millis");
        plan = yield* supervisor.get(session.id);
      }
      yield* supervisor.mutateWorkflow({ sessionId: session.id, runtimeId: session.runtimeId }, guardedWorkflowMutation(plan, { action: "approve" }, "approve-restart-workflow"));
      let building = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 200 && !building.workflow?.operationReceipts?.some((receipt) => receipt.idempotencyKey === "scope-write-once" && receipt.status === "completed"); attempt += 1) {
        yield* Effect.sleep("10 millis");
        building = yield* supervisor.get(session.id);
      }
      assert.equal(building.workflow?.phase, "building");
      assert.deepEqual(building.workflow?.progress?.completedSliceIds, ["S-PRIOR"]);
      const deliveryFailure = yield* supervisor.mutateWorkflow(
        { sessionId: session.id, runtimeId: session.runtimeId },
        guardedWorkflowMutation(building, { action: "intervene", feedback: "Retry this guidance after restart" }, "guide-restart-workflow"),
      ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
      assert.equal(deliveryFailure, "PiCommandError");
      const queued = yield* supervisor.get(session.id);
      assert.equal(queued.workflow?.guidance?.at(-1)?.status, "queued");
      return queued;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const metadataPath = join(config.stateDir, "owned-sessions.json");
    const staleMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as { sessions: Array<{ workflow?: EngineeringWorkflow }> };
    const persistedWorkflow = staleMetadata.sessions[0]?.workflow;
    if (!persistedWorkflow?.progress) throw new Error("Expected persisted workflow progress fixture");
    staleMetadata.sessions[0]!.workflow = {
      ...persistedWorkflow,
      progress: { ...persistedWorkflow.progress, currentSliceId: "S-PRIOR", activity: "Metadata write lagged durable timeline", completedSliceIds: [], passedCriterionIds: [], evidence: [] },
      operationReceipts: [],
      processedEventIds: (persistedWorkflow.processedEventIds ?? []).filter((id) => id !== "scope-started" && id !== "scope-progress"),
    };
    await writeFile(metadataPath, JSON.stringify(staleMetadata), { mode: 0o600 });

    const afterRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      let session = (yield* supervisor.list)[0]!;
      for (let attempt = 0; attempt < 400 && session.workflow?.phase !== "readyToShip"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        session = yield* supervisor.get(session.id);
      }
      const staleWorkflowMutation = yield* supervisor.mutateWorkflow(
        { sessionId: session.id, runtimeId: beforeRestart.runtimeId },
        guardedWorkflowMutation(beforeRestart, { action: "intervene", feedback: "Old child must not mutate replacement workflow" }, "stale-guide-after-restart"),
      ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
      yield* supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId });
      return { session, staleWorkflowMutation };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(afterRestart.session.id, beforeRestart.id);
    assert.notEqual(afterRestart.session.runtimeId, beforeRestart.runtimeId);
    assert.equal(afterRestart.staleWorkflowMutation, "StaleRuntimeGenerationError");
    assert.deepEqual(afterRestart.session.workflow?.progress?.completedSliceIds, ["S-PRIOR"]);
    assert.equal(afterRestart.session.workflow?.operationReceipts?.find((receipt) => receipt.idempotencyKey === "scope-write-once")?.status, "completed");
    assert.equal(afterRestart.session.workflow?.guidance?.at(-1)?.status, "applied");
    assert.equal(afterRestart.session.workflow?.researchBrief?.findings[0]?.id, "F-LOCAL");
    assert.deepEqual(afterRestart.session.workflow?.appliedResearchFindingIds, ["F-LOCAL"]);
    assert.equal(afterRestart.session.workflow?.processedEventIds?.includes("scope-progress"), false);
    const commands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.ok(commands.filter((command) => command === "prompt").length >= 3);
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("continues an interrupted run after a control-plane restart and produces its final assistant response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-continue-run-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-continue-run.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-continue-run-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Interrupted run test",
      root: workspaceRoot,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: join(directory, "state"),
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const created = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = yield* supervisor.create({ workspaceId, name: "Continue interrupted work" });
      yield* supervisor.prompt({ sessionId: session.id, runtimeId: session.runtimeId }, "Hold long run open");
      let working = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 300 && (working.status !== "working" || !(JSON.stringify(working.events.at(-1)?.data) ?? "").includes("completed 799")); attempt += 1) {
        yield* Effect.sleep("10 millis");
        working = yield* supervisor.get(session.id);
      }
      assert.equal(working.status, "working");
      assert.equal(working.events.length, 750);
      assert.match(JSON.stringify(working.events.at(-1)?.data), /completed 799/);
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const shutdownState = JSON.parse(await readFile(join(config.stateDir, "owned-sessions.json"), "utf8")) as {
      sessions: Array<{ resumeAfterRestart?: boolean; resumeRunAfterRestart?: boolean }>;
    };
    assert.equal(shutdownState.sessions[0]?.resumeAfterRestart, true);
    assert.equal(shutdownState.sessions[0]?.resumeRunAfterRestart, true);

    const resumed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      let session = (yield* supervisor.list)[0]!;
      for (let attempt = 0; attempt < 200 && session.status !== "finished"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        session = yield* supervisor.get(session.id);
      }
      yield* supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId });
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(resumed.id, created.id);
    assert.notEqual(resumed.runtimeId, created.runtimeId);
    assert.equal(resumed.status, "finished");
    assert.ok(resumed.events.some((event) => event.type === "message_end" && JSON.stringify(event.data).includes("Recovered final response after restart")));
    const commands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.equal(commands.filter((command) => command === "prompt").length, 2);
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatically resumes an active runtime after supervisor restart without duplicating commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-resume-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-resume.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-resume-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Resume test",
      root: workspaceRoot,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: join(directory, "state"),
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const created = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = yield* supervisor.create({ workspaceId, name: "Survives restart" });
      yield* supervisor.prompt(
        { sessionId: session.id, runtimeId: session.runtimeId },
        "Accepted before the control plane disappeared",
        [],
        "lost-response-command",
      );
      let settled = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 100 && settled.status !== "finished"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        settled = yield* supervisor.get(session.id);
      }
      yield* supervisor.prompt(
        { sessionId: session.id, runtimeId: session.runtimeId },
        "Request interactive input",
        [],
        "pending-interactive-command",
      );
      let blocked = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 100 && blocked.status !== "blocked"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        blocked = yield* supervisor.get(session.id);
      }
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const shutdownState = JSON.parse(await readFile(join(config.stateDir, "owned-sessions.json"), "utf8")) as {
      sessions: Array<{ status: string; resumeAfterRestart?: boolean; interactiveRequests?: unknown[]; error?: string | null }>;
    };
    const stoppedForUpdate = shutdownState.sessions[0]!;

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const resumed = (yield* supervisor.list)[0]!;
      const stale = yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: created.runtimeId },
        "must not reach replacement runtime",
      ).pipe(Effect.as("unexpected"), Effect.catch((error) => Effect.succeed(error._tag)));
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "Accepted before the control plane disappeared",
        [],
        "lost-response-command",
      );
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "A new command",
        [],
        "deduplicated-command",
      );
      let settled = yield* supervisor.get(resumed.id);
      for (let attempt = 0; attempt < 100 && settled.status !== "finished"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        settled = yield* supervisor.get(resumed.id);
      }
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "A new command",
        [],
        "deduplicated-command",
      );
      const staleRename = yield* supervisor.rename(
        { sessionId: resumed.id, runtimeId: created.runtimeId },
        "Must not apply",
      ).pipe(Effect.as("unexpected"), Effect.catch((error) => Effect.succeed(error._tag)));
      const renamed = yield* supervisor.rename(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "Renamed across restart",
      );
      yield* supervisor.stop({ sessionId: renamed.id, runtimeId: renamed.runtimeId });
      return { resumed, renamed, stale, staleRename };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const stoppedAfterManualRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      return (yield* supervisor.list)[0]!;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));
    assert.equal(stoppedAfterManualRestart.status, "stopped");
    assert.equal(stoppedAfterManualRestart.runtimeId, result.resumed.runtimeId);
    assert.equal(stoppedAfterManualRestart.name, "Renamed across restart");

    const sessionPath = join(directory, "pi-resume.jsonl");
    const originalSessionPath = join(directory, "pi-resume-original.jsonl");
    const attemptResume = () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const persisted = (yield* supervisor.list)[0]!;
      return yield* supervisor.resume({ sessionId: persisted.id, runtimeId: persisted.runtimeId }).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));
    const originalWorkspaceRoot = join(directory, "workspace-original");
    await rename(workspaceRoot, originalWorkspaceRoot);
    await mkdir(workspaceRoot);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(workspaceRoot, { recursive: true });
    await rename(originalWorkspaceRoot, workspaceRoot);

    await rename(sessionPath, originalSessionPath);
    await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: workspaceRoot })}\n`);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(sessionPath);
    await symlink(originalSessionPath, sessionPath);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(sessionPath);
    assert.equal(await attemptResume(), "SessionResumeError");

    assert.equal(stoppedForUpdate.status, "stopped");
    assert.equal(stoppedForUpdate.resumeAfterRestart, true);
    assert.deepEqual(stoppedForUpdate.interactiveRequests, []);
    assert.match(stoppedForUpdate.error ?? "", /interactive request.*cancelled/i);
    assert.equal(result.resumed.id, created.id);
    assert.notEqual(result.resumed.runtimeId, created.runtimeId);
    assert.equal(result.resumed.piSessionId, created.piSessionId);
    assert.ok(result.resumed.events.some((event) => event.type === "message_end" && JSON.stringify(event.data).includes("Accepted before")));
    assert.equal(result.stale, "StaleRuntimeGenerationError");
    assert.equal(result.staleRename, "StaleRuntimeGenerationError");
    assert.equal(result.renamed.name, "Renamed across restart");
    const commands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.equal(commands.filter((command) => command === "prompt").length, 3);
    assert.equal(commands.filter((command) => command === "get_entries").length, 0, "durable timeline avoids transcript replay after restart");
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(argumentSets.at(-1)?.includes("--session"));
    assert.ok(argumentSets.at(-1)?.includes(join(directory, "pi-resume.jsonl")));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});
