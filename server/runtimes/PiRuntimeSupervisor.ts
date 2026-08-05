import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import {
  EngineeringWorkflowAuthorityDecision as EngineeringWorkflowAuthorityDecisionSchema,
  EngineeringWorkflowDossier as EngineeringWorkflowDossierSchema,
  EngineeringWorkflowOperationReceipt as EngineeringWorkflowOperationReceiptSchema,
  EngineeringWorkflowResearchBrief as EngineeringWorkflowResearchBriefSchema,
  EngineeringWorkflowResearchQuestion as EngineeringWorkflowResearchQuestionSchema,
  SessionArtifact as SessionArtifactSchema,
} from "../../shared/domain.ts";
import type {
  AvailableModel,
  CreateOwnedSessionInput,
  EngineeringWorkflow,
  EngineeringWorkflowCheckpoint,
  EngineeringWorkflowDossier,
  EngineeringWorkflowMutationInput,
  EngineeringWorkflowOperation,
  EngineeringWorkflowOperationReceipt,
  EngineeringWorkflowPhase,
  EngineeringWorkflowResearchBrief,
  EngineeringWorkflowResearchQuestion,
  EngineeringWorkflowSupervisorAdvice,
  ImportOwnedSessionInput,
  FileMention,
  ImageInput,
  InteractiveRequest,
  OwnedSession,
  OwnedSessionEvent,
  OwnedSessionStatus,
  OwnedSessionSummary,
  OwnedSessionTimelinePageResponse,
  PiSlashCommand,
  SessionArtifact,
  SessionUsage,
  ThinkingLevel,
  Workspace,
  WorkspaceId,
} from "../../shared/domain.ts";
import { canAcceptPrompt, canConfigureSession, transitionAttentionState } from "../../shared/sessionState.ts";
import {
  appendBoundedSupersededRevision,
  appendBoundedWorkflowGuidance,
  applyWorkflowCheckpoint,
  applyWorkflowProgress,
  cancelEngineeringWorkflowWithReceipt,
  canAutomaticallyAuthorize,
  expectedCheckpointStage,
  initialWorkflowProgress,
  isAutonomousWorkflowPhase,
  isTerminalWorkflowPhase,
  recordAuthorityDecision,
  recordWorkflowGuidanceDelivery,
  reconcileWorkflowApprovalGuidance,
  workflowCanRecordEvent,
  workflowCanRecordMutation,
  workflowEventMatchesCurrentRun,
  workflowFirstIncomplete,
  workflowGuidanceAppliesToCurrentPhase,
  workflowHasActiveCurrentPhaseRun,
  workflowOperationRequiresReceipt,
  workflowPlanRevision,
  workflowUnappliedGuidanceIdsForCurrentPhase,
  workflowRevision,
  workflowDossierValidationError,
  WORKFLOW_TRANSIENT_RETRY_LIMIT,
  type WorkflowGuidanceDeliveryEvent,
  type WorkflowProgressEvent,
} from "../../shared/engineeringWorkflow.ts";
import { AppConfig } from "../config.ts";
import { PushNotifications } from "../notifications/PushNotifications.ts";
import { FileMentionSearch, FileMentionSearchError } from "../files/FileMentionSearch.ts";
import {
  ActiveRuntimeLimitError,
  PiCommandError,
  PiSpawnError,
  SessionResumeError,
  SessionStorageError,
  SessionLimitError,
  SessionNotFoundError,
  StaleRuntimeGenerationError,
  WorkspaceNotFoundError,
} from "./errors.ts";
import { JsonlFramer } from "./JsonlFramer.ts";
import { WorkspaceDirectory } from "../workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepository } from "../workspaces/WorkspaceRepository.ts";
import { loadOwnedSessions, MAX_PROCESSED_WORKFLOW_START_MUTATION_IDS, persistOwnedSessions, type PersistedOwnedSession } from "./OwnedSessionStore.ts";
import {
  appendOwnedSessionTimelineEvent,
  loadOwnedSessionTimeline,
  loadOwnedSessionTimelinePage,
  loadOwnedSessionToolOutput,
  persistOwnedSessionTimeline,
  persistOwnedSessionToolOutput,
  removeOwnedSessionTimeline,
} from "./OwnedSessionTimelineStore.ts";
import { WorkspaceHasSessionsError, type WorkspaceManagedByConfigurationError, WorkspacePathError, type WorkspaceRecordNotFoundError, type WorkspaceStorageError } from "../workspaces/errors.ts";
import {
  adoptBrowserArtifact,
  discardRuntimeBrowserVideo,
  prepareRuntimeArtifactStaging,
  removeOwnedSessionArtifacts,
  removeRuntimeArtifactStaging,
  type BrowserArtifactCandidate,
} from "./OwnedSessionArtifactStore.ts";

const execFileAsync = promisify(execFile);

const MAX_EVENTS = 750;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_EVENT_BYTES = 256 * 1024;
const MAX_RETAINED_SESSIONS = 100;
const MAX_ACTIVE_RUNTIMES = 50;
const MAX_STDERR_BYTES = 32 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 5 * 60_000;
const SESSION_REPLAY_TIMEOUT_MS = 2 * 60_000;
const IMAGE_COMMAND_TIMEOUT_MS = 120_000;
const MAX_PENDING_COMMANDS = 16;
const MAX_ACTIVE_RUN_IMAGE_CHARACTERS = 40 * 1024 * 1024;
const MAX_SUPERVISOR_REPEATS_PER_BLOCKER = 2;
const TERMINATE_TIMEOUT_MS = 2_000;
const INTERRUPTED_RUN_CONTINUATION = "Continue the task that was interrupted by the PISS control-plane restart. Inspect the existing work and recent tool results first; do not repeat completed destructive or deployment steps unnecessarily. Finish the remaining verification and provide the final response.";
const MISSING_FINAL_RESPONSE_CONTINUATION = "The previous run ended after tool execution without a final response. Inspect the completed tool results, perform only checks that are still necessary, and provide the final response.";
const TERMINAL_STATUSES: ReadonlySet<OwnedSessionStatus> = new Set(["stopped", "crashed"]);
const MONOTONIC_STATUSES: ReadonlySet<OwnedSessionStatus> = new Set(["stopping", "stopped", "crashed"]);

type RpcMessage = Record<string, unknown> & { readonly type: string };
type CommandResume = (effect: Effect.Effect<RpcMessage, PiCommandError>) => void;

interface PendingCommand {
  readonly command: string;
  readonly resume: CommandResume;
  readonly timer: NodeJS.Timeout;
}

type WorkflowCancelIntent = {
  readonly key: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly phase: EngineeringWorkflowPhase;
  readonly phaseRunId?: string;
};

type PendingWorkflowAuthorityRequest = {
  readonly toolCallId: string;
  readonly expectedRequestTitle: string;
  readonly displayTitle: string;
  readonly workflowId: string;
  readonly phaseRunId: string;
  readonly planRevision: number;
  readonly runtimeId: string;
  readonly operationId: string;
  readonly kind: EngineeringWorkflowOperation["kind"];
  readonly target: string;
  readonly constraints: ReadonlyArray<string>;
  readonly idempotencyKey?: string;
};

type ResolvedWorkflowAuthorityRequest = {
  readonly expectedRequestTitle: string;
  readonly displayTitle: string;
  readonly confirmed: boolean;
  readonly durable: boolean;
  readonly waitingRequestIds: string[];
};

interface MutableOwnedSession {
  snapshot: OwnedSession;
  child: ChildProcessWithoutNullStreams | null;
  eventBytes: number;
  sequence: number;
  stderr: string;
  activeRunImageCharacters: number;
  resumeAfterRestart: boolean;
  resumeRunAfterRestart: boolean;
  finalResponseRecoveryAttempted: boolean;
  quarantined: boolean;
  workflowDispatchPending: boolean;
  workflowEventTail: Promise<void>;
  workflowCancelRequested: WorkflowCancelIntent | null;
  readonly pendingWorkflowAuthority: Map<string, PendingWorkflowAuthorityRequest>;
  readonly resolvedWorkflowAuthority: Map<string, ResolvedWorkflowAuthorityRequest>;
  termination?: Promise<void>;
  readonly pending: Map<string, PendingCommand>;
  readonly mutationLock: Semaphore.Semaphore;
  readonly workspaceIdentity: { readonly device: bigint; readonly inode: bigint };
  sessionFileIdentity: { readonly device: bigint; readonly inode: bigint } | null;
  readonly acceptedCommandIds: Set<string>;
  readonly processedWorkflowStartMutationIds: Set<string>;
  readonly interactiveTimers: Map<string, NodeJS.Timeout>;
}

function workflowCancelIntentKey(input: EngineeringWorkflowMutationInput): string {
  return input.mutationId;
}

function workflowCancelIntentMatches(session: MutableOwnedSession, workflow = session.snapshot.workflow): boolean {
  const intent = session.workflowCancelRequested;
  return Boolean(intent && workflow
    && intent.workflowId === workflow.id
    && intent.workflowRevision === workflowRevision(workflow)
    && intent.phase === workflow.phase
    && intent.phaseRunId === workflow.phaseRun?.id);
}

export interface RuntimeTarget {
  readonly sessionId: string;
  readonly runtimeId: string;
}

export type RuntimeCommandError = SessionNotFoundError | StaleRuntimeGenerationError | PiCommandError;

export interface PiRuntimeSupervisorShape {
  readonly create: (
    input: CreateOwnedSessionInput,
  ) => Effect.Effect<OwnedSession, WorkspaceNotFoundError | SessionLimitError | ActiveRuntimeLimitError | WorkspacePathError | PiSpawnError | PiCommandError | SessionResumeError | SessionStorageError>;
  readonly import: (
    input: ImportOwnedSessionInput,
  ) => Effect.Effect<OwnedSession, WorkspaceNotFoundError | SessionLimitError | WorkspacePathError | SessionResumeError | SessionStorageError>;
  readonly resume: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | WorkspaceNotFoundError | ActiveRuntimeLimitError | WorkspacePathError | PiSpawnError | SessionResumeError | SessionStorageError>;
  readonly list: Effect.Effect<ReadonlyArray<OwnedSession>>;
  readonly listSummaries: Effect.Effect<ReadonlyArray<OwnedSessionSummary>>;
  readonly awaitUpdateSafe: Effect.Effect<void>;
  readonly workspaceCounts: Effect.Effect<ReadonlyMap<string, { readonly sessions: number; readonly active: number }>>;
  readonly get: (id: string) => Effect.Effect<OwnedSession, SessionNotFoundError>;
  readonly timelinePage: (id: string, beforeSequence: number | undefined, limit: number) => Effect.Effect<OwnedSessionTimelinePageResponse, SessionNotFoundError | SessionStorageError>;
  readonly toolOutput: (id: string, ref: string) => Effect.Effect<{ readonly byteCount: number; readonly value: unknown }, SessionNotFoundError | SessionStorageError>;
  readonly subscribe: (id: string, listener: (session: OwnedSession) => void) => Effect.Effect<() => void, SessionNotFoundError>;
  readonly rename: (target: RuntimeTarget, name: string) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly acknowledge: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly respondInteractive: (target: RuntimeTarget, input: { readonly requestId: string; readonly cancelled?: boolean; readonly value?: string; readonly confirmed?: boolean }) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly reviewWorkspace: (target: RuntimeTarget) => Effect.Effect<{ readonly workspaceId: WorkspaceId; readonly device: bigint; readonly inode: bigint }, RuntimeCommandError>;
  readonly listModels: (target: RuntimeTarget) => Effect.Effect<ReadonlyArray<AvailableModel>, RuntimeCommandError>;
  readonly listCommands: (target: RuntimeTarget) => Effect.Effect<ReadonlyArray<PiSlashCommand>, RuntimeCommandError>;
  readonly searchMentions: (target: RuntimeTarget, query: string) => Effect.Effect<ReadonlyArray<FileMention>, RuntimeCommandError | WorkspaceNotFoundError | FileMentionSearchError>;
  readonly setModel: (target: RuntimeTarget, provider: string, modelId: string) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly setThinkingLevel: (target: RuntimeTarget, level: ThinkingLevel) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly refreshUsage: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly compact: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly setAutoCompaction: (target: RuntimeTarget, enabled: boolean) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly mutateWorkflow: (target: RuntimeTarget, input: EngineeringWorkflowMutationInput) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly prompt: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly steer: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly followUp: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly abort: (target: RuntimeTarget) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly stop: (target: RuntimeTarget) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly remove: (target: RuntimeTarget) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly removeWorkspace: (id: WorkspaceId) => Effect.Effect<void, WorkspaceHasSessionsError | WorkspaceRecordNotFoundError | WorkspaceManagedByConfigurationError | WorkspaceStorageError>;
}

export class PiRuntimeSupervisor extends Context.Service<PiRuntimeSupervisor, PiRuntimeSupervisorShape>()(
  "@piss/PiRuntimeSupervisor",
) {}

function now(): string {
  return new Date().toISOString();
}

function workflowBlockerFingerprint(checkpoint: EngineeringWorkflowCheckpoint): string {
  const normalized = `${checkpoint.stage}\n${checkpoint.summary.toLowerCase().replace(/\s+/gu, " ").trim()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function cloneSession(session: OwnedSession): OwnedSession {
  // Session state is updated immutably, including the retained event and
  // interactive-request arrays. Copy those collection boundaries without
  // serializing and deserializing up to eight MiB of immutable event payloads
  // for every RPC event and SSE publication.
  return {
    ...session,
    events: [...session.events],
    interactiveRequests: [...session.interactiveRequests],
  };
}

export function isSessionUpdateSafe(
  session: Pick<OwnedSession, "status" | "pendingMessageCount" | "compaction" | "interactiveRequests" | "workflow">,
  pendingCommandCount = 0,
): boolean {
  return (session.status === "idle" || session.status === "finished" || session.status === "stopped" || session.status === "crashed")
    && (!session.workflow || !isAutonomousWorkflowPhase(session.workflow.phase))
    && session.pendingMessageCount === 0
    && session.compaction.status !== "running"
    && session.interactiveRequests.length === 0
    && pendingCommandCount === 0;
}

function summarizeSession(session: OwnedSession): OwnedSessionSummary {
  return {
    id: session.id,
    runtimeId: session.runtimeId,
    workspaceId: session.workspaceId,
    name: session.name,
    branch: session.branch,
    status: session.status,
    pid: session.pid,
    piSessionId: session.piSessionId,
    sessionFile: session.sessionFile,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    workflow: session.workflow && {
      id: session.workflow.id,
      phase: session.workflow.phase,
      repairAttempts: session.workflow.repairAttempts,
      maxRepairAttempts: session.workflow.maxRepairAttempts,
      updatedAt: session.workflow.updatedAt,
    },
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    eventCount: session.events.length,
    error: session.error,
  };
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  const content = typeof value === "object" && value !== null ? (value as Record<string, unknown>).content : undefined;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const item = part as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function boundedText(value: unknown, maximumBytes = 128 * 1024): string {
  const text = textFromContent(value) || "[large event content omitted]";
  const bytes = Buffer.from(text);
  if (bytes.length <= maximumBytes) return text;
  return `${bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/, "")}\n[…truncated by PISS]`;
}

function redactImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImageData);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  if (source.type === "image") {
    return {
      type: "image",
      mimeType: typeof source.mimeType === "string" ? source.mimeType : "image",
    };
  }
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, redactImageData(item)]));
}

export function projectEventData(type: string, data: unknown): unknown {
  let projected = redactImageData(data);
  if (type === "message_update" && typeof projected === "object" && projected !== null) {
    const record = projected as Record<string, unknown>;
    const assistantEvent = record.assistantMessageEvent;
    if (typeof assistantEvent === "object" && assistantEvent !== null) {
      const { partial: _partial, ...delta } = assistantEvent as Record<string, unknown>;
      projected = { assistantMessageEvent: delta };
    }
  }
  const encoded = JSON.stringify(projected);
  if (Buffer.byteLength(encoded) <= MAX_SINGLE_EVENT_BYTES) return projected;
  const source = typeof projected === "object" && projected !== null
    ? projected as Record<string, unknown>
    : undefined;
  const base = {
    truncated: true,
    originalBytes: Buffer.byteLength(encoded),
    type,
    ...(typeof source?.toolCallId === "string" ? { toolCallId: source.toolCallId } : {}),
    ...(typeof source?.toolName === "string" ? { toolName: source.toolName } : {}),
  };
  if (type === "tool_execution_start") return { ...base, args: { content: [{ type: "text", text: boundedText(source?.args) }] } };
  if (type === "tool_execution_update") return { ...base, partialResult: { content: [{ type: "text", text: boundedText(source?.partialResult) }] } };
  if (type === "tool_execution_end") {
    return {
      ...base,
      result: { content: [{ type: "text", text: boundedText(source?.result) }] },
      isError: source?.isError === true,
    };
  }
  if ((type === "message_start" || type === "message_end") && typeof source?.message === "object" && source.message !== null) {
    const message = source.message as Record<string, unknown>;
    return {
      ...base,
      message: {
        role: message.role,
        stopReason: message.stopReason,
        errorMessage: typeof message.errorMessage === "string" ? boundedText(message.errorMessage, MAX_STDERR_BYTES) : undefined,
        content: [{ type: "text", text: boundedText(message) }],
      },
    };
  }
  return base;
}

interface DetachedToolOutput {
  readonly ref: string;
  readonly byteCount: number;
  readonly value: unknown;
}

function conciseOutputPreview(value: unknown): string {
  let text = textFromContent(value);
  if (!text) {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = "Tool output is available on demand"; }
  }
  if (text.length <= 600) return text;
  let preview = text.slice(0, 600);
  const final = preview.charCodeAt(preview.length - 1);
  if (final >= 0xD800 && final <= 0xDBFF) preview = preview.slice(0, -1);
  return `${preview}\n[…expand to load full output]`;
}

export function projectEventWithDetachedOutput(
  sessionId: string,
  sequence: number,
  type: string,
  data: unknown,
): { readonly data: unknown; readonly output?: DetachedToolOutput } {
  if ((type !== "tool_execution_update" && type !== "tool_execution_end") || typeof data !== "object" || data === null || Array.isArray(data)) {
    return { data: projectEventData(type, data) };
  }
  const source = data as Record<string, unknown>;
  const field = type === "tool_execution_end" ? "result" : "partialResult";
  if (!(field in source)) return { data: projectEventData(type, data) };
  const value = redactImageData(source[field]);
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { return { data: projectEventData(type, data) }; }
  const byteCount = Buffer.byteLength(encoded);
  if (byteCount <= 16 * 1024) return { data: projectEventData(type, data) };
  const ref = `${sessionId}:${sequence}:tool-output`;
  const preview = conciseOutputPreview(value);
  return {
    data: projectEventData(type, {
      ...source,
      [field]: { content: [{ type: "text", text: preview }] },
      outputRef: ref,
      outputBytes: byteCount,
      outputTruncated: true,
    }),
    output: { ref, byteCount, value },
  };
}

export function replayEventsFromTranscriptEntry(entry: unknown): ReadonlyArray<{ readonly type: string; readonly data: unknown }> {
  if (typeof entry !== "object" || entry === null || (entry as Record<string, unknown>).type !== "message") return [];
  const message = (entry as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
  const record = message as Record<string, unknown>;
  if (record.role === "toolResult" && typeof record.toolCallId === "string" && typeof record.toolName === "string") {
    return [{
      type: "tool_execution_end",
      data: {
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        result: { content: record.content },
        isError: record.isError === true,
      },
    }];
  }
  return [{ type: "message_end", data: { type: "message_end", message } }];
}

function eventBytes(event: OwnedSessionEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

function eventToolCallId(event: OwnedSessionEvent): string | undefined {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
  const toolCallId = (event.data as Record<string, unknown>).toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

export function appendBoundedEvent(
  current: ReadonlyArray<OwnedSessionEvent>,
  currentBytes: number,
  event: OwnedSessionEvent,
): { readonly events: Array<OwnedSessionEvent>; readonly bytes: number } {
  const events = [...current];
  let bytes = currentBytes;
  const removeAt = (index: number) => {
    const [removed] = events.splice(index, 1);
    if (removed) bytes -= eventBytes(removed);
  };

  const toolCallId = eventToolCallId(event);
  if (toolCallId && (event.type === "tool_execution_update" || event.type === "tool_execution_end")) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]!;
      if (eventToolCallId(candidate) !== toolCallId) continue;
      if (candidate.type === "tool_execution_update" || event.type === "tool_execution_end" && candidate.type === "tool_execution_start") {
        removeAt(index);
      }
    }
  }

  if (event.type === "message_end") {
    const previousMessage = events.findLastIndex((candidate) => candidate.type === "message_end");
    for (let index = events.length - 1; index > previousMessage; index -= 1) {
      if (events[index]?.type === "message_start" || events[index]?.type === "message_update") removeAt(index);
    }
  }

  events.push(event);
  bytes += eventBytes(event);
  while (events.length > MAX_EVENTS || bytes > MAX_EVENT_BYTES) {
    // Drop superseded streaming activity first, but never sacrifice every tool
    // result just because completed messages are present. Protect the newest
    // event so an active call remains visible when the history is already full.
    const disposable = events.findIndex((candidate, index) =>
      index < events.length - 1 && candidate.type !== "message_end" && candidate.type !== "tool_execution_end"
    );
    removeAt(disposable >= 0 ? disposable : 0);
  }
  return { events, bytes };
}

function runEndedAfterToolsWithoutFinalResponse(events: ReadonlyArray<OwnedSessionEvent>): boolean {
  const runBoundary = Math.max(
    events.findLast((event) => event.type === "agent_start")?.sequence ?? 0,
    events.findLast((event) => {
      if (event.type !== "message_end" || typeof event.data !== "object" || event.data === null) return false;
      const message = (event.data as Record<string, unknown>).message;
      return typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "user";
    })?.sequence ?? 0,
  );
  const latestTool = events.findLast((event) => event.sequence > runBoundary && event.type === "tool_execution_end");
  if (!latestTool) return false;
  return !events.some((event) => {
    if (event.sequence <= latestTool.sequence || event.type !== "message_end" || typeof event.data !== "object" || event.data === null) return false;
    const message = (event.data as Record<string, unknown>).message;
    return typeof message === "object" && message !== null
      && (message as Record<string, unknown>).role === "assistant"
      && textFromContent(message).trim().length > 0;
  });
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string";
}

function interactiveRequest(message: RpcMessage): InteractiveRequest | undefined {
  if (message.type !== "extension_ui_request" || typeof message.id !== "string" || message.id.length < 1 || message.id.length > 128) return;
  if (message.method !== "select" && message.method !== "confirm" && message.method !== "input" && message.method !== "editor") return;
  if (typeof message.title !== "string" || message.title.length > 16 * 1024) return;
  if (message.timeout !== undefined && (!Number.isInteger(message.timeout) || Number(message.timeout) <= 0 || Number(message.timeout) > 60 * 60 * 1000)) return;
  if (message.message !== undefined && (typeof message.message !== "string" || message.message.length > 64 * 1024)) return;
  if (message.placeholder !== undefined && (typeof message.placeholder !== "string" || message.placeholder.length > 4 * 1024)) return;
  if (message.prefill !== undefined && (typeof message.prefill !== "string" || message.prefill.length > 256 * 1024)) return;
  if (message.method === "select" && (!Array.isArray(message.options) || message.options.length < 1 || message.options.length > 100 || message.options.some((option) => typeof option !== "string" || !option || option.length > 4 * 1024))) return;
  return {
    id: message.id,
    method: message.method,
    title: message.title,
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(Array.isArray(message.options) ? { options: message.options as string[] } : {}),
    ...(typeof message.placeholder === "string" ? { placeholder: message.placeholder } : {}),
    ...(typeof message.prefill === "string" ? { prefill: message.prefill } : {}),
    ...(typeof message.timeout === "number" ? { timeout: message.timeout } : {}),
    receivedAt: now(),
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function sessionUsage(value: unknown): SessionUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const tokens = typeof data.tokens === "object" && data.tokens !== null && !Array.isArray(data.tokens) ? data.tokens as Record<string, unknown> : undefined;
  if (!tokens) return;
  const userMessages = nonNegativeInteger(data.userMessages);
  const assistantMessages = nonNegativeInteger(data.assistantMessages);
  const toolCalls = nonNegativeInteger(data.toolCalls);
  const toolResults = nonNegativeInteger(data.toolResults);
  const totalMessages = nonNegativeInteger(data.totalMessages);
  const input = nonNegativeInteger(tokens.input);
  const output = nonNegativeInteger(tokens.output);
  const cacheRead = nonNegativeInteger(tokens.cacheRead);
  const cacheWrite = nonNegativeInteger(tokens.cacheWrite);
  const total = nonNegativeInteger(tokens.total);
  if ([userMessages, assistantMessages, toolCalls, toolResults, totalMessages, input, output, cacheRead, cacheWrite, total].some((item) => item === undefined)) return;
  const context = typeof data.contextUsage === "object" && data.contextUsage !== null && !Array.isArray(data.contextUsage) ? data.contextUsage as Record<string, unknown> : undefined;
  const contextWindow = context ? nonNegativeInteger(context.contextWindow) : undefined;
  const contextUsage = context && contextWindow && contextWindow > 0 && (context.tokens === null || nonNegativeInteger(context.tokens) !== undefined) && (context.percent === null || typeof context.percent === "number" && Number.isFinite(context.percent) && context.percent >= 0)
    ? { tokens: context.tokens === null ? null : nonNegativeInteger(context.tokens)!, contextWindow, percent: context.percent === null ? null : Number(context.percent) }
    : null;
  return {
    userMessages: userMessages!, assistantMessages: assistantMessages!, toolCalls: toolCalls!, toolResults: toolResults!, totalMessages: totalMessages!,
    tokens: { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, total: total! },
    cost: typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 ? data.cost : null,
    contextUsage,
    updatedAt: now(),
  };
}

function idleCompaction() {
  return { status: "idle" as const, reason: null, tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: null };
}

function stateData(message: RpcMessage): Record<string, unknown> | undefined {
  const data = message.data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value) ? value as ThinkingLevel : null;
}

function availableModel(value: unknown): AvailableModel | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || !model.provider || model.provider.length > 256 ||
      typeof model.id !== "string" || !model.id || model.id.length > 1_024) return;
  const reasoning = model.reasoning === true;
  const map = typeof model.thinkingLevelMap === "object" && model.thinkingLevelMap !== null && !Array.isArray(model.thinkingLevelMap)
    ? model.thinkingLevelMap as Record<string, unknown>
    : undefined;
  const thinkingLevels: ThinkingLevel[] = reasoning
    ? THINKING_LEVELS.filter((level) => map?.[level] !== null && (level !== "xhigh" && level !== "max" || typeof map?.[level] === "string"))
    : ["off"];
  return {
    provider: model.provider,
    id: model.id,
    name: typeof model.name === "string" && model.name && model.name.length <= 1_024 ? model.name : model.id,
    reasoning,
    thinkingLevels,
  };
}

function slashCommand(value: unknown): PiSlashCommand | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const command = value as Record<string, unknown>;
  if (typeof command.name !== "string" || !command.name || command.name.length > 1_024 || /[\s/]/u.test(command.name)) return;
  if (command.source !== "extension" && command.source !== "prompt" && command.source !== "skill") return;
  const sourceInfo = typeof command.sourceInfo === "object" && command.sourceInfo !== null && !Array.isArray(command.sourceInfo)
    ? command.sourceInfo as Record<string, unknown>
    : undefined;
  const scope = sourceInfo?.scope === "user" || sourceInfo?.scope === "project" || sourceInfo?.scope === "temporary"
    ? sourceInfo.scope
    : null;
  return {
    name: command.name,
    ...(typeof command.description === "string" && command.description.length <= 16 * 1_024 ? { description: command.description } : {}),
    source: command.source,
    scope,
  };
}

const decodeSessionArtifact = Schema.decodeUnknownSync(SessionArtifactSchema);

type BrowserArtifactHandoff =
  | { readonly _tag: "none" }
  | { readonly _tag: "invalid"; readonly media: "screenshot" | "video"; readonly recordingId?: string }
  | { readonly _tag: "candidate"; readonly candidate: BrowserArtifactCandidate };

type BrowserRecordingLifecycle =
  | { readonly state: "started" | "finalized" | "interrupted"; readonly recordingId: string; readonly message?: string }
  | undefined;

function rpcResultDetails(message: RpcMessage): Record<string, unknown> | undefined {
  const result = typeof message.result === "object" && message.result !== null && !Array.isArray(message.result)
    ? message.result as Record<string, unknown>
    : undefined;
  return typeof result?.details === "object" && result.details !== null && !Array.isArray(result.details)
    ? result.details as Record<string, unknown>
    : undefined;
}

function browserArtifactHandoffFromRpc(message: RpcMessage): BrowserArtifactHandoff {
  const media = message.toolName === "piss_browser_screenshot" ? "screenshot" : message.toolName === "piss_browser_video_stop" ? "video" : undefined;
  if (message.type !== "tool_execution_end" || !media || message.isError === true) return { _tag: "none" };
  const details = rpcResultDetails(message);
  const rawValue = details?.pissBrowserArtifact;
  const raw = typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue) ? rawValue as Record<string, unknown> : undefined;
  const lifecycleValue = details?.pissBrowserRecording;
  const lifecycle = typeof lifecycleValue === "object" && lifecycleValue !== null && !Array.isArray(lifecycleValue) ? lifecycleValue as Record<string, unknown> : undefined;
  const recordingId = media === "video" && typeof lifecycle?.recordingId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(lifecycle.recordingId) ? lifecycle.recordingId : undefined;
  if (raw?.version !== 1 || typeof raw.stagingName !== "string") return { _tag: "invalid", media, ...(recordingId ? { recordingId } : {}) };
  try {
    const artifact = decodeSessionArtifact(raw.artifact);
    if (media === "screenshot" && artifact.kind !== "browser-screenshot" || media === "video" && artifact.kind !== "browser-video") return { _tag: "invalid", media, ...(recordingId ? { recordingId } : {}) };
    return { _tag: "candidate", candidate: { version: 1, stagingName: raw.stagingName, artifact } };
  } catch { return { _tag: "invalid", media, ...(recordingId ? { recordingId } : {}) }; }
}

function browserRecordingLifecycleFromRpc(message: RpcMessage): BrowserRecordingLifecycle {
  if (message.type !== "tool_execution_end" || message.isError === true) return;
  const expectedState = message.toolName === "piss_browser_video_start" ? "started"
    : message.toolName === "piss_browser_video_stop" ? "finalized"
      : message.toolName === "piss_browser_close" ? "interrupted"
        : undefined;
  if (!expectedState) return;
  const rawValue = rpcResultDetails(message)?.pissBrowserRecording;
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) return;
  const raw = rawValue as Record<string, unknown>;
  if (raw.version !== 1 || raw.state !== expectedState
    || typeof raw.recordingId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.recordingId)) return;
  return { state: expectedState, recordingId: raw.recordingId, ...(typeof raw.message === "string" ? { message: raw.message.slice(0, 4 * 1024) } : {}) };
}

function hasTerminalBrowserRecordingEvent(session: MutableOwnedSession, recordingId: string): boolean {
  return session.snapshot.events.some((event) => {
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return false;
    const data = event.data as Record<string, unknown>;
    if (event.type === "browser_artifact_failed") return data.recordingId === recordingId;
    if (event.type !== "browser_artifact_created" || typeof data.artifact !== "object" || data.artifact === null || Array.isArray(data.artifact)) return false;
    return (data.artifact as Record<string, unknown>).id === recordingId;
  });
}

type ReportedSupervisorAdvice = {
  readonly workflowId: string;
  readonly advice: EngineeringWorkflowSupervisorAdvice;
};

function supervisorAdviceAlreadyApplied(workflow: EngineeringWorkflow, eventId: string): boolean {
  return workflow.processedEventIds?.includes(eventId) === true
    || workflow.supervisor?.lastAdvice?.eventId === eventId;
}

function rememberSupervisorAdviceEvent(workflow: EngineeringWorkflow, eventId: string): ReadonlyArray<string> | undefined {
  if (workflow.processedEventIds?.includes(eventId) || !workflowCanRecordEvent(workflow, eventId, 0)) return workflow.processedEventIds;
  return [...(workflow.processedEventIds ?? []), eventId];
}

function workflowSupervisorAdviceFromRpc(message: RpcMessage, receivedAt = now()): ReportedSupervisorAdvice | undefined {
  if (message.type !== "tool_execution_end" || message.toolName !== "piss_workflow_supervisor_advice" || message.isError === true) return;
  const result = typeof message.result === "object" && message.result !== null && !Array.isArray(message.result)
    ? message.result as Record<string, unknown>
    : undefined;
  const argsValue = typeof message.args === "object" && message.args !== null && !Array.isArray(message.args)
    ? message.args
    : result?.details;
  if (typeof argsValue !== "object" || argsValue === null || Array.isArray(argsValue)) return;
  const args = argsValue as Record<string, unknown>;
  const actions = new Set(["resume_with_guidance", "retry_transient", "enter_repair", "human_authority_required", "unsafe_stop"]);
  if (typeof args.workflowId !== "string" || !args.workflowId || args.workflowId.length > 128) return;
  if (typeof args.eventId !== "string" || !args.eventId || args.eventId.length > 128) return;
  if (typeof args.consultationId !== "string" || !args.consultationId || args.consultationId.length > 128) return;
  if (typeof args.phaseRunId !== "string" || !args.phaseRunId || args.phaseRunId.length > 128) return;
  if (!Number.isSafeInteger(args.planRevision) || Number(args.planRevision) < 0) return;
  if (!Number.isSafeInteger(args.workflowRevision) || Number(args.workflowRevision) < 0) return;
  if (typeof args.runtimeId !== "string" || !args.runtimeId || args.runtimeId.length > 128) return;
  if (typeof args.action !== "string" || !actions.has(args.action)) return;
  if (args.problem !== undefined && (typeof args.problem !== "string" || !args.problem || args.problem.length > 512)) return;
  if (typeof args.summary !== "string" || !args.summary || args.summary.length > 16 * 1024) return;
  if (args.guidance !== undefined && (typeof args.guidance !== "string" || args.guidance.length > 64 * 1024)) return;
  if (typeof args.basis !== "string" || !args.basis || args.basis.length > 16 * 1024) return;
  return {
    workflowId: args.workflowId,
    advice: {
      eventId: args.eventId,
      consultationId: args.consultationId,
      phaseRunId: args.phaseRunId,
      planRevision: Number(args.planRevision),
      workflowRevision: Number(args.workflowRevision),
      runtimeId: args.runtimeId,
      action: args.action as EngineeringWorkflowSupervisorAdvice["action"],
      ...(typeof args.problem === "string" ? { problem: args.problem } : {}),
      summary: args.summary,
      guidance: typeof args.guidance === "string" ? args.guidance : null,
      basis: args.basis,
      receivedAt,
    },
  };
}

function workflowCheckpointFromRpc(
  message: RpcMessage,
  sequence: number,
  receivedAt = now(),
): { readonly workflowId: string; readonly checkpoint: EngineeringWorkflowCheckpoint } | undefined {
  if (message.type !== "tool_execution_end" || message.toolName !== "piss_workflow_checkpoint" || message.isError === true) return;
  if (typeof message.toolCallId !== "string" || !message.toolCallId || message.toolCallId.length > 256) return;
  const result = typeof message.result === "object" && message.result !== null && !Array.isArray(message.result)
    ? message.result as Record<string, unknown>
    : undefined;
  const argsValue = typeof message.args === "object" && message.args !== null && !Array.isArray(message.args)
    ? message.args
    : result?.details;
  if (typeof argsValue !== "object" || argsValue === null || Array.isArray(argsValue)) return;
  const args = argsValue as Record<string, unknown>;
  const stages = new Set(["define", "research", "plan", "build", "verify", "review"]);
  const outcomes = new Set(["ready", "passed", "failed", "blocked"]);
  if (typeof args.workflowId !== "string" || !args.workflowId || args.workflowId.length > 128) return;
  if (typeof args.stage !== "string" || !stages.has(args.stage)) return;
  if (typeof args.outcome !== "string" || !outcomes.has(args.outcome)) return;
  if (typeof args.summary !== "string" || !args.summary || args.summary.length > 16 * 1024) return;
  if (args.artifact !== undefined && (typeof args.artifact !== "string" || args.artifact.length > 64 * 1024)) return;
  if (args.eventId !== undefined && (typeof args.eventId !== "string" || !args.eventId || args.eventId.length > 128)) return;
  if (args.phaseRunId !== undefined && (typeof args.phaseRunId !== "string" || !args.phaseRunId || args.phaseRunId.length > 128)) return;
  if (args.planRevision !== undefined && (!Number.isSafeInteger(args.planRevision) || Number(args.planRevision) < 0)) return;
  if (args.runtimeId !== undefined && (typeof args.runtimeId !== "string" || !args.runtimeId || args.runtimeId.length > 128)) return;
  if (args.appliedGuidanceIds !== undefined && (!Array.isArray(args.appliedGuidanceIds) || args.appliedGuidanceIds.length > 64 || args.appliedGuidanceIds.some((id) => typeof id !== "string" || !id || id.length > 128))) return;
  if (args.appliedResearchFindingIds !== undefined && (!Array.isArray(args.appliedResearchFindingIds) || args.appliedResearchFindingIds.length > 50 || args.appliedResearchFindingIds.some((id) => typeof id !== "string" || !id || id.length > 128))) return;
  let researchQuestions: ReadonlyArray<EngineeringWorkflowResearchQuestion> | undefined;
  if (args.researchQuestions !== undefined) {
    if (!Array.isArray(args.researchQuestions) || args.researchQuestions.length > 20) return;
    try { researchQuestions = args.researchQuestions.map((question) => Schema.decodeUnknownSync(EngineeringWorkflowResearchQuestionSchema)(question)); }
    catch { return; }
  }
  let researchBrief: EngineeringWorkflowResearchBrief | undefined;
  if (args.researchBrief !== undefined) {
    try { researchBrief = Schema.decodeUnknownSync(EngineeringWorkflowResearchBriefSchema)(args.researchBrief); }
    catch { return; }
  }
  let dossier: EngineeringWorkflowDossier | undefined;
  if (args.dossier !== undefined) {
    try { dossier = Schema.decodeUnknownSync(EngineeringWorkflowDossierSchema)(args.dossier); }
    catch { return; }
  }
  return {
    workflowId: args.workflowId,
    checkpoint: {
      stage: args.stage as EngineeringWorkflowCheckpoint["stage"],
      outcome: args.outcome as EngineeringWorkflowCheckpoint["outcome"],
      summary: args.summary,
      artifact: typeof args.artifact === "string" ? args.artifact : null,
      toolCallId: message.toolCallId,
      sequence,
      receivedAt,
      eventId: typeof args.eventId === "string" ? args.eventId : `checkpoint:${message.toolCallId}`,
      ...(typeof args.phaseRunId === "string" ? { phaseRunId: args.phaseRunId } : {}),
      ...(typeof args.planRevision === "number" ? { planRevision: args.planRevision } : {}),
      ...(typeof args.runtimeId === "string" ? { runtimeId: args.runtimeId } : {}),
      ...(dossier ? { dossier } : {}),
      ...(researchQuestions ? { researchQuestions } : {}),
      ...(researchBrief ? { researchBrief: { ...researchBrief, completedAt: receivedAt, sources: researchBrief.sources.map((source) => ({ ...source, accessedAt: receivedAt })) } } : {}),
      ...(Array.isArray(args.appliedResearchFindingIds) ? { appliedResearchFindingIds: args.appliedResearchFindingIds as string[] } : {}),
      ...(Array.isArray(args.appliedGuidanceIds) ? { appliedGuidanceIds: args.appliedGuidanceIds as string[] } : {}),
    },
  };
}

function workflowProgressFromRpc(
  message: RpcMessage,
  sequence: number,
  _runtimeId: string,
  receivedAt = now(),
): { readonly workflowId: string; readonly event: WorkflowProgressEvent } | undefined {
  if (message.type !== "tool_execution_end" || message.toolName !== "piss_workflow_progress" || message.isError === true) return;
  const details = rpcResultDetails(message);
  if (!details || typeof details.workflowId !== "string" || !details.workflowId || details.workflowId.length > 128) return;
  if (typeof details.activity !== "string" || !details.activity || details.activity.length > 8 * 1024) return;
  const eventId = typeof details.eventId === "string" && details.eventId.length <= 128
    ? details.eventId
    : typeof message.toolCallId === "string" ? `progress:${message.toolCallId}` : undefined;
  if (!eventId) return;
  const stringIds = (value: unknown, maximum: number): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item || item.length > 128)) return;
    return value as string[];
  };
  const completedSliceIds = stringIds(details.completedSliceIds, 100);
  const passedCriterionIds = stringIds(details.passedCriterionIds, 200);
  const appliedGuidanceIds = stringIds(details.appliedGuidanceIds, 64);
  if (details.completedSliceIds !== undefined && !completedSliceIds || details.passedCriterionIds !== undefined && !passedCriterionIds || details.appliedGuidanceIds !== undefined && !appliedGuidanceIds) return;
  if (details.runtimeId !== undefined && (typeof details.runtimeId !== "string" || !details.runtimeId || details.runtimeId.length > 128)) return;
  let receipt: EngineeringWorkflowOperationReceipt | undefined;
  if (details.receipt !== undefined) {
    const raw = typeof details.receipt === "object" && details.receipt !== null && !Array.isArray(details.receipt)
      ? details.receipt as Record<string, unknown>
      : undefined;
    if (!raw) return;
    try { receipt = Schema.decodeUnknownSync(EngineeringWorkflowOperationReceiptSchema)({ ...raw, evidence: typeof raw.evidence === "string" ? raw.evidence : null, updatedAt: receivedAt }); }
    catch { return; }
  }
  const evidence = Array.isArray(details.evidence)
    ? details.evidence.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      return typeof item.criterionId === "string" && item.criterionId && item.criterionId.length <= 128
        && typeof item.summary === "string" && item.summary && item.summary.length <= 4 * 1024
        ? [{ criterionId: item.criterionId, summary: item.summary, eventSequence: sequence }]
        : [];
    })
    : undefined;
  if (Array.isArray(details.evidence) && evidence?.length !== details.evidence.length) return;
  const conditions = new Set(["working", "waiting_internal", "waiting_user", "retrying", "supervising", "blocked", "complete"]);
  return {
    workflowId: details.workflowId,
    event: {
      eventId,
      ...(typeof details.phaseRunId === "string" ? { phaseRunId: details.phaseRunId } : {}),
      ...(typeof details.planRevision === "number" && Number.isSafeInteger(details.planRevision) && details.planRevision >= 0 ? { planRevision: details.planRevision } : {}),
      ...(typeof details.runtimeId === "string" ? { runtimeId: details.runtimeId } : {}),
      activity: details.activity,
      ...(details.currentSliceId === null || typeof details.currentSliceId === "string" ? { currentSliceId: details.currentSliceId } : {}),
      ...(completedSliceIds ? { completedSliceIds } : {}),
      ...(passedCriterionIds ? { passedCriterionIds } : {}),
      ...(evidence ? { evidence } : {}),
      ...(details.verificationStep === null || typeof details.verificationStep === "string" ? { verificationStep: details.verificationStep } : {}),
      ...(details.reviewStep === null || typeof details.reviewStep === "string" ? { reviewStep: details.reviewStep } : {}),
      ...(typeof details.condition === "string" && conditions.has(details.condition) ? { condition: details.condition as WorkflowProgressEvent["condition"] } : {}),
      ...(typeof details.nextAction === "string" ? { nextAction: details.nextAction } : {}),
      ...(typeof details.retryAttempt === "number" && Number.isSafeInteger(details.retryAttempt) && details.retryAttempt >= 0 ? { retryAttempt: details.retryAttempt } : {}),
      ...(typeof details.maxTransientRetries === "number" && Number.isSafeInteger(details.maxTransientRetries) && details.maxTransientRetries >= 0 ? { maxTransientRetries: details.maxTransientRetries } : {}),
      ...(appliedGuidanceIds ? { appliedGuidanceIds } : {}),
      ...(receipt ? { receipt } : {}),
      receivedAt,
    },
  };
}

function workflowDraftFromRpc(message: RpcMessage, receivedAt = now()): {
  readonly workflowId: string;
  readonly eventId: string;
  readonly phaseRunId?: string;
  readonly planRevision?: number;
  readonly runtimeId?: string;
  readonly stage: "define" | "plan";
  readonly summary: string;
  readonly specification?: string;
  readonly plan?: string;
  readonly questions: ReadonlyArray<string>;
  readonly dossier?: EngineeringWorkflowDossier;
  readonly receivedAt: string;
} | undefined {
  if (message.type !== "tool_execution_end" || message.toolName !== "piss_workflow_draft" || message.isError === true) return;
  const details = rpcResultDetails(message);
  if (!details || typeof details.workflowId !== "string" || !details.workflowId || details.workflowId.length > 128) return;
  if (details.stage !== "define" && details.stage !== "plan") return;
  if (typeof details.summary !== "string" || !details.summary || details.summary.length > 16 * 1024) return;
  if (details.specification !== undefined && (typeof details.specification !== "string" || details.specification.length > 64 * 1024)) return;
  if (details.plan !== undefined && (typeof details.plan !== "string" || details.plan.length > 64 * 1024)) return;
  if (details.questions !== undefined && (!Array.isArray(details.questions) || details.questions.length > 20 || details.questions.some((item) => typeof item !== "string" || !item || item.length > 4 * 1024))) return;
  let dossier: EngineeringWorkflowDossier | undefined;
  if (details.dossier !== undefined) {
    try { dossier = Schema.decodeUnknownSync(EngineeringWorkflowDossierSchema)(details.dossier); }
    catch { return; }
  }
  return {
    workflowId: details.workflowId,
    eventId: typeof details.eventId === "string" && details.eventId.length <= 128 ? details.eventId : `draft:${String(message.toolCallId ?? "unknown")}`,
    ...(typeof details.phaseRunId === "string" ? { phaseRunId: details.phaseRunId } : {}),
    ...(typeof details.planRevision === "number" && Number.isSafeInteger(details.planRevision) && details.planRevision >= 0 ? { planRevision: details.planRevision } : {}),
    ...(typeof details.runtimeId === "string" ? { runtimeId: details.runtimeId } : {}),
    stage: details.stage,
    summary: details.summary,
    ...(typeof details.specification === "string" ? { specification: details.specification } : {}),
    ...(typeof details.plan === "string" ? { plan: details.plan } : {}),
    questions: Array.isArray(details.questions) ? details.questions as string[] : [],
    ...(dossier ? { dossier } : {}),
    receivedAt,
  };
}

type ReportedWorkflowDraft = NonNullable<ReturnType<typeof workflowDraftFromRpc>>;

function applyWorkflowDraftReport(workflow: EngineeringWorkflow, reportedDraft: ReportedWorkflowDraft): EngineeringWorkflow {
  if (workflow.id !== reportedDraft.workflowId || workflow.processedEventIds?.includes(reportedDraft.eventId)) return workflow;
  if (!workflowCanRecordEvent(workflow, reportedDraft.eventId)) return workflow;
  if (!workflowEventMatchesCurrentRun(workflow, reportedDraft)) return workflow;
  if (workflow.phase !== "defining" && workflow.phase !== "planning") return workflow;
  const expectedStage = workflow.phase === "defining" ? "define" : "plan";
  if (reportedDraft.stage !== expectedStage) return workflow;
  const allocatedRevision = workflow.phase === "planning"
    ? Math.max(1, workflow.phaseRun?.planRevision ?? workflowPlanRevision(workflow))
    : workflow.phaseRun?.planRevision ?? workflowPlanRevision(workflow);
  const reportedDossier = reportedDraft.dossier ?? workflow.dossier;
  const dossier = workflow.phase === "planning" && reportedDossier
    ? { ...reportedDossier, revision: allocatedRevision }
    : reportedDossier;
  const condition = reportedDraft.questions.length > 0 ? "waiting_user" as const : "working" as const;
  const progress = workflow.progress ?? initialWorkflowProgress(reportedDraft.receivedAt, condition, dossier);
  return {
    ...workflow,
    specification: reportedDraft.specification ?? workflow.specification,
    plan: reportedDraft.plan ?? workflow.plan,
    dossier,
    artifactRevision: workflow.phase === "planning" ? allocatedRevision : workflow.artifactRevision,
    revision: workflowRevision(workflow) + 1,
    processedEventIds: [...(workflow.processedEventIds ?? []), reportedDraft.eventId],
    openQuestions: [...reportedDraft.questions],
    progress: {
      ...progress,
      activity: reportedDraft.summary,
      condition,
      nextAction: reportedDraft.questions.length > 0 ? "Answer the focused planning question" : "Continue refining the workflow artifacts",
      lastActivityAt: reportedDraft.receivedAt,
    },
    updatedAt: reportedDraft.receivedAt,
  };
}

function workflowAuthorityRequestTitle(toolCallId: string, title: string): string {
  return `[PISS authority:${toolCallId}] ${title}`;
}

function workflowAuthorityCorrelationId(title: string): string | undefined {
  const match = /^\[PISS authority:([^\]]+)\] /u.exec(title);
  const correlationId = match?.[1];
  return correlationId && correlationId.length <= 128 ? correlationId : undefined;
}

function workflowAuthorityRequestFromRpc(message: RpcMessage): PendingWorkflowAuthorityRequest | undefined {
  if (message.type !== "tool_execution_start" || message.toolName !== "piss_workflow_authority_request" || typeof message.toolCallId !== "string") return;
  if (typeof message.args !== "object" || message.args === null || Array.isArray(message.args)) return;
  const args = message.args as Record<string, unknown>;
  if (typeof args.workflowId !== "string" || !args.workflowId || args.workflowId.length > 128) return;
  if (typeof args.phaseRunId !== "string" || !args.phaseRunId || args.phaseRunId.length > 128) return;
  if (!Number.isSafeInteger(args.planRevision) || Number(args.planRevision) < 0) return;
  if (typeof args.runtimeId !== "string" || !args.runtimeId || args.runtimeId.length > 128) return;
  if (typeof args.operationId !== "string" || !args.operationId || args.operationId.length > 128) return;
  const kinds = new Set(["workspace_read", "workspace_write", "command", "browser_verify", "git_commit", "git_push", "migration", "deployment", "production_read", "production_write"]);
  if (typeof args.kind !== "string" || !kinds.has(args.kind)) return;
  if (typeof args.target !== "string" || !args.target || args.target.length > 16 * 1024) return;
  if (!Array.isArray(args.constraints) || args.constraints.length > 100 || args.constraints.some((item) => typeof item !== "string" || !item || item.length > 4 * 1024)) return;
  if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== "string" || !args.idempotencyKey || args.idempotencyKey.length > 256)) return;
  if (typeof args.title !== "string" || !args.title || args.title.length > 4 * 1024) return;
  return { toolCallId: message.toolCallId, expectedRequestTitle: workflowAuthorityRequestTitle(message.toolCallId, args.title), displayTitle: args.title, workflowId: args.workflowId, phaseRunId: args.phaseRunId, planRevision: Number(args.planRevision), runtimeId: args.runtimeId, operationId: args.operationId, kind: args.kind as EngineeringWorkflowOperation["kind"], target: args.target, constraints: args.constraints as string[], ...(typeof args.idempotencyKey === "string" ? { idempotencyKey: args.idempotencyKey } : {}) };
}

export function reconcileWorkflowAfterRestart(workflow: EngineeringWorkflow, updatedAt = now()): EngineeringWorkflow {
  if (!isAutonomousWorkflowPhase(workflow.phase)) return workflow;
  const ambiguousReceipt = workflow.operationReceipts?.find((receipt) => receipt.status === "started"
    && workflowOperationRequiresReceipt(workflow.dossier?.operations.find((operation) => operation.id === receipt.operationId)));
  if (!ambiguousReceipt) {
    const boundary = workflowFirstIncomplete(workflow);
    const boundaryLabel = boundary
      ? [boundary.sliceId ? `slice ${boundary.sliceId}` : null, boundary.criterionId ? `criterion ${boundary.criterionId}` : null].filter(Boolean).join(", ")
      : "the current phase checkpoint";
    return {
      ...workflow,
      revision: workflowRevision(workflow) + 1,
      progress: workflow.progress ? {
        ...workflow.progress,
        currentSliceId: boundary?.sliceId ?? workflow.progress.currentSliceId,
        condition: "waiting_internal",
        activity: `Reconciled durable workflow state after restart; next safe boundary is ${boundaryLabel}`,
        nextAction: `Resume ${boundaryLabel} without repeating completed operation receipts`,
        lastActivityAt: updatedAt,
      } : workflow.progress,
      updatedAt,
    };
  }
  return {
    ...workflow,
    phase: "blocked",
    blockedFromPhase: workflow.phase,
    operationReceipts: workflow.operationReceipts?.map((receipt) => receipt.idempotencyKey === ambiguousReceipt.idempotencyKey ? { ...receipt, status: "reconciliation_required" as const, updatedAt } : receipt),
    revision: workflowRevision(workflow) + 1,
    progress: workflow.progress ? { ...workflow.progress, condition: "blocked", activity: `Operation ${ambiguousReceipt.operationId} requires reconciliation after restart`, nextAction: "Confirm the external system-of-record result before retrying", lastActivityAt: updatedAt } : workflow.progress,
    updatedAt,
    error: `The runtime restarted after ${ambiguousReceipt.operationId} began but before completion evidence was recorded. Reconcile idempotency key ${ambiguousReceipt.idempotencyKey} before continuing.`,
  };
}

function reconcileSupervisorAdvice(
  workflow: EngineeringWorkflow,
  reported: ReportedSupervisorAdvice,
  automaticRecovery: boolean,
): EngineeringWorkflow {
  const supervisor = workflow.supervisor;
  const advice = reported.advice;
  if (workflow.id !== reported.workflowId || workflow.phase !== "blocked" || !workflow.blockedFromPhase || supervisor?.status !== "consulting") return workflow;
  if (!advice.eventId || !advice.consultationId || !advice.phaseRunId || advice.planRevision === undefined || advice.workflowRevision === undefined || !advice.runtimeId) return workflow;
  if (supervisorAdviceAlreadyApplied(workflow, advice.eventId)
    || advice.consultationId !== supervisor.activeConsultationId
    || advice.phaseRunId !== supervisor.consultationPhaseRunId
    || advice.planRevision !== supervisor.consultationPlanRevision
    || advice.workflowRevision !== supervisor.consultationWorkflowRevision
    || advice.runtimeId !== workflow.phaseRun?.runtimeId) return workflow;
  const consumesRepair = advice.action === "enter_repair";
  const repairEligible = workflow.blockedFromPhase === "building" || workflow.blockedFromPhase === "verifying" || workflow.blockedFromPhase === "reviewing" || workflow.blockedFromPhase === "repairing";
  const repairAttempts = consumesRepair ? workflow.repairAttempts + 1 : workflow.repairAttempts;
  const canRecover = automaticRecovery && (!consumesRepair || repairEligible && repairAttempts <= workflow.maxRepairAttempts);
  const guidance = advice.guidance?.trim() || advice.summary;
  const updatedSupervisor = {
    ...supervisor,
    status: "idle" as const,
    pendingGuidance: canRecover ? `[Loop supervisor — ${advice.action.toUpperCase()}]\n\n${guidance}\n\nBasis: ${advice.basis}` : null,
    lastAdvice: advice,
    activeConsultationId: null,
    consultationPhaseRunId: null,
  };
  return {
    ...workflow,
    ...(canRecover ? { phase: advice.action === "enter_repair" ? "repairing" as const : workflow.blockedFromPhase, blockedFromPhase: null, repairAttempts } : {}),
    supervisor: updatedSupervisor,
    revision: workflowRevision(workflow) + 1,
    processedEventIds: rememberSupervisorAdviceEvent(workflow, advice.eventId),
    updatedAt: advice.receivedAt,
    error: canRecover ? null : advice.summary,
  };
}

export function reconcilePersistedWorkflow(
  workflow: EngineeringWorkflow,
  events: ReadonlyArray<OwnedSessionEvent>,
): EngineeringWorkflow {
  let reconciled = workflow;
  const previousSequence = workflow.reconciledTimelineSequence ?? -1;
  const pendingEvents = events.filter((event) => event.sequence > previousSequence).sort((left, right) => left.sequence - right.sequence);
  for (const event of pendingEvents) {
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) continue;
    const data = event.data as Record<string, unknown>;

    if (event.type === "workflow_progress_recorded" && data.workflowId === reconciled.id) {
      const value = data.event;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const normalized = value as Record<string, unknown>;
        const reported = workflowProgressFromRpc({ type: "tool_execution_end", toolCallId: String(normalized.eventId ?? event.id ?? event.sequence), toolName: "piss_workflow_progress", result: { details: { workflowId: data.workflowId, ...normalized } } }, event.sequence, typeof normalized.runtimeId === "string" ? normalized.runtimeId : reconciled.phaseRun?.runtimeId ?? "legacy", typeof normalized.receivedAt === "string" ? normalized.receivedAt : event.timestamp);
        if (reported) reconciled = applyWorkflowProgress(reconciled, reported.event);
      }
      continue;
    }

    if (event.type === "workflow_draft_recorded" && data.workflowId === reconciled.id) {
      const value = data.report;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const reported = workflowDraftFromRpc({ type: "tool_execution_end", toolCallId: String(event.id ?? event.sequence), toolName: "piss_workflow_draft", result: { details: { workflowId: data.workflowId, ...(value as Record<string, unknown>) } } }, event.timestamp);
        if (reported) reconciled = applyWorkflowDraftReport(reconciled, reported);
      }
      continue;
    }

    if (event.type === "workflow_checkpoint_recorded" && data.workflowId === reconciled.id) {
      const value = data.checkpoint;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const normalized = value as Record<string, unknown>;
        const { artifact, ...checkpointDetails } = normalized;
        const reported = workflowCheckpointFromRpc({ type: "tool_execution_end", toolCallId: String(normalized.toolCallId ?? event.id ?? event.sequence), toolName: "piss_workflow_checkpoint", result: { details: { workflowId: data.workflowId, ...checkpointDetails, ...(typeof artifact === "string" ? { artifact } : {}) } } }, event.sequence, typeof normalized.receivedAt === "string" ? normalized.receivedAt : event.timestamp);
        if (reported) reconciled = applyWorkflowCheckpoint(reconciled, reported.checkpoint);
      }
      continue;
    }

    if (event.type === "workflow_guidance_delivery" && data.workflowId === reconciled.id) {
      const delivery = data.event;
      if (typeof delivery === "object" && delivery !== null && !Array.isArray(delivery)) {
        const value = delivery as Record<string, unknown>;
        if (typeof value.eventId === "string" && typeof value.guidanceId === "string" && typeof value.commandId === "string"
          && typeof value.planRevision === "number" && Number.isSafeInteger(value.planRevision) && typeof value.deliveredAt === "string") {
          reconciled = recordWorkflowGuidanceDelivery(reconciled, value as WorkflowGuidanceDeliveryEvent);
        }
      }
      continue;
    }

    if (event.type === "workflow_supervisor_advice" && data.workflowId === reconciled.id) {
      const reported = workflowSupervisorAdviceFromRpc({ type: "tool_execution_end", toolCallId: String(event.id ?? event.sequence), toolName: "piss_workflow_supervisor_advice", result: { details: data } }, event.timestamp);
      if (reported) reconciled = reconcileSupervisorAdvice(reconciled, reported, data.automaticRecovery === true);
      continue;
    }

    if (event.type === "workflow_authority_decision" && data.workflowId === reconciled.id) {
      try {
        const decision = Schema.decodeUnknownSync(EngineeringWorkflowAuthorityDecisionSchema)(data);
        if (decision.planRevision === workflowPlanRevision(reconciled) && decision.phaseRunId === reconciled.phaseRun?.id) {
          reconciled = recordAuthorityDecision(reconciled, decision);
        }
      } catch { /* malformed durable authority events remain visible in the raw timeline only */ }
      continue;
    }

    const message = data as RpcMessage;
    const reportedDraft = workflowDraftFromRpc(message, event.timestamp);
    if (reportedDraft) {
      reconciled = applyWorkflowDraftReport(reconciled, reportedDraft);
      continue;
    }
    const reportedProgress = workflowProgressFromRpc(message, event.sequence, reconciled.phaseRun?.runtimeId ?? "legacy", event.timestamp);
    if (reportedProgress?.workflowId === reconciled.id) {
      reconciled = applyWorkflowProgress(reconciled, reportedProgress.event);
      continue;
    }
    const reportedCheckpoint = workflowCheckpointFromRpc(message, event.sequence, event.timestamp);
    if (reportedCheckpoint?.workflowId === reconciled.id) reconciled = applyWorkflowCheckpoint(reconciled, reportedCheckpoint.checkpoint);
  }
  const reconciledTimelineSequence = pendingEvents.at(-1)?.sequence;
  return reconciledTimelineSequence === undefined
    ? reconciled
    : { ...reconciled, reconciledTimelineSequence };
}

async function detectBranch(workspaceFd: number): Promise<string | null> {
  const options = { cwd: `/proc/self/fd/${workspaceFd}`, timeout: 2_000, maxBuffer: 16 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } };
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
    const branch = stdout.trim();
    return branch && branch.length <= 1024 ? branch : null;
  } catch {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], options);
      const commit = stdout.trim();
      return commit && commit.length <= 1000 ? `detached@${commit}` : null;
    } catch { return null; }
  }
}

export function processArguments(workspace: Workspace, name: string, workflowResourceDir: string | undefined, sessionFile?: string, supervisor = false): ReadonlyArray<string> {
  const workflowResources = workflowResourceDir ? [
    "--extension",
    join(workflowResourceDir, "piss-workflow.ts"),
    "--extension",
    join(workflowResourceDir, "piss-browser.ts"),
    "--skill",
    join(workflowResourceDir, "skills", "piss-ui-verification"),
    ...["define", "research", "plan", "build", "verify", "review", "supervisor"].flatMap((phase) => [
      "--skill",
      join(workflowResourceDir, "skills", `piss-engineering-${phase}`),
    ]),
  ] : [];
  return [
    "--mode",
    "rpc",
    "--name",
    name,
    ...(sessionFile ? ["--session", sessionFile] : []),
    ...workflowResources,
    ...(supervisor
      ? ["--tools", "read,grep,find,ls,piss_workflow_supervisor_advice"]
      : ["--exclude-tools", "piss_workflow_supervisor_advice"]),
    workspace.trustProjectResources && !supervisor ? "--approve" : "--no-approve",
  ];
}

export function workflowGuidanceForDispatch(workflow: EngineeringWorkflow): string | undefined {
  const applicable = (workflow.guidance ?? []).filter((item) => workflowGuidanceAppliesToCurrentPhase(workflow, item));
  const queued = applicable.filter((item) => item.status === "queued");
  const delivered = applicable.filter((item) => item.status === "delivered");
  const durable = queued.map((item) => `[Workflow guidance ${item.id} — QUEUED]\n${item.text}`).join("\n\n---\n\n");
  const acknowledged = delivered.length > 0 ? `Previously delivered guidance IDs (do not apply twice; acknowledge from transcript evidence): ${delivered.map((item) => item.id).join(", ")}` : "";
  return [durable, acknowledged, workflow.queuedIntervention?.trim()].filter(Boolean).join("\n\n---\n\n") || undefined;
}

export function transcriptGuidanceIds(
  workflow: EngineeringWorkflow,
  entries: ReadonlyArray<unknown>,
): ReadonlySet<string> {
  const queuedIds = new Set((workflow.guidance ?? []).filter((item) => item.status === "queued").map((item) => item.id));
  const observed = new Set<string>();
  if (queuedIds.size === 0) return observed;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || (entry as Record<string, unknown>).type !== "message") continue;
    const message = (entry as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null || Array.isArray(message) || (message as Record<string, unknown>).role !== "user") continue;
    const text = textFromContent(message);
    for (const id of queuedIds) {
      if (text.includes(`[Workflow guidance ${id} —`)) observed.add(id);
    }
  }
  return observed;
}

export function reconcileTranscriptGuidance(
  workflow: EngineeringWorkflow,
  entries: ReadonlyArray<unknown>,
  deliveredAt: string,
): EngineeringWorkflow {
  const observed = transcriptGuidanceIds(workflow, entries);
  let reconciled = workflow;
  for (const item of workflow.guidance ?? []) {
    if (item.status !== "queued" || !observed.has(item.id)) continue;
    reconciled = recordWorkflowGuidanceDelivery(reconciled, {
      eventId: `guidance-delivered:${item.commandId}`,
      guidanceId: item.id,
      commandId: item.commandId,
      planRevision: item.planRevision,
      deliveredAt,
    });
  }
  return reconciled;
}

function workflowInterventionMessage(phase: EngineeringWorkflowPhase, feedback: string, queued: boolean): string {
  const label = queued ? "Queued workflow guidance for the next agent run" : "Workflow user intervention";
  return `[${label} — ${phase.toUpperCase()}]\n\n${feedback}`;
}

export function interruptedWorkflowRecoveryPhase(workflow: EngineeringWorkflow): EngineeringWorkflowPhase | null {
  if (workflow.blockedFromPhase && !isTerminalWorkflowPhase(workflow.blockedFromPhase) && workflow.blockedFromPhase !== "blocked") {
    return workflow.blockedFromPhase;
  }
  if (!workflow.plan) {
    if (!workflow.specification) return "defining";
    if (workflow.researchPolicy && !workflow.researchBrief) return "researching";
    return "planning";
  }
  const checkpoint = workflow.checkpoint;
  if (!checkpoint) return "building";
  if (checkpoint.outcome === "blocked") {
    if (checkpoint.stage === "build") return "building";
    if (checkpoint.stage === "verify") return "verifying";
    if (checkpoint.stage === "review") return "reviewing";
  }
  if (checkpoint.stage === "build" && checkpoint.outcome === "passed") return "verifying";
  if (checkpoint.stage === "verify" && checkpoint.outcome === "passed") return "reviewing";
  if (checkpoint.stage === "review" && checkpoint.outcome === "passed") return "readyToShip";
  return "building";
}

export function workflowPhasePrompt(workflow: EngineeringWorkflow, feedback?: string): string {
  const phaseRun = workflow.phaseRun;
  const contract = `Workflow ID: ${workflow.id}\nWorkflow revision: ${workflowRevision(workflow)}\nPlan revision: ${workflowPlanRevision(workflow)}\nPhase run ID: ${phaseRun?.id ?? "legacy"}\nRuntime generation: ${phaseRun?.runtimeId ?? "legacy"}\nEvery progress event and the terminal checkpoint must repeat the workflow ID, plan revision, phase run ID, and runtime generation exactly. You must finish this phase by calling piss_workflow_checkpoint with this exact workflow ID.`;
  const authority = `\n\nStanding execution authority:\nThe operator's approval of the complete delivery plan authorizes unattended execution of every operation explicitly listed in that plan, including listed commits, pushes, migrations, deployments, and bounded production reads or writes. Do not stop to request confirmation again for approved work. Do not extend scope, invent credentials or evidence, or bypass a real external policy.`;
  const guidance = feedback ? `\n\nOperator guidance for this phase:\n${feedback}` : "";
  const progress = workflow.progress;
  const boundary = workflowFirstIncomplete(workflow);
  const execution = `\n\nDurable execution state:\nCurrent slice: ${progress?.currentSliceId ?? "not selected"}\nCompleted slices: ${progress?.completedSliceIds.join(", ") || "none"}\nPassed criteria: ${progress?.passedCriterionIds.join(", ") || "none"}\nFirst incomplete slice: ${boundary?.sliceId ?? "none"}\nFirst incomplete criterion: ${boundary?.criterionId ?? "none"}\nOperation receipts: ${(workflow.operationReceipts ?? []).map((item) => `${item.operationId}:${item.status}:${item.idempotencyKey}`).join(", ") || "none"}\nUnapplied guidance IDs: ${(workflow.guidance ?? []).filter((item) => item.status !== "applied" && workflowGuidanceAppliesToCurrentPhase(workflow, item)).map((item) => item.id).join(", ") || "none"}\nResume from that exact safe boundary. Never repeat a completed operation receipt; reconcile any started destructive operation before proceeding.`;
  switch (workflow.phase) {
    case "defining":
      return `/skill:piss-engineering-define\n${contract}\n\nObjective:\n${workflow.objective}${guidance}`;
    case "researching":
      return `/skill:piss-engineering-research\n${contract}\n\nExternal research policy: ${workflow.researchPolicy ?? "local_only"}\nExternal queries may disclose technical details to configured providers. Never include secrets, customer data, local paths, or private repository names in an external query.\n\nApproved specification:\n${workflow.specification ?? "[missing specification]"}\n\nResearch questions (preserve IDs and wording exactly):\n${JSON.stringify(workflow.researchQuestions ?? [], null, 2)}${guidance}`;
    case "planning":
      return `/skill:piss-engineering-plan\n${contract}\n\nApproved specification:\n${workflow.specification ?? "[missing specification]"}\n\nValidated research brief (apply every adopt/adapt finding and report its ID):\n${workflow.researchBrief ? JSON.stringify(workflow.researchBrief, null, 2) : "[legacy workflow: no research brief]"}${guidance}`;
    case "building":
      return `/skill:piss-engineering-build\n${contract}${authority}\n\nApproved specification (the workflow completion boundary):\n${workflow.specification ?? "[missing specification]"}\n\nApproved complete delivery plan:\n${workflow.plan ?? "[missing plan]"}${execution}${guidance}`;
    case "repairing":
      return `/skill:piss-engineering-build\n${contract}${authority}\n\nRepair attempt ${workflow.repairAttempts} of ${workflow.maxRepairAttempts}.\n\nApproved specification (the workflow completion boundary):\n${workflow.specification ?? "[missing specification]"}\n\nApproved complete delivery plan:\n${workflow.plan ?? "[missing plan]"}\n\nFailure or review findings to repair:\n${workflow.error ?? workflow.checkpoint?.summary ?? "Inspect the latest failed evidence."}${execution}${guidance}`;
    case "verifying":
      return `/skill:piss-engineering-verify\n${contract}${authority}\n\nApproved specification (verify every criterion):\n${workflow.specification ?? "[missing specification]"}\n\nApproved complete delivery plan:\n${workflow.plan ?? "[missing plan]"}\n\nBuild result:\n${workflow.checkpoint?.summary ?? "Implementation checkpoint accepted."}${execution}${guidance}`;
    case "reviewing":
      return `/skill:piss-engineering-review\n${contract}${authority}\n\nApproved specification (review every criterion):\n${workflow.specification ?? "[missing specification]"}\n\nApproved complete delivery plan:\n${workflow.plan ?? "[missing plan]"}\n\nVerification result:\n${workflow.checkpoint?.summary ?? "Verification checkpoint accepted."}${execution}${guidance}`;
    default:
      throw new Error(`Workflow phase ${workflow.phase} cannot start an agent run`);
  }
}

function latestAssistantEvidence(events: ReadonlyArray<OwnedSessionEvent>): string {
  for (const event of [...events].reverse()) {
    if (event.type !== "message_end" || typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) continue;
    const message = (event.data as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null || Array.isArray(message) || (message as Record<string, unknown>).role !== "assistant") continue;
    return boundedText(textFromContent(message) || "[assistant response contained no text]", 16 * 1024);
  }
  return "[no recent assistant prose]";
}

function workflowSupervisorPrompt(workflow: EngineeringWorkflow, recentAssistant = "[not supplied]"): string {
  const supervisor = workflow.supervisor;
  const checkpoint = workflow.checkpoint;
  return `/skill:piss-engineering-supervisor
Workflow ID: ${workflow.id}
Consultation ID: ${supervisor?.activeConsultationId ?? "missing"}
Workflow revision: ${supervisor?.consultationWorkflowRevision ?? workflowRevision(workflow)}
Plan revision: ${supervisor?.consultationPlanRevision ?? workflowPlanRevision(workflow)}
Phase run ID: ${supervisor?.consultationPhaseRunId ?? workflow.phaseRun?.id ?? "legacy"}
Runtime generation: ${workflow.phaseRun?.runtimeId ?? "legacy"}
Advice event ID: supervisor-advice:${supervisor?.activeConsultationId ?? "missing"}
You must finish by calling piss_workflow_supervisor_advice with every identity above exactly.

Blocked phase: ${workflow.blockedFromPhase ?? "unknown"}
Consultation: ${supervisor?.consultations ?? 0}
Repeated blocker count: ${supervisor?.repeatedBlockerCount ?? 0} of ${MAX_SUPERVISOR_REPEATS_PER_BLOCKER}

Approved specification:
${workflow.specification ?? "[missing specification]"}

Approved delivery plan:
${workflow.plan ?? "[missing plan]"}

Blocked checkpoint:
${checkpoint ? `${checkpoint.stage}/${checkpoint.outcome}: ${checkpoint.summary}` : "[missing checkpoint]"}

Control-plane blocker:
${workflow.error ?? "[no additional control-plane blocker]"}

Most recent worker response:
${recentAssistant}

Previous supervisor advice:
${supervisor?.lastAdvice ? `${supervisor.lastAdvice.action}: ${supervisor.lastAdvice.summary}\nBasis: ${supervisor.lastAdvice.basis}` : "[none]"}

Standing authority already granted:
Plan approval authorizes unattended execution of every operation explicitly listed in the approved plan, including listed commits, pushes, migrations, deployments, and bounded production reads or writes. Requests to reconfirm those operations are recoverable worker uncertainty, not a human authority boundary.

Adjudicate only within that approved authority. Prefer bounded automatic recovery when evidence supports it, but never invent credentials, evidence, new scope, or permission to cross a real external safety boundary.`;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function awaitSpawn(child: ChildProcessWithoutNullStreams, command: string): Effect.Effect<void, PiSpawnError> {
  return Effect.callback<void, PiSpawnError>((resume, signal) => {
    const onSpawn = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new PiSpawnError({ command, cause })));
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", cleanup, { once: true });
    return Effect.sync(cleanup);
  });
}

function signalOwnedRuntime(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* process already exited */ } }
}

function beginTermination(session: MutableOwnedSession): Promise<void> {
  if (session.termination) return session.termination;
  const child = session.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  session.termination = new Promise((resolve) => {
    let done = false;
    const complete = (confirmed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      child.off("close", onClose);
      if (confirmed && session.snapshot.status === "stopping") {
        session.snapshot = { ...session.snapshot, status: "stopped", lastActivityAt: now() };
      } else if (!confirmed && child.exitCode === null && child.signalCode === null) {
        session.snapshot = {
          ...session.snapshot,
          status: "crashed",
          lastActivityAt: now(),
          error: "Pi did not exit after SIGKILL",
        };
      }
      resolve();
    };
    const onClose = () => complete(true);
    const killTimer = setTimeout(() => {
      signalOwnedRuntime(child, "SIGKILL");
    }, TERMINATE_TIMEOUT_MS);
    const forceTimer = setTimeout(() => complete(false), TERMINATE_TIMEOUT_MS * 2);
    child.once("close", onClose);
    try { child.stdin.end(); } catch { /* stdin already closed */ }
    signalOwnedRuntime(child, "SIGTERM");
  });
  return session.termination;
}

function terminate(session: MutableOwnedSession): Effect.Effect<void> {
  return Effect.promise(() => beginTermination(session));
}

export const PiRuntimeSupervisorLive = Layer.effect(
  PiRuntimeSupervisor,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directories = yield* WorkspaceDirectory;
    const workspaces = yield* WorkspaceRepository;
    const fileMentions = yield* FileMentionSearch;
    const notifications = yield* PushNotifications;
    const sessions = new Map<string, MutableOwnedSession>();
    const sessionSubscribers = new Map<string, Set<(session: OwnedSession) => void>>();
    const creationLock = yield* Semaphore.make(1);
    const storagePath = join(config.stateDir, "owned-sessions.json");
    const timelineDirectory = join(config.stateDir, "timelines");
    const timelinePersistenceTails = new Map<string, Promise<void>>();
    const artifactAdoptionTails = new Map<string, Promise<void>>();
    const activeBrowserRecordings = new Map<string, { readonly runtimeId: string; readonly recordingId: string }>();
    const removingSessionIds = new Set<string>();
    let persistenceTail = Promise.resolve();
    let continueWorkflowAfterSettle = (_session: MutableOwnedSession): void => undefined;

    const publishSession = (session: MutableOwnedSession): void => {
      const listeners = sessionSubscribers.get(session.snapshot.id);
      if (!listeners || listeners.size === 0) return;
      const snapshot = cloneSession(session.snapshot);
      for (const listener of listeners) {
        try { listener(snapshot); }
        catch (cause) { console.error(`Session subscriber failed for ${snapshot.id}`, cause); }
      }
    };

    const persistedRecords = (): ReadonlyArray<PersistedOwnedSession> => [...sessions.values()].map((session) => ({
      id: session.snapshot.id,
      runtimeId: session.snapshot.runtimeId,
      workspaceId: session.snapshot.workspaceId,
      name: session.snapshot.name,
      branch: session.snapshot.branch,
      status: session.snapshot.status,
      resumeAfterRestart: session.resumeAfterRestart,
      resumeRunAfterRestart: session.resumeRunAfterRestart,
      piSessionId: session.snapshot.piSessionId,
      sessionFile: session.snapshot.sessionFile,
      sessionFileIdentity: session.sessionFileIdentity && {
        device: session.sessionFileIdentity.device.toString(),
        inode: session.sessionFileIdentity.inode.toString(),
      },
      workspaceIdentity: {
        device: session.workspaceIdentity.device.toString(),
        inode: session.workspaceIdentity.inode.toString(),
      },
      model: session.snapshot.model,
      thinkingLevel: session.snapshot.thinkingLevel,
      usage: session.snapshot.usage,
      autoCompactionEnabled: session.snapshot.autoCompactionEnabled,
      pendingMessageCount: session.snapshot.pendingMessageCount,
      compaction: session.snapshot.compaction,
      workflow: session.snapshot.workflow,
      createdAt: session.snapshot.createdAt,
      lastActivityAt: session.snapshot.lastActivityAt,
      error: session.snapshot.error,
      interactiveRequests: session.snapshot.interactiveRequests,
      acceptedCommandIds: [...session.acceptedCommandIds].slice(-128),
      processedWorkflowStartMutationIds: [...session.processedWorkflowStartMutationIds],
    }));

    const inspectSessionFile = (
      sessionId: string,
      sessionFile: string,
      workspaceRoot: string,
      expectedSessionId?: string,
      expected?: { readonly device: bigint; readonly inode: bigint } | null,
    ): Effect.Effect<{ readonly device: bigint; readonly inode: bigint; readonly piSessionId: string }, SessionResumeError> => Effect.tryPromise({
      try: async () => {
        if (!isAbsolute(sessionFile)) throw new Error("Pi session path is not absolute");
        const allowedRoots = await Promise.all((config.piSessionRoots ?? [join(homedir(), ".pi", "agent", "sessions")]).map((root) => realpath(root)));
        const handle = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const metadata = await handle.stat({ bigint: true });
          if (!metadata.isFile()) throw new Error("Pi session is not a regular file");
          const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
          if (!allowedRoots.some((root) => isWithin(root, canonical))) throw new Error("Pi session is outside authorized session storage");
          if (expected && (metadata.dev !== expected.device || metadata.ino !== expected.inode)) {
            throw new Error("Pi session file changed on disk");
          }
          const headerBuffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
          const newline = headerBuffer.subarray(0, bytesRead).indexOf(0x0a);
          if (newline < 0) throw new Error("Pi session header is missing or too large");
          const header = JSON.parse(headerBuffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
          if (header.type !== "session" || header.cwd !== workspaceRoot || typeof header.id !== "string" || !header.id || (expectedSessionId !== undefined && header.id !== expectedSessionId)) {
            throw new Error("Pi session does not belong to the authorized workspace");
          }
          return { device: metadata.dev, inode: metadata.ino, piSessionId: header.id };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => new SessionResumeError({ sessionId, message: "The saved Pi session file cannot be resumed safely", cause }),
    });

    const inspectSessionFileWhenReady = (
      sessionId: string,
      sessionFile: string,
      workspaceRoot: string,
      expectedSessionId: string,
    ): Effect.Effect<{ readonly device: bigint; readonly inode: bigint }, SessionResumeError> => Effect.gen(function* () {
      let lastError: SessionResumeError | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = yield* inspectSessionFile(sessionId, sessionFile, workspaceRoot, expectedSessionId).pipe(
          Effect.map((identity) => ({ _tag: "identity" as const, identity })),
          Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
        );
        if (result._tag === "identity") return result.identity;
        lastError = result.error;
        yield* Effect.sleep("25 millis");
      }
      return yield* Effect.fail(lastError ?? new SessionResumeError({ sessionId, message: "Pi did not create its session transcript" }));
    });

    const persist = (publish = true): Effect.Effect<void, SessionStorageError> => Effect.tryPromise({
      try: () => {
        const snapshot = persistedRecords();
        const next = persistenceTail.then(() => persistOwnedSessions(storagePath, snapshot));
        persistenceTail = next.catch(() => undefined);
        return next;
      },
      catch: (cause) => new SessionStorageError({ message: "Could not persist owned-session metadata", cause }),
    }).pipe(Effect.tap(() => Effect.sync(() => {
      if (!publish) return;
      for (const session of sessions.values()) publishSession(session);
    })));


    const persistProjectionEvent = (
      session: MutableOwnedSession,
      event: OwnedSessionEvent,
      output: DetachedToolOutput | undefined,
      persistCompactTimeline: boolean,
    ): void => {
      const sessionId = session.snapshot.id;
      const timeline = persistCompactTimeline
        ? { sequence: session.sequence, events: cloneSession(session.snapshot).events }
        : undefined;
      const previous = timelinePersistenceTails.get(sessionId) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (output) await persistOwnedSessionToolOutput(timelineDirectory, sessionId, output.ref, output.value);
        await appendOwnedSessionTimelineEvent(timelineDirectory, sessionId, event);
        if (timeline) await persistOwnedSessionTimeline(timelineDirectory, sessionId, timeline);
      });
      timelinePersistenceTails.set(sessionId, next.catch(() => undefined));
      void next.catch((cause) => console.error(`Could not persist timeline projection for session ${sessionId}`, cause));
    };

    const removeTimeline = (sessionId: string): Effect.Effect<void, SessionStorageError> => Effect.tryPromise({
      try: async () => {
        await artifactAdoptionTails.get(sessionId);
        artifactAdoptionTails.delete(sessionId);
        activeBrowserRecordings.delete(sessionId);
        await timelinePersistenceTails.get(sessionId);
        timelinePersistenceTails.delete(sessionId);
        await Promise.all([
          removeOwnedSessionTimeline(timelineDirectory, sessionId),
          removeOwnedSessionArtifacts(config.stateDir, sessionId),
        ]);
      },
      catch: (cause) => new SessionStorageError({ message: `Could not remove timeline for session ${sessionId}`, cause }),
    });

    const loaded = yield* Effect.tryPromise({
      try: () => loadOwnedSessions(storagePath),
      catch: (cause) => new SessionStorageError({ message: "Could not load owned-session metadata", cause }),
    });
    let reconciledPersistedWorkflow = false;
    yield* Effect.forEach(loaded, (record) => Effect.gen(function* () {
      const workspace = yield* workspaces.findById(record.workspaceId);
      if (!workspace) {
        return yield* Effect.fail(new SessionStorageError({ message: `Persisted session ${record.id} refers to an unauthorized workspace` }));
      }
      const rootHandle = yield* directories.openAuthorized(workspace.root).pipe(
        Effect.mapError((cause) => new SessionStorageError({ message: `Persisted session ${record.id} workspace is unavailable`, cause })),
      );
      const rootStat = yield* Effect.tryPromise({
        try: () => rootHandle.stat({ bigint: true }),
        catch: (cause) => new SessionStorageError({ message: `Could not identify persisted session ${record.id} workspace`, cause }),
      }).pipe(Effect.ensuring(Effect.promise(() => rootHandle.close())));
      const expectedWorkspace = { device: BigInt(record.workspaceIdentity.device), inode: BigInt(record.workspaceIdentity.inode) };
      const workspaceChanged = rootStat.dev !== expectedWorkspace.device || rootStat.ino !== expectedWorkspace.inode;
      const timeline = yield* Effect.tryPromise({
        try: () => loadOwnedSessionTimeline(timelineDirectory, record.id),
        catch: (cause) => new SessionStorageError({ message: `Could not load persisted timeline for session ${record.id}`, cause }),
      });
      const timelineReconciledWorkflow = record.workflow ? reconcilePersistedWorkflow(record.workflow, timeline.events) : null;
      const approvalReconciledWorkflow = timelineReconciledWorkflow
        ? reconcileWorkflowApprovalGuidance(timelineReconciledWorkflow, now())
        : null;
      const recoversPersistedApprovalGuidance = approvalReconciledWorkflow !== timelineReconciledWorkflow;
      if (record.workflow && approvalReconciledWorkflow !== record.workflow) reconciledPersistedWorkflow = true;
      const mutationLock = yield* Semaphore.make(1);
      const interrupted = record.status !== "stopped" && record.status !== "crashed";
      const interruptedRequestCount = record.interactiveRequests?.length ?? 0;
      const status: OwnedSessionStatus = workspaceChanged || record.status === "crashed" ? "crashed" : "stopped";
      const restartWorkflow = approvalReconciledWorkflow ? reconcileWorkflowAfterRestart(approvalReconciledWorkflow) : null;
      sessions.set(record.id, {
        child: null,
        eventBytes: timeline.events.reduce((total, event) => total + eventBytes(event), 0),
        sequence: timeline.sequence,
        stderr: "",
        activeRunImageCharacters: 0,
        resumeAfterRestart: (record.resumeAfterRestart === true || recoversPersistedApprovalGuidance) && status === "stopped",
        resumeRunAfterRestart: (record.resumeRunAfterRestart === true && record.resumeAfterRestart === true || recoversPersistedApprovalGuidance) && status === "stopped",
        finalResponseRecoveryAttempted: false,
        quarantined: status === "crashed",
        workflowDispatchPending: false,
        workflowEventTail: Promise.resolve(),
        workflowCancelRequested: null,
        pendingWorkflowAuthority: new Map(),
        resolvedWorkflowAuthority: new Map(),
        pending: new Map(),
        mutationLock,
        workspaceIdentity: expectedWorkspace,
        sessionFileIdentity: record.sessionFileIdentity
          ? { device: BigInt(record.sessionFileIdentity.device), inode: BigInt(record.sessionFileIdentity.inode) }
          : null,
        acceptedCommandIds: new Set(record.acceptedCommandIds),
        processedWorkflowStartMutationIds: new Set(record.processedWorkflowStartMutationIds ?? []),
        interactiveTimers: new Map(),
        snapshot: {
          id: record.id,
          runtimeId: record.runtimeId,
          workspaceId: record.workspaceId,
          name: record.name,
          branch: record.branch ?? null,
          status,
          pid: null,
          piSessionId: record.piSessionId,
          sessionFile: record.sessionFile,
          model: record.model,
          thinkingLevel: record.thinkingLevel,
          usage: record.usage ?? null,
          autoCompactionEnabled: record.autoCompactionEnabled ?? null,
          pendingMessageCount: record.pendingMessageCount ?? 0,
          compaction: record.compaction ?? idleCompaction(),
          workflow: restartWorkflow,
          createdAt: record.createdAt,
          lastActivityAt: record.lastActivityAt,
          events: [...timeline.events],
          interactiveRequests: [],
          error: workspaceChanged
            ? "The authorized workspace checkout changed on disk; this session cannot be resumed safely"
            : interruptedRequestCount > 0
              ? `${interruptedRequestCount} pending interactive request${interruptedRequestCount === 1 ? " was" : "s were"} cancelled when the runtime disconnected`
              : interrupted
                ? "The control plane stopped this runtime; the Pi transcript is preserved and can be resumed"
                : record.error,
        },
      });
    }), { discard: true });
    if (reconciledPersistedWorkflow || loaded.some((record) => record.status !== "stopped" && record.status !== "crashed" || (record.interactiveRequests?.length ?? 0) > 0)) yield* persist();
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      await Promise.all([...artifactAdoptionTails.values()]);
      await Promise.all([...timelinePersistenceTails.values()]);
    }));

    const notifyAttention = (session: MutableOwnedSession): void => {
      const status = session.snapshot.status;
      if (session.snapshot.workflow && isAutonomousWorkflowPhase(session.snapshot.workflow.phase)) return;
      if (status !== "finished" && status !== "blocked" && status !== "crashed") return;
      void Effect.runPromise(notifications.notify(cloneSession(session.snapshot), status)).catch(() => undefined);
    };

    const appendEvent = (session: MutableOwnedSession, type: string, data: unknown, trustedInternal = false): void => {
      if (session.quarantined && !trustedInternal) return;
      if (type === "agent_settled") session.activeRunImageCharacters = 0;
      const timestamp = now();
      const sequence = ++session.sequence;
      const projected = projectEventWithDetachedOutput(session.snapshot.id, sequence, type, data);
      const event: OwnedSessionEvent = {
        id: `${session.snapshot.id}:${sequence}`,
        sequence,
        type,
        timestamp,
        data: projected.data,
      };
      const retained = appendBoundedEvent(session.snapshot.events, session.eventBytes, event);
      session.eventBytes = retained.bytes;
      const previousStatus = session.snapshot.status;
      session.snapshot = {
        ...session.snapshot,
        status: type === "agent_start"
          ? transitionAttentionState(previousStatus, "agentStarted")
          : type === "agent_settled" && session.snapshot.workflow && isAutonomousWorkflowPhase(session.snapshot.workflow.phase)
            ? "working"
            : type === "agent_settled"
              ? transitionAttentionState(previousStatus, "agentSettled")
              : previousStatus,
        lastActivityAt: timestamp,
        events: retained.events,
      };
      if (type === "agent_settled" && !session.sessionFileIdentity && session.snapshot.sessionFile && session.snapshot.piSessionId) {
        void Effect.runPromise(Effect.gen(function* () {
          const workspace = yield* workspaces.findById(session.snapshot.workspaceId);
          if (!workspace) return yield* Effect.fail(new Error("The authorized workspace is no longer registered"));
          session.sessionFileIdentity = yield* inspectSessionFileWhenReady(session.snapshot.id, session.snapshot.sessionFile!, workspace.root, session.snapshot.piSessionId!);
          yield* persist();
        })).catch((cause) => {
          crash(session, "Pi completed a run without a safe durable transcript", cause);
          void Effect.runPromise(terminate(session));
        });
      }
      const persistCompactTimeline = type === "message_end" || type === "tool_execution_end" || type === "agent_settled" || type === "compaction_start" || type === "compaction_end" || type === "auto_retry_start" || type === "auto_retry_end";
      persistProjectionEvent(session, event, projected.output, persistCompactTimeline);
      publishSession(session);
      if (session.snapshot.status !== previousStatus) {
        notifyAttention(session);
        void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist owned-session state transition", cause));
      }
    };

    for (const session of sessions.values()) {
      let unresolvedRecordingId: string | undefined;
      for (const event of session.snapshot.events) {
        if (event.type === "browser_recording_started" && typeof event.data === "object" && event.data !== null && "recordingId" in event.data && typeof event.data.recordingId === "string") {
          unresolvedRecordingId = event.data.recordingId;
        }
        if ((event.type === "browser_artifact_created" || event.type === "browser_artifact_failed") && typeof event.data === "object" && event.data !== null) {
          const data = event.data as Record<string, unknown>;
          const artifact = typeof data.artifact === "object" && data.artifact !== null ? data.artifact as Record<string, unknown> : undefined;
          if (data.recordingId === unresolvedRecordingId || artifact?.id === unresolvedRecordingId) unresolvedRecordingId = undefined;
        }
      }
      if (unresolvedRecordingId) appendEvent(session, "browser_artifact_failed", {
        recordingId: unresolvedRecordingId,
        message: "Browser recording was interrupted by a control-plane restart before publication",
      }, true);
    }

    const queueBrowserArtifactHandoff = (session: MutableOwnedSession, handoff: Exclude<BrowserArtifactHandoff, { readonly _tag: "none" }>): void => {
      const sessionId = session.snapshot.id;
      const runtimeId = session.snapshot.runtimeId;
      if (removingSessionIds.has(sessionId)) return;
      const previous = artifactAdoptionTails.get(sessionId) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (removingSessionIds.has(sessionId) || sessions.get(sessionId) !== session) return;
        const videoRecordingId = handoff._tag === "candidate" && handoff.candidate.artifact.kind === "browser-video"
          ? handoff.candidate.artifact.id
          : handoff._tag === "invalid" && handoff.media === "video"
            ? handoff.recordingId ?? activeBrowserRecordings.get(sessionId)?.recordingId
            : undefined;
        const discardRejectedVideo = async (recordingId: string): Promise<boolean> => {
          try {
            await discardRuntimeBrowserVideo(config.stateDir, sessionId, runtimeId, recordingId);
            return true;
          } catch {
            return false;
          }
        };
        if (videoRecordingId && hasTerminalBrowserRecordingEvent(session, videoRecordingId)) {
          await discardRejectedVideo(videoRecordingId);
          return;
        }
        if (videoRecordingId) {
          const active = activeBrowserRecordings.get(sessionId);
          if (active?.runtimeId !== runtimeId || active.recordingId !== videoRecordingId) {
            const discarded = await discardRejectedVideo(videoRecordingId);
            if (hasTerminalBrowserRecordingEvent(session, videoRecordingId)) return;
            appendEvent(session, "browser_artifact_failed", {
              recordingId: videoRecordingId,
              message: discarded
                ? "Browser video could not be published: no matching active recording"
                : "Browser video could not be published and its staged output could not be removed",
            }, true);
            return;
          }
        }
        if (handoff._tag === "invalid") {
          const discarded = !videoRecordingId || await discardRejectedVideo(videoRecordingId);
          if (handoff.media === "video") activeBrowserRecordings.delete(sessionId);
          if (videoRecordingId && hasTerminalBrowserRecordingEvent(session, videoRecordingId)) return;
          appendEvent(session, "browser_artifact_failed", {
            message: discarded
              ? `Browser ${handoff.media} could not be published: artifact descriptor is invalid`
              : "Browser video descriptor is invalid and its staged output could not be removed",
            ...(videoRecordingId ? { recordingId: videoRecordingId } : {}),
          }, true);
          return;
        }
        try {
          const artifact: SessionArtifact = await adoptBrowserArtifact(config.stateDir, sessionId, runtimeId, handoff.candidate, config.browserFfprobePath ?? "ffprobe");
          if (removingSessionIds.has(sessionId) || sessions.get(sessionId) !== session) return;
          if (artifact.kind === "browser-video") activeBrowserRecordings.delete(sessionId);
          if (!hasTerminalBrowserRecordingEvent(session, artifact.id)) appendEvent(session, "browser_artifact_created", { artifact }, true);
        } catch (cause) {
          if (removingSessionIds.has(sessionId) || sessions.get(sessionId) !== session) return;
          if (handoff._tag === "candidate" && handoff.candidate.artifact.kind === "browser-video") activeBrowserRecordings.delete(sessionId);
          const raw = cause instanceof Error ? cause.message : "artifact validation failed";
          const media = handoff._tag === "candidate" && handoff.candidate.artifact.kind === "browser-video" ? "video" : "screenshot";
          const message = raw.includes("/") ? `Browser ${media} artifact validation failed` : `Browser ${media} could not be published: ${raw}`;
          const recordingId = handoff._tag === "candidate" ? handoff.candidate.artifact.id : videoRecordingId;
          if (!recordingId || !hasTerminalBrowserRecordingEvent(session, recordingId)) appendEvent(session, "browser_artifact_failed", { message, ...(recordingId ? { recordingId } : {}) }, true);
        }
      });
      const settled = next.catch((cause) => console.error(`Browser artifact handoff failed for session ${sessionId}`, cause));
      artifactAdoptionTails.set(sessionId, settled);
      void settled.finally(() => { if (artifactAdoptionTails.get(sessionId) === settled) artifactAdoptionTails.delete(sessionId); });
    };

    const recordBrowserLifecycle = (session: MutableOwnedSession, lifecycle: BrowserRecordingLifecycle, message: RpcMessage): void => {
      const sessionId = session.snapshot.id;
      const runtimeId = session.snapshot.runtimeId;
      if (!lifecycle) {
        if (message.type === "tool_execution_end" && message.toolName === "piss_browser_video_stop" && message.isError === true) {
          const active = activeBrowserRecordings.get(sessionId);
          if (active?.runtimeId === runtimeId && !hasTerminalBrowserRecordingEvent(session, active.recordingId)) {
            activeBrowserRecordings.delete(sessionId);
            appendEvent(session, "browser_artifact_failed", {
              recordingId: active.recordingId,
              message: "Browser recording finalization failed; start a new recording after addressing the tool error",
            }, true);
          }
        }
        return;
      }
      const active = activeBrowserRecordings.get(sessionId);
      if (lifecycle.state === "started") {
        if (hasTerminalBrowserRecordingEvent(session, lifecycle.recordingId) || active?.recordingId === lifecycle.recordingId) return;
        if (active?.runtimeId === runtimeId) return;
        activeBrowserRecordings.set(sessionId, { runtimeId, recordingId: lifecycle.recordingId });
        appendEvent(session, "browser_recording_started", { recordingId: lifecycle.recordingId }, true);
      } else if (lifecycle.state === "interrupted" && active?.runtimeId === runtimeId && active.recordingId === lifecycle.recordingId) {
        activeBrowserRecordings.delete(sessionId);
        if (!hasTerminalBrowserRecordingEvent(session, lifecycle.recordingId)) {
          appendEvent(session, "browser_artifact_failed", { recordingId: lifecycle.recordingId, message: lifecycle.message ?? "Browser recording was interrupted before publication" }, true);
        }
      }
      // A finalized lifecycle leaves the matching active entry in place until
      // the queued descriptor is validated and atomically adopted.
    };

    const failPending = (session: MutableOwnedSession, message: string, cause?: unknown, command?: string): void => {
      for (const [id, pending] of session.pending) {
        if (command && pending.command !== command) continue;
        clearTimeout(pending.timer);
        pending.resume(Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message, cause })));
        session.pending.delete(id);
      }
    };

    const crash = (session: MutableOwnedSession, error: string, cause?: unknown): void => {
      if (MONOTONIC_STATUSES.has(session.snapshot.status)) return;
      session.resumeAfterRestart = false;
      session.resumeRunAfterRestart = false;
      session.quarantined = true;
      for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
      session.interactiveTimers.clear();
      const pendingInteractive = session.snapshot.interactiveRequests.length;
      session.snapshot = {
        ...session.snapshot,
        status: "crashed",
        interactiveRequests: [],
        lastActivityAt: now(),
        error: pendingInteractive > 0 ? `${error}. ${pendingInteractive} interactive request${pendingInteractive === 1 ? " was" : "s were"} cancelled` : error,
      };
      failPending(session, error, cause);
      notifyAttention(session);
      void Effect.runPromise(persist()).catch((persistCause) => console.error("Could not persist crashed owned session", persistCause));
    };

    const writeInteractiveResponse = (session: MutableOwnedSession, response: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
      const child = session.child;
      if (!child || child.stdin.destroyed || !child.stdin.writable) return reject(new Error("Pi RPC runtime is not writable"));
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`, (cause) => cause ? reject(cause) : resolve());
    });

    const queueInteractiveRequest = (session: MutableOwnedSession, message: RpcMessage): void => {
      const blockingMethod = message.method === "select" || message.method === "confirm" || message.method === "input" || message.method === "editor";
      if (!blockingMethod) return;
      let request = interactiveRequest(message);
      const workflow = session.snapshot.workflow;
      const correlationId = request?.method === "confirm" ? workflowAuthorityCorrelationId(request.title) : undefined;
      const authority = correlationId ? session.pendingWorkflowAuthority.get(correlationId) : undefined;
      const correlatedAuthority = request?.method === "confirm" && authority && request.title === authority.expectedRequestTitle ? authority : undefined;
      const resolvedAuthority = correlationId ? session.resolvedWorkflowAuthority.get(correlationId) : undefined;
      if (request && resolvedAuthority && request.title === resolvedAuthority.expectedRequestTitle) {
        request = { ...request, title: resolvedAuthority.displayTitle };
        if (!resolvedAuthority.durable) {
          resolvedAuthority.waitingRequestIds.push(request.id);
          return;
        }
        void writeInteractiveResponse(session, { id: request.id, confirmed: resolvedAuthority.confirmed }).catch(
          (cause) => crash(session, "Could not replay resolved workflow authority", cause),
        );
        return;
      }
      if (request && correlatedAuthority) request = { ...request, title: correlatedAuthority.displayTitle };
      const priorAllowedDecision = correlatedAuthority && workflow?.authorityDecisions?.find((decision) => decision.allowed
        && decision.source === "piss_workflow_authority_request"
        && decision.phaseRunId === correlatedAuthority.phaseRunId
        && decision.planRevision === correlatedAuthority.planRevision
        && decision.runtimeId === correlatedAuthority.runtimeId
        && decision.operationId === correlatedAuthority.operationId
        && decision.kind === correlatedAuthority.kind
        && decision.target === correlatedAuthority.target
        && JSON.stringify(decision.constraints ?? []) === JSON.stringify(correlatedAuthority.constraints)
        && decision.idempotencyKey === correlatedAuthority.idempotencyKey);
      if (request && request.method === "confirm" && workflow && correlatedAuthority && priorAllowedDecision && canAutomaticallyAuthorize(workflow, correlatedAuthority)) {
        session.pendingWorkflowAuthority.delete(correlatedAuthority.toolCallId);
        session.resolvedWorkflowAuthority.set(correlatedAuthority.toolCallId, {
          expectedRequestTitle: correlatedAuthority.expectedRequestTitle,
          displayTitle: correlatedAuthority.displayTitle,
          confirmed: true,
          durable: false,
          waitingRequestIds: [request.id],
        });
        while (session.resolvedWorkflowAuthority.size > 200) {
          const oldest = session.resolvedWorkflowAuthority.keys().next().value;
          if (typeof oldest !== "string") break;
          session.resolvedWorkflowAuthority.delete(oldest);
        }
        void Effect.runPromise(persist()).then(async () => {
          const resolved = session.resolvedWorkflowAuthority.get(correlatedAuthority.toolCallId);
          if (!resolved) return;
          session.resolvedWorkflowAuthority.set(correlatedAuthority.toolCallId, { ...resolved, durable: true, waitingRequestIds: [] });
          const latest = session.snapshot.workflow;
          const stillAllowed = latest?.id === workflow.id
            && !workflowCancelIntentMatches(session, latest)
            && canAutomaticallyAuthorize(latest, correlatedAuthority);
          for (const requestId of new Set(resolved.waitingRequestIds)) {
            await writeInteractiveResponse(session, stillAllowed ? { id: requestId, confirmed: true } : { id: requestId, cancelled: true });
          }
        }).catch((cause) => crash(session, "Could not replay durable approved workflow authority", cause));
        return;
      }
      if (request && request.method === "confirm" && workflow && correlatedAuthority
        && workflowCanRecordEvent(workflow, `authority:${correlatedAuthority.toolCallId}`)
        && canAutomaticallyAuthorize(workflow, correlatedAuthority)) {
        session.pendingWorkflowAuthority.delete(correlatedAuthority.toolCallId);
        session.resolvedWorkflowAuthority.set(correlatedAuthority.toolCallId, {
          expectedRequestTitle: correlatedAuthority.expectedRequestTitle,
          displayTitle: correlatedAuthority.displayTitle,
          confirmed: true,
          durable: false,
          waitingRequestIds: [request.id],
        });
        while (session.resolvedWorkflowAuthority.size > 200) {
          const oldest = session.resolvedWorkflowAuthority.keys().next().value;
          if (typeof oldest !== "string") break;
          session.resolvedWorkflowAuthority.delete(oldest);
        }
        const decidedAt = now();
        const decision = {
          eventId: `authority:${correlatedAuthority.toolCallId}`,
          operationId: correlatedAuthority.operationId,
          phaseRunId: correlatedAuthority.phaseRunId,
          planRevision: correlatedAuthority.planRevision,
          allowed: true,
          basis: `Operation ${correlatedAuthority.operationId} exactly matches approved plan revision ${correlatedAuthority.planRevision}`,
          decidedAt,
          source: "piss_workflow_authority_request" as const,
          correlationId: correlatedAuthority.toolCallId,
          runtimeId: correlatedAuthority.runtimeId,
          kind: correlatedAuthority.kind,
          target: correlatedAuthority.target,
          constraints: correlatedAuthority.constraints,
          ...(correlatedAuthority.idempotencyKey ? { idempotencyKey: correlatedAuthority.idempotencyKey } : {}),
        };
        session.snapshot = {
          ...session.snapshot,
          workflow: recordAuthorityDecision(workflow, decision),
          lastActivityAt: decidedAt,
        };
        appendEvent(session, "workflow_authority_decision", { workflowId: workflow.id, ...decision }, true);
        void Effect.runPromise(persist()).then(async () => {
          const resolved = session.resolvedWorkflowAuthority.get(correlatedAuthority.toolCallId);
          if (!resolved) return;
          session.resolvedWorkflowAuthority.set(correlatedAuthority.toolCallId, { ...resolved, durable: true, waitingRequestIds: [] });
          const latest = session.snapshot.workflow;
          const stillAllowed = latest?.id === workflow.id
            && !workflowCancelIntentMatches(session, latest)
            && canAutomaticallyAuthorize(latest, correlatedAuthority)
            && latest.authorityDecisions?.some((item) => item.eventId === decision.eventId && item.allowed) === true;
          for (const requestId of new Set(resolved.waitingRequestIds)) {
            await writeInteractiveResponse(session, stillAllowed ? { id: requestId, confirmed: true } : { id: requestId, cancelled: true });
          }
        }).catch((cause) => crash(session, "Could not durably apply approved workflow authority", cause));
        return;
      }
      if (request && request.method === "confirm" && workflow && correlatedAuthority) {
        session.pendingWorkflowAuthority.delete(correlatedAuthority.toolCallId);
        const decidedAt = now();
        const decision = {
          eventId: `authority:${correlatedAuthority.toolCallId}`,
          operationId: correlatedAuthority.operationId,
          phaseRunId: correlatedAuthority.phaseRunId,
          planRevision: correlatedAuthority.planRevision,
          allowed: false,
          basis: `Operation ${correlatedAuthority.operationId} did not exactly match the approved autonomy envelope`,
          decidedAt,
          source: "piss_workflow_authority_request" as const,
          correlationId: correlatedAuthority.toolCallId,
          runtimeId: correlatedAuthority.runtimeId,
          kind: correlatedAuthority.kind,
          target: correlatedAuthority.target,
          constraints: correlatedAuthority.constraints,
          ...(correlatedAuthority.idempotencyKey ? { idempotencyKey: correlatedAuthority.idempotencyKey } : {}),
        };
        session.snapshot = {
          ...session.snapshot,
          workflow: recordAuthorityDecision(workflow, decision),
          lastActivityAt: decidedAt,
        };
        appendEvent(session, "workflow_authority_decision", { workflowId: workflow.id, ...decision }, true);
      }
      const duplicate = request && session.snapshot.interactiveRequests.some((candidate) => candidate.id === request.id);
      if (!request || duplicate || session.snapshot.interactiveRequests.length >= 8) {
        session.snapshot = {
          ...session.snapshot,
          error: !request ? "Pi emitted an invalid interactive request" : duplicate ? "Pi repeated an interactive request ID" : "Pi interactive request queue is full",
          lastActivityAt: now(),
        };
        if (typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128) {
          void writeInteractiveResponse(session, { id: message.id, cancelled: true }).catch((cause) => crash(session, "Could not reject an invalid Pi interactive request", cause));
        }
        void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist interactive request rejection", cause));
        return;
      }
      const previousStatus = session.snapshot.status;
      session.snapshot = {
        ...session.snapshot,
        status: transitionAttentionState(previousStatus, "interactiveRequest"),
        interactiveRequests: [...session.snapshot.interactiveRequests, request],
        lastActivityAt: request.receivedAt,
      };
      if (session.snapshot.status !== previousStatus) notifyAttention(session);
      if (request.timeout) {
        const timer = setTimeout(() => {
          session.interactiveTimers.delete(request.id);
          if (!session.snapshot.interactiveRequests.some((candidate) => candidate.id === request.id)) return;
          const interactiveRequests = session.snapshot.interactiveRequests.filter((candidate) => candidate.id !== request.id);
          session.snapshot = {
            ...session.snapshot,
            interactiveRequests,
            status: interactiveRequests.length > 0 ? "blocked" : transitionAttentionState(session.snapshot.status, "interactiveResolved"),
            lastActivityAt: now(),
            error: "A Pi interactive request timed out before it was answered",
          };
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist interactive request timeout", cause));
        }, request.timeout + 100);
        timer.unref();
        session.interactiveTimers.set(request.id, timer);
      }
      void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist interactive request", cause));
    };

    const finishPending = (session: MutableOwnedSession, message: RpcMessage): void => {
      if (message.type !== "response" || typeof message.id !== "string") return;
      const pending = session.pending.get(message.id);
      if (!pending || message.command !== pending.command) return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success === true) {
        pending.resume(Effect.succeed(message));
      } else {
        const detail = typeof message.error === "string" ? message.error : `Pi rejected ${pending.command}`;
        pending.resume(Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: detail })));
      }
    };

    const handleLine = (session: MutableOwnedSession, line: string, runtimeGeneration = session.snapshot.runtimeId): boolean => {
      if (session.quarantined || session.snapshot.runtimeId !== runtimeGeneration) return false;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        crash(session, "Pi emitted invalid JSON", cause);
        void beginTermination(session);
        return false;
      }
      if (!isRpcMessage(message)) {
        crash(session, "Pi emitted a JSON value without a message type");
        void beginTermination(session);
        return false;
      }
      finishPending(session, message);
      if (message.type === "response") return true;
      const processEvent = (): boolean => {
      if (session.quarantined || session.snapshot.runtimeId !== runtimeGeneration) return false;
      const authorityRequest = workflowAuthorityRequestFromRpc(message);
      if (authorityRequest) session.pendingWorkflowAuthority.set(authorityRequest.toolCallId, authorityRequest);
      if (message.type === "extension_ui_request") queueInteractiveRequest(session, message);
      if (message.type === "tool_execution_end" && typeof message.toolCallId === "string") session.pendingWorkflowAuthority.delete(message.toolCallId);
      if (message.type === "queue_update") {
        const steering = Array.isArray(message.steering) ? message.steering.length : 0;
        const followUp = Array.isArray(message.followUp) ? message.followUp.length : 0;
        session.snapshot = { ...session.snapshot, pendingMessageCount: Math.min(steering + followUp, 10_000), lastActivityAt: now() };
      }
      if (message.type === "auto_retry_start") {
        const workflow = session.snapshot.workflow;
        const attempt = nonNegativeInteger(message.attempt) ?? 1;
        const reportedMaximum = nonNegativeInteger(message.maxAttempts) ?? WORKFLOW_TRANSIENT_RETRY_LIMIT;
        const maximum = Math.min(reportedMaximum, 100);
        if (workflow && isAutonomousWorkflowPhase(workflow.phase)) {
          const receivedAt = now();
          const event: WorkflowProgressEvent = {
            eventId: `auto-retry:${workflow.phaseRun?.id ?? session.sequence}:${attempt}`,
            ...(workflow.phaseRun ? { phaseRunId: workflow.phaseRun.id, planRevision: workflow.phaseRun.planRevision, runtimeId: runtimeGeneration } : {}),
            activity: `Retrying a transient provider or infrastructure failure (${attempt} of ${maximum})`,
            condition: "retrying",
            nextAction: "Wait for the bounded automatic retry",
            retryAttempt: attempt,
            maxTransientRetries: WORKFLOW_TRANSIENT_RETRY_LIMIT,
            receivedAt,
          };
          const updated = applyWorkflowProgress(workflow, event);
          session.snapshot = { ...session.snapshot, workflow: updated, lastActivityAt: receivedAt };
          appendEvent(session, "workflow_progress_recorded", { workflowId: workflow.id, event }, true);
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist workflow retry progress", cause));
        }
      }
      if (message.type === "auto_retry_end") {
        const workflow = session.snapshot.workflow;
        if (workflow && isAutonomousWorkflowPhase(workflow.phase)) {
          const receivedAt = now();
          const success = message.success === true;
          const event: WorkflowProgressEvent = {
            eventId: `auto-retry-end:${workflow.phaseRun?.id ?? session.sequence}:${String(message.attempt ?? 0)}`,
            ...(workflow.phaseRun ? { phaseRunId: workflow.phaseRun.id, planRevision: workflow.phaseRun.planRevision, runtimeId: runtimeGeneration } : {}),
            activity: success ? "Transient failure recovered automatically" : "Automatic transient retry budget was exhausted",
            condition: success ? "working" : "waiting_internal",
            nextAction: success ? "Continue the current phase" : "Ask the read-only supervisor to adjudicate recovery",
            retryAttempt: nonNegativeInteger(message.attempt) ?? workflow.progress?.retryAttempt ?? 0,
            receivedAt,
          };
          const updated = applyWorkflowProgress(workflow, event);
          session.snapshot = { ...session.snapshot, workflow: updated, lastActivityAt: receivedAt };
          appendEvent(session, "workflow_progress_recorded", { workflowId: workflow.id, event }, true);
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist workflow retry result", cause));
        }
      }
      if (message.type === "compaction_start") {
        session.snapshot = {
          ...session.snapshot,
          // A provider overflow is an intermediate failure while Pi compacts and
          // retries, not a terminal runtime error.
          error: message.reason === "overflow" ? null : session.snapshot.error,
          compaction: { status: "running", reason: typeof message.reason === "string" ? message.reason.slice(0, 64) : null, tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: now() },
        };
        void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist compaction start", cause));
      }
      if (message.type === "compaction_end") {
        const result = typeof message.result === "object" && message.result !== null && !Array.isArray(message.result) ? message.result as Record<string, unknown> : undefined;
        const failed = message.aborted === true || !result;
        const compactionError = failed
          ? typeof message.errorMessage === "string"
            ? boundedText(message.errorMessage, MAX_STDERR_BYTES)
            : message.aborted === true
              ? "Compaction was cancelled"
              : "Compaction failed"
          : null;
        session.snapshot = {
          ...session.snapshot,
          error: failed && message.reason === "overflow" ? compactionError : session.snapshot.error,
          compaction: {
            status: failed ? "failed" : "succeeded",
            reason: typeof message.reason === "string" ? message.reason.slice(0, 64) : session.snapshot.compaction.reason,
            tokensBefore: nonNegativeInteger(result?.tokensBefore) ?? null,
            estimatedTokensAfter: nonNegativeInteger(result?.estimatedTokensAfter) ?? null,
            error: compactionError,
            updatedAt: now(),
          },
        };
        void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist compaction result", cause));
      }
      if (message.type === "message_end" && typeof message.message === "object" && message.message !== null) {
        const completed = message.message as Record<string, unknown>;
        if (completed.stopReason === "error") {
          session.snapshot = {
            ...session.snapshot,
            error: typeof completed.errorMessage === "string"
              ? boundedText(completed.errorMessage, MAX_STDERR_BYTES)
              : "Pi assistant response failed",
          };
        } else if (completed.role === "assistant") {
          session.snapshot = { ...session.snapshot, error: null };
        }
      }
      const reportedAdvice = workflowSupervisorAdviceFromRpc(message);
      const reportedProgress = workflowProgressFromRpc(message, session.sequence + 1, runtimeGeneration);
      if (reportedProgress && !workflowCancelIntentMatches(session) && session.snapshot.workflow?.id === reportedProgress.workflowId) {
        const workflow = applyWorkflowProgress(session.snapshot.workflow, reportedProgress.event);
        if (workflow !== session.snapshot.workflow) {
          session.snapshot = { ...session.snapshot, workflow, lastActivityAt: workflow.updatedAt };
          appendEvent(session, "workflow_progress_recorded", { workflowId: workflow.id, event: reportedProgress.event }, true);
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist engineering workflow progress", cause));
        }
      }
      const reportedDraft = workflowDraftFromRpc(message);
      if (reportedDraft && session.snapshot.workflow?.id === reportedDraft.workflowId) {
        const workflow = applyWorkflowDraftReport(session.snapshot.workflow, reportedDraft);
        if (workflow !== session.snapshot.workflow) {
          session.snapshot = { ...session.snapshot, workflow, lastActivityAt: workflow.updatedAt };
          appendEvent(session, "workflow_draft_recorded", { workflowId: workflow.id, report: reportedDraft }, true);
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist engineering workflow draft", cause));
        }
      }
      let supervisorConsultationRequested = false;
      const reportedCheckpoint = workflowCheckpointFromRpc(message, session.sequence + 1);
      if (reportedCheckpoint && !workflowCancelIntentMatches(session) && session.snapshot.workflow?.id === reportedCheckpoint.workflowId && !isTerminalWorkflowPhase(session.snapshot.workflow.phase)) {
        const previousWorkflow = session.snapshot.workflow;
        const previousPhase = previousWorkflow.phase;
        const checkpoint = reportedCheckpoint.checkpoint;
        const workflow = applyWorkflowCheckpoint(previousWorkflow, checkpoint);
        if (workflow !== previousWorkflow
          && isAutonomousWorkflowPhase(previousPhase)
          && workflow.phase === "blocked") {
          // A checkpoint can be rejected by a control-plane completion or
          // receipt invariant even when the worker reported `passed`. Give the
          // read-only supervisor the exact blocker instead of silently
          // consuming implementation-repair budget.
          supervisorConsultationRequested = true;
        }
        const queuedIntervention = workflow.phase === "readyToShip" || workflow.phase === "failed" ? workflow.queuedIntervention : undefined;
        if (workflow !== previousWorkflow) session.workflowDispatchPending = workflow.phase !== previousPhase && (isAutonomousWorkflowPhase(workflow.phase) || workflow.phase === "planning");
        if (workflow !== previousWorkflow) {
          session.snapshot = { ...session.snapshot, workflow, lastActivityAt: workflow.updatedAt };
          appendEvent(session, "workflow_checkpoint_recorded", { workflowId: workflow.id, checkpoint }, true);
          void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist engineering workflow checkpoint", cause));
        }
        if (queuedIntervention) {
          void Effect.runPromise(request(session, {
            id: `workflow:${workflow.id}:queued-intervention:${randomUUID()}`,
            type: "follow_up",
            message: queuedIntervention,
          }).pipe(
            Effect.andThen(Effect.sync(() => {
              const current = session.snapshot.workflow;
              if (current?.id !== workflow.id || current.queuedIntervention !== queuedIntervention) return;
              session.snapshot = {
                ...session.snapshot,
                workflow: { ...current, queuedIntervention: undefined, updatedAt: now() },
                lastActivityAt: now(),
              };
            })),
            Effect.andThen(persist()),
          )).catch((cause) => {
            const current = session.snapshot.workflow;
            if (current?.id === workflow.id && (current.phase === "readyToShip" || current.phase === "failed")) {
              const updatedAt = now();
              const deliveryError = `The queued user follow-up could not be delivered: ${cause instanceof Error ? cause.message : "unknown error"}`;
              session.snapshot = {
                ...session.snapshot,
                workflow: current.phase === "readyToShip"
                  ? { ...current, phase: "blocked", blockedFromPhase: "reviewing", queuedIntervention, updatedAt, error: deliveryError }
                  : { ...current, queuedIntervention, updatedAt, error: `${current.error ?? "The workflow failed"}\n${deliveryError}` },
                lastActivityAt: updatedAt,
              };
              void Effect.runPromise(persist()).catch((persistCause) => console.error("Could not persist blocked workflow follow-up", persistCause));
            }
          });
        }
      }
      if (message.type === "agent_settled"
        && session.snapshot.status === "working"
        && session.snapshot.error === null
        && !session.finalResponseRecoveryAttempted
        && !session.snapshot.workflow
        && !reportedCheckpoint
        && runEndedAfterToolsWithoutFinalResponse(session.snapshot.events)) {
        session.finalResponseRecoveryAttempted = true;
        // TODO(tracer): Reconcile by durable transcript entry ID once live RPC
        // message events expose that cursor; the one-shot recovery avoids loops.
        void Effect.runPromise(request(session, {
          id: `${session.snapshot.id}:recover-final-response:${session.snapshot.runtimeId}`,
          type: "prompt",
          message: MISSING_FINAL_RESPONSE_CONTINUATION,
        })).catch((cause) => {
          crash(session, "Pi settled after tool execution without a final response", cause);
          void beginTermination(session);
        });
        return true;
      }
      if (message.type === "agent_settled" && !reportedCheckpoint && !session.workflowDispatchPending) {
        const current = session.snapshot.workflow;
        const stage = current && isAutonomousWorkflowPhase(current.phase) ? expectedCheckpointStage(current.phase) : undefined;
        if (current && stage) {
          const receivedAt = now();
          const checkpoint: EngineeringWorkflowCheckpoint = {
            stage,
            outcome: "blocked",
            summary: "The worker settled without completing its required phase checkpoint. The supervisor is determining whether this is an approved internal gate, a transient failure, or a genuine human blocker.",
            artifact: null,
            toolCallId: `settled-without-checkpoint:${session.sequence + 1}`,
            sequence: session.sequence + 1,
            receivedAt,
            eventId: `settled-without-checkpoint:${current.phaseRun?.id ?? session.sequence + 1}`,
            ...(current.phaseRun ? { phaseRunId: current.phaseRun.id, planRevision: current.phaseRun.planRevision, runtimeId: runtimeGeneration } : {}),
          };
          const workflow = applyWorkflowCheckpoint(current, checkpoint);
          if (workflow !== current) {
            session.snapshot = { ...session.snapshot, workflow, lastActivityAt: receivedAt };
            supervisorConsultationRequested = true;
            void Effect.runPromise(persist()).catch((cause) => console.error("Could not persist internally waiting workflow", cause));
          }
        }
      }
      let artifactHandoff = browserArtifactHandoffFromRpc(message);
      const recordingLifecycle = browserRecordingLifecycleFromRpc(message);
      if (message.toolName === "piss_browser_video_stop" && artifactHandoff._tag !== "none" && recordingLifecycle?.state !== "finalized") {
        const recordingId = artifactHandoff._tag === "candidate" && artifactHandoff.candidate.artifact.kind === "browser-video"
          ? artifactHandoff.candidate.artifact.id
          : artifactHandoff._tag === "invalid" ? artifactHandoff.recordingId : undefined;
        artifactHandoff = { _tag: "invalid", media: "video", ...(recordingId ? { recordingId } : {}) };
      }
      appendEvent(session, message.type, message);
      recordBrowserLifecycle(session, recordingLifecycle, message);
      if (artifactHandoff._tag !== "none") queueBrowserArtifactHandoff(session, artifactHandoff);
      if (supervisorConsultationRequested) {
        void Effect.runPromise(session.mutationLock.withPermit(consultWorkflowSupervisor(session))).catch((cause) => {
          const workflow = session.snapshot.workflow;
          if (workflow?.phase === "blocked" && workflow.supervisor?.status === "consulting") {
            const updatedAt = now();
            session.snapshot = {
              ...session.snapshot,
              workflow: {
                ...workflow,
                supervisor: { ...workflow.supervisor, status: "idle" },
                updatedAt,
                error: `${workflow.error ?? "The workflow is blocked"}\nSupervisor consultation failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
              },
              lastActivityAt: updatedAt,
            };
            void Effect.runPromise(persist()).catch((persistCause) => console.error("Could not persist failed supervisor consultation", persistCause));
          }
        });
      }
      if (reportedAdvice) {
        void Effect.runPromise(applyWorkflowSupervisorAdvice(session, reportedAdvice)).catch((cause) => console.error("Could not apply workflow supervisor advice", cause));
      }
      if (message.type === "agent_settled" && session.workflowDispatchPending) continueWorkflowAfterSettle(session);
      return true;
      };
      const workflowToolNames = new Set(["piss_workflow_checkpoint", "piss_workflow_progress", "piss_workflow_draft", "piss_workflow_authority_request", "piss_workflow_supervisor_advice"]);
      const serializedWorkflowEvent = Boolean(session.snapshot.workflow) && (
        message.type === "agent_settled"
        || message.type === "auto_retry_start"
        || message.type === "auto_retry_end"
        || typeof message.toolName === "string" && workflowToolNames.has(message.toolName)
        || message.type === "extension_ui_request" && (message.method === "select" || message.method === "confirm" || message.method === "input" || message.method === "editor")
      );
      if (!serializedWorkflowEvent) return processEvent();
      session.workflowEventTail = session.workflowEventTail.then(async () => {
        await Effect.runPromise(session.mutationLock.withPermit(Effect.sync(processEvent)));
      }).catch((cause) => {
        crash(session, "Could not apply serialized Pi RPC event", cause);
        void beginTermination(session);
      });
      return true;
    };

    const attach = (session: MutableOwnedSession): void => {
      const child = session.child;
      if (!child) return;
      const runtimeId = session.snapshot.runtimeId;
      const framer = new JsonlFramer();
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const line of framer.push(chunk)) {
            if (!handleLine(session, line, runtimeId)) break;
          }
        } catch (cause) {
          crash(session, cause instanceof Error ? cause.message : "Pi RPC framing failed", cause);
          void beginTermination(session);
        }
      });
      child.stdout.on("end", () => {
        if (session.quarantined) return;
        try {
          for (const line of framer.end()) {
            if (!handleLine(session, line, runtimeId)) break;
          }
        } catch (cause) {
          crash(session, cause instanceof Error ? cause.message : "Pi RPC framing failed", cause);
          void beginTermination(session);
        }
      });
      child.stdin.on("error", (cause) => {
        crash(session, `Pi RPC stdin failed: ${cause.message}`, cause);
        void beginTermination(session);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        session.stderr = `${session.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      });
      child.once("close", (code, signal) => {
        const activeRecording = activeBrowserRecordings.get(session.snapshot.id);
        if (activeRecording?.runtimeId === runtimeId) {
          activeBrowserRecordings.delete(session.snapshot.id);
          appendEvent(session, "browser_artifact_failed", {
            recordingId: activeRecording.recordingId,
            message: "Browser recording was interrupted because its runtime exited before publication",
          }, true);
        }
        const adoptionTail = artifactAdoptionTails.get(session.snapshot.id) ?? Promise.resolve();
        void adoptionTail.then(() => removeRuntimeArtifactStaging(config.stateDir, session.snapshot.id, runtimeId)).catch(() => undefined);
        if (session.snapshot.status === "stopped" || session.snapshot.status === "stopping") return;
        const detail = session.stderr.trim() || `Pi exited with code ${code ?? "none"} and signal ${signal ?? "none"}`;
        if (session.snapshot.status === "crashed" && session.stderr.trim() && session.snapshot.error?.includes("EPIPE")) {
          session.snapshot = {
            ...session.snapshot,
            error: `${detail}\n(${session.snapshot.error})`,
            lastActivityAt: now(),
          };
          return;
        }
        crash(session, detail);
      });
      child.once("error", (cause) => {
        crash(session, cause.message, cause);
        void beginTermination(session);
      });
    };

    const request = (
      session: MutableOwnedSession,
      command: Record<string, unknown> & { readonly type: string },
    ): Effect.Effect<RpcMessage, PiCommandError> => {
      const id = typeof command.id === "string" ? command.id : randomUUID();
      const framed = { ...command, id };
      return Effect.callback<RpcMessage, PiCommandError>((resume, signal) => {
        const child = session.child;
        if (!child || child.stdin.destroyed || !child.stdin.writable || MONOTONIC_STATUSES.has(session.snapshot.status)) {
          resume(Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Pi RPC runtime is not writable" })));
          return;
        }
        if (session.pending.size >= MAX_PENDING_COMMANDS) {
          resume(Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Pi RPC command queue is full" })));
          return;
        }
        const timeout = command.type === "compact" || command.type === "prompt"
          // Pi acknowledges prompts only after preflight, which may run automatic compaction.
          ? LONG_RUNNING_COMMAND_TIMEOUT_MS
          : command.type === "get_entries"
            ? SESSION_REPLAY_TIMEOUT_MS
            : Array.isArray(command.images) && command.images.length > 0
              ? IMAGE_COMMAND_TIMEOUT_MS
              : COMMAND_TIMEOUT_MS;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          const error = new PiCommandError({ sessionId: session.snapshot.id, message: `Pi did not acknowledge ${command.type}` });
          resume(Effect.fail(error));
          crash(session, error.message, error);
          void beginTermination(session);
        }, timeout);
        const cleanup = () => {
          const pending = session.pending.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            session.pending.delete(id);
          }
        };
        session.pending.set(id, { command: command.type, resume, timer });
        child.stdin.write(`${JSON.stringify(framed)}\n`, (cause) => {
          if (!cause) return;
          cleanup();
          const error = new PiCommandError({ sessionId: session.snapshot.id, message: cause.message, cause });
          resume(Effect.fail(error));
          crash(session, error.message, cause);
          void beginTermination(session);
        });
        signal.addEventListener("abort", cleanup, { once: true });
        return Effect.sync(cleanup);
      });
    };

    const dispatchWorkflowPhase = (
      session: MutableOwnedSession,
      feedback?: string,
      queueBehindActiveRun = false,
    ): Effect.Effect<void, PiCommandError | SessionStorageError> => Effect.gen(function* () {
      const workflow = session.snapshot.workflow;
      if (!workflow || (!isAutonomousWorkflowPhase(workflow.phase) && workflow.phase !== "defining" && workflow.phase !== "planning")) {
        return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "This workflow phase cannot start an agent run" }));
      }
      const commandType = queueBehindActiveRun && session.snapshot.status === "working" ? "follow_up" as const : "prompt" as const;
      const unappliedGuidance = (workflow.guidance ?? []).filter((item) => item.status !== "applied" && workflowGuidanceAppliesToCurrentPhase(workflow, item));
      const queuedGuidance = unappliedGuidance.filter((item) => item.status === "queued");
      const legacyGuidance = workflow.queuedIntervention;
      const phaseGuidance = [feedback?.trim(), workflowGuidanceForDispatch(workflow)].filter(Boolean).join("\n\n---\n\n") || undefined;
      const startedAt = now();
      const phaseRun = {
        id: randomUUID(),
        phase: workflow.phase,
        attempt: workflow.phase === "repairing" ? workflow.repairAttempts : 0,
        planRevision: workflowPlanRevision(workflow),
        runtimeId: session.snapshot.runtimeId,
        startedAt,
      };
      const progress = workflow.progress ?? initialWorkflowProgress(startedAt, "working", workflow.dossier);
      const runningWorkflow = {
        ...workflow,
        phaseRun,
        processedEventIds: [],
        revision: workflowRevision(workflow) + 1,
        progress: {
          ...progress,
          condition: "working" as const,
          activity: workflow.phase === "defining" ? "Refining the specification" : workflow.phase === "researching" ? "Investigating the defined research questions" : workflow.phase === "planning" ? "Preparing the executable plan" : progress.activity,
          nextAction: `Complete the ${workflow.phase} phase checkpoint`,
          lastActivityAt: startedAt,
        },
        updatedAt: startedAt,
      };
      session.workflowDispatchPending = false;
      session.finalResponseRecoveryAttempted = false;
      session.snapshot = {
        ...session.snapshot,
        status: "working",
        workflow: runningWorkflow,
        error: null,
        lastActivityAt: startedAt,
      };
      yield* persist();
      yield* request(session, {
        id: `workflow:${workflow.id}:phase:${phaseRun.id}`,
        type: commandType,
        message: workflowPhasePrompt(runningWorkflow, phaseGuidance),
      });
      for (const item of queuedGuidance) session.acceptedCommandIds.add(item.commandId);
      if (queuedGuidance.length > 0 || legacyGuidance) {
        const deliveredAt = now();
        const current = session.snapshot.workflow;
        if (current?.id === workflow.id) {
          let deliveredWorkflow: EngineeringWorkflow = { ...current, queuedIntervention: undefined };
          for (const item of queuedGuidance) {
            const delivery: WorkflowGuidanceDeliveryEvent = { eventId: `guidance-delivered:${item.commandId}`, guidanceId: item.id, commandId: item.commandId, planRevision: item.planRevision, deliveredAt };
            deliveredWorkflow = recordWorkflowGuidanceDelivery(deliveredWorkflow, delivery);
            appendEvent(session, "workflow_guidance_delivery", { workflowId: workflow.id, event: delivery }, true);
          }
          session.snapshot = { ...session.snapshot, workflow: deliveredWorkflow, lastActivityAt: deliveredAt };
          yield* persist();
        }
      }
    });

    const consultWorkflowSupervisor = (worker: MutableOwnedSession): Effect.Effect<void, PiCommandError | SessionStorageError> => Effect.gen(function* () {
      const workflow = worker.snapshot.workflow;
      if (!workflow || workflow.phase !== "blocked" || !workflow.checkpoint) return;
      let supervisorState = workflow.supervisor;
      let supervisorSession = supervisorState ? sessions.get(supervisorState.sessionId) : undefined;
      if (!supervisorSession || TERMINAL_STATUSES.has(supervisorSession.snapshot.status)) {
        const created = yield* createSession({
          workspaceId: worker.snapshot.workspaceId,
          name: `Supervisor · ${worker.snapshot.name}`.slice(0, 120),
        }, true).pipe(
          Effect.map((session) => session),
          Effect.catch((cause) => Effect.sync(() => {
            console.error("Could not create engineering workflow supervisor", cause);
            return undefined;
          })),
        );
        if (!created) {
          const updatedAt = now();
          worker.snapshot = {
            ...worker.snapshot,
            workflow: { ...workflow, updatedAt, error: `${workflow.error ?? "The workflow is blocked"}\nThe dedicated supervisor could not be started.` },
            lastActivityAt: updatedAt,
          };
          yield* persist();
          return;
        }
        supervisorSession = sessions.get(created.id);
        supervisorState = {
          sessionId: created.id,
          status: "idle",
          consultations: workflow.supervisor?.consultations ?? 0,
          blockerFingerprint: workflow.supervisor?.blockerFingerprint ?? null,
          repeatedBlockerCount: workflow.supervisor?.repeatedBlockerCount ?? 0,
          pendingGuidance: null,
          lastAdvice: workflow.supervisor?.lastAdvice ?? null,
        };
      }
      if (!supervisorSession || !supervisorState) return;
      const blockerFingerprint = workflowBlockerFingerprint(workflow.checkpoint);
      const repeatedBlockerCount = supervisorState.blockerFingerprint === blockerFingerprint
        ? supervisorState.repeatedBlockerCount + 1
        : 1;
      const canConsult = repeatedBlockerCount <= MAX_SUPERVISOR_REPEATS_PER_BLOCKER;
      const updatedAt = now();
      const consultationId = canConsult ? randomUUID() : null;
      const consultationWorkflowRevision = workflowRevision(workflow) + 1;
      const updatedSupervisor = {
        ...supervisorState,
        status: canConsult ? "consulting" as const : "idle" as const,
        consultations: supervisorState.consultations + (canConsult ? 1 : 0),
        blockerFingerprint,
        repeatedBlockerCount,
        pendingGuidance: null,
        activeConsultationId: consultationId,
        consultationPhaseRunId: canConsult ? workflow.phaseRun?.id ?? null : null,
        consultationPlanRevision: workflowPlanRevision(workflow),
        consultationWorkflowRevision,
        ...(!canConsult ? {
          lastAdvice: {
            action: "human_authority_required" as const,
            problem: "The workflow could not resolve the same problem automatically and needs your decision.",
            summary: "The same blocker persisted after the bounded supervisor recovery attempts.",
            guidance: null,
            basis: "Repeated blocker fingerprint limit",
            receivedAt: updatedAt,
          },
        } : {}),
      };
      const updatedWorkflow = {
        ...workflow,
        supervisor: updatedSupervisor,
        revision: consultationWorkflowRevision,
        updatedAt,
        error: canConsult ? workflow.error : `Supervisor escalation required: ${workflow.error ?? workflow.checkpoint.summary}`,
      };
      worker.snapshot = { ...worker.snapshot, workflow: updatedWorkflow, lastActivityAt: updatedAt };
      if (!canConsult) {
        yield* persist();
        return;
      }
      appendEvent(worker, "workflow_supervisor_consulting", {
        supervisorSessionId: supervisorSession.snapshot.id,
        workflowId: workflow.id,
        blockerFingerprint,
        repeatedBlockerCount,
      }, true);
      yield* persist();
      yield* request(supervisorSession, {
        id: `workflow-supervisor:${workflow.id}:${updatedSupervisor.consultations}:${randomUUID()}`,
        type: supervisorSession.snapshot.status === "working" ? "follow_up" : "prompt",
        message: workflowSupervisorPrompt(updatedWorkflow, latestAssistantEvidence(worker.snapshot.events)),
      });
    });

    const dispatchWorkflowPhaseWithRecovery = (
      session: MutableOwnedSession,
      feedback?: string,
      queueBehindActiveRun = false,
    ): Effect.Effect<void, PiCommandError | SessionStorageError> => {
      let dispatchRetries = 0;
      const dispatchAttempt = (): Effect.Effect<void, PiCommandError | SessionStorageError> => dispatchWorkflowPhase(session, feedback, queueBehindActiveRun).pipe(
        Effect.tap(() => {
          const workflow = session.snapshot.workflow;
          if (!workflow?.phaseRun || dispatchRetries === 0) return Effect.void;
          const receivedAt = now();
          const event: WorkflowProgressEvent = {
            eventId: `dispatch-retry-recovered:${workflow.phaseRun.id}`,
            phaseRunId: workflow.phaseRun.id,
            planRevision: workflow.phaseRun.planRevision,
            runtimeId: workflow.phaseRun.runtimeId,
            activity: "Transient workflow dispatch failure recovered automatically",
            condition: "working",
            nextAction: `Complete the ${workflow.phase} phase checkpoint`,
            retryAttempt: dispatchRetries,
            maxTransientRetries: WORKFLOW_TRANSIENT_RETRY_LIMIT,
            receivedAt,
          };
          const updated = applyWorkflowProgress(workflow, event);
          session.snapshot = { ...session.snapshot, workflow: updated, lastActivityAt: receivedAt };
          appendEvent(session, "workflow_progress_recorded", { workflowId: workflow.id, event }, true);
          return persist();
        }),
        Effect.catch((cause) => {
          if (!(cause instanceof PiCommandError)) return Effect.fail(cause);
          const workflow = session.snapshot.workflow;
          if (!workflow || isTerminalWorkflowPhase(workflow.phase) || workflowCancelIntentMatches(session, workflow)) return Effect.void;
          const maximum = WORKFLOW_TRANSIENT_RETRY_LIMIT;
          if (dispatchRetries < maximum) {
            const receivedAt = now();
            dispatchRetries += 1;
            const retryAttempt = dispatchRetries;
            const event: WorkflowProgressEvent = {
              eventId: `dispatch-retry:${workflow.phaseRun?.id ?? session.sequence}:${retryAttempt}`,
              ...(workflow.phaseRun ? { phaseRunId: workflow.phaseRun.id, planRevision: workflow.phaseRun.planRevision, runtimeId: workflow.phaseRun.runtimeId } : {}),
              activity: `Retrying a transient workflow dispatch failure (${retryAttempt} of ${maximum})`,
              condition: "retrying",
              nextAction: "Retry the phase request without consuming repair budget",
              retryAttempt,
              maxTransientRetries: maximum,
              receivedAt,
            };
            const updated = applyWorkflowProgress(workflow, event);
            session.snapshot = { ...session.snapshot, workflow: updated, lastActivityAt: receivedAt };
            appendEvent(session, "workflow_progress_recorded", { workflowId: workflow.id, event }, true);
            return persist().pipe(Effect.andThen(dispatchAttempt()));
          }
          const stage = expectedCheckpointStage(workflow.phase);
          if (!stage || !workflow.phaseRun) return Effect.fail(cause);
          const receivedAt = now();
          const checkpoint: EngineeringWorkflowCheckpoint = {
            stage,
            outcome: "blocked",
            summary: `PISS could not dispatch the ${workflow.phase} worker after ${maximum} bounded retries. The read-only supervisor is determining whether local recovery can continue or human input is required.`,
            artifact: null,
            toolCallId: `dispatch-failure:${workflow.phaseRun.id}`,
            sequence: session.sequence + 1,
            receivedAt,
            eventId: `dispatch-failure:${workflow.phaseRun.id}`,
            phaseRunId: workflow.phaseRun.id,
            planRevision: workflow.phaseRun.planRevision,
            runtimeId: workflow.phaseRun.runtimeId,
          };
          const blocked = applyWorkflowCheckpoint(workflow, checkpoint);
          session.workflowDispatchPending = false;
          session.snapshot = { ...session.snapshot, status: "finished", workflow: blocked, lastActivityAt: receivedAt };
          appendEvent(session, "workflow_checkpoint_recorded", { workflowId: workflow.id, checkpoint }, true);
          return persist().pipe(Effect.andThen(consultWorkflowSupervisor(session)));
        }),
      );
      return dispatchAttempt();
    };

    const applyWorkflowSupervisorAdvice = (
      supervisorSession: MutableOwnedSession,
      reported: ReportedSupervisorAdvice,
    ): Effect.Effect<void, PiCommandError | SessionStorageError> => Effect.gen(function* () {
      const worker = [...sessions.values()].find((candidate) => {
        const workflow = candidate.snapshot.workflow;
        return workflow?.id === reported.workflowId && workflow.supervisor?.sessionId === supervisorSession.snapshot.id;
      });
      if (!worker) return;
      yield* worker.mutationLock.withPermit(Effect.gen(function* () {
        const workflow = worker.snapshot.workflow;
        const supervisorState = workflow?.supervisor;
        if (!workflow || workflow.phase !== "blocked" || !workflow.blockedFromPhase || supervisorState?.status !== "consulting") return;
        const advice = reported.advice;
        if (!advice.eventId || !advice.consultationId || !advice.phaseRunId || advice.planRevision === undefined || advice.workflowRevision === undefined || !advice.runtimeId) return;
        if (supervisorAdviceAlreadyApplied(workflow, advice.eventId)
          || advice.consultationId !== supervisorState.activeConsultationId
          || advice.phaseRunId !== supervisorState.consultationPhaseRunId
          || advice.planRevision !== supervisorState.consultationPlanRevision
          || advice.workflowRevision !== supervisorState.consultationWorkflowRevision
          || advice.runtimeId !== workflow.phaseRun?.runtimeId) return;
        const automatic = advice.action === "resume_with_guidance" || advice.action === "retry_transient" || advice.action === "enter_repair";
        const consumesRepairBudget = advice.action === "enter_repair";
        const repairEligible = workflow.blockedFromPhase === "building" || workflow.blockedFromPhase === "verifying" || workflow.blockedFromPhase === "reviewing" || workflow.blockedFromPhase === "repairing";
        const guidance = advice.guidance?.trim() || advice.summary;
        const nextRepairAttempts = consumesRepairBudget ? workflow.repairAttempts + 1 : workflow.repairAttempts;
        const canRecover = automatic
          && (!consumesRepairBudget || repairEligible && nextRepairAttempts <= workflow.maxRepairAttempts)
          && !TERMINAL_STATUSES.has(worker.snapshot.status);
        const updatedAt = now();
        const nextPhase: EngineeringWorkflowPhase = advice.action === "enter_repair" ? "repairing" : workflow.blockedFromPhase;
        const nextSupervisor = {
          ...supervisorState,
          status: "idle" as const,
          pendingGuidance: canRecover ? `[Loop supervisor — ${advice.action.toUpperCase()}]\n\n${guidance}\n\nBasis: ${advice.basis}` : null,
          lastAdvice: advice,
          activeConsultationId: null,
          consultationPhaseRunId: null,
        };
        worker.snapshot = {
          ...worker.snapshot,
          status: canRecover ? worker.snapshot.status : "finished",
          workflow: canRecover
            ? {
              ...workflow,
              phase: nextPhase,
              repairAttempts: nextRepairAttempts,
              blockedFromPhase: null,
              supervisor: nextSupervisor,
              revision: workflowRevision(workflow) + 1,
              processedEventIds: rememberSupervisorAdviceEvent(workflow, advice.eventId),
              updatedAt,
              error: null,
            }
            : {
              ...workflow,
              supervisor: nextSupervisor,
              revision: workflowRevision(workflow) + 1,
              processedEventIds: rememberSupervisorAdviceEvent(workflow, advice.eventId),
              updatedAt,
              error: automatic
                ? `Supervisor could not recover this blocker: ${advice.summary}`
                : advice.summary,
            },
          lastActivityAt: updatedAt,
        };
        appendEvent(worker, "workflow_supervisor_advice", {
          supervisorSessionId: supervisorSession.snapshot.id,
          workflowId: workflow.id,
          ...advice,
          automaticRecovery: canRecover,
        }, true);
        yield* persist();
        if (!canRecover) return;
        const workerAlreadySettled = worker.snapshot.events.at(-1)?.type === "agent_settled";
        if (worker.snapshot.status === "working" && !workerAlreadySettled) {
          worker.workflowDispatchPending = true;
          return;
        }
        const pendingGuidance = worker.snapshot.workflow?.supervisor?.pendingGuidance ?? undefined;
        if (worker.snapshot.workflow?.supervisor) {
          worker.snapshot = {
            ...worker.snapshot,
            workflow: {
              ...worker.snapshot.workflow,
              supervisor: { ...worker.snapshot.workflow.supervisor, pendingGuidance: null },
            },
          };
        }
        yield* dispatchWorkflowPhaseWithRecovery(worker, pendingGuidance);
      }));
    });

    const stopWorkflowSupervisor = (workflow: EngineeringWorkflow): Effect.Effect<void, SessionStorageError> => {
      const supervisorSession = workflow.supervisor ? sessions.get(workflow.supervisor.sessionId) : undefined;
      if (!supervisorSession || TERMINAL_STATUSES.has(supervisorSession.snapshot.status)) return Effect.void;
      supervisorSession.resumeAfterRestart = false;
      supervisorSession.resumeRunAfterRestart = false;
      supervisorSession.snapshot = {
        ...supervisorSession.snapshot,
        status: transitionAttentionState(supervisorSession.snapshot.status, "stopRequested"),
        lastActivityAt: now(),
      };
      failPending(supervisorSession, "Workflow supervisor runtime was stopped");
      return terminate(supervisorSession).pipe(
        Effect.tap(() => Effect.sync(() => {
          supervisorSession.snapshot = { ...supervisorSession.snapshot, status: "stopped", pid: null, lastActivityAt: now() };
          supervisorSession.child = null;
        })),
        Effect.andThen(persist()),
      );
    };

    continueWorkflowAfterSettle = (session) => {
      if (!session.workflowDispatchPending) return;
      session.workflowDispatchPending = false;
      const pendingGuidance = session.snapshot.workflow?.supervisor?.pendingGuidance ?? undefined;
      if (session.snapshot.workflow?.supervisor?.pendingGuidance) {
        session.snapshot = {
          ...session.snapshot,
          workflow: {
            ...session.snapshot.workflow,
            supervisor: { ...session.snapshot.workflow.supervisor, pendingGuidance: null },
          },
        };
      }
      void Effect.runPromise(session.mutationLock.withPermit(dispatchWorkflowPhaseWithRecovery(session, pendingGuidance))).catch((cause) => {
        console.error("Could not recover failed engineering workflow dispatch", cause);
      });
    };

    const resolveTarget = (target: RuntimeTarget): Effect.Effect<MutableOwnedSession, RuntimeCommandError> => {
      const session = sessions.get(target.sessionId);
      if (!session) return Effect.fail(new SessionNotFoundError({ sessionId: target.sessionId }));
      if (session.snapshot.runtimeId !== target.runtimeId) {
        return Effect.fail(new StaleRuntimeGenerationError({
          sessionId: target.sessionId,
          expectedRuntimeId: session.snapshot.runtimeId,
          receivedRuntimeId: target.runtimeId,
        }));
      }
      return Effect.succeed(session);
    };

    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      const shutdownSessions = [...sessions.values()].map((session) => {
        const statusBeforeShutdown = session.snapshot.status;
        const wasActive = !TERMINAL_STATUSES.has(statusBeforeShutdown);
        if (wasActive) {
          session.resumeAfterRestart = true;
          session.resumeRunAfterRestart = statusBeforeShutdown === "working";
          session.snapshot = { ...session.snapshot, status: "stopping", lastActivityAt: now() };
        }
        const interruptedRequests = session.snapshot.interactiveRequests.length;
        for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
        session.interactiveTimers.clear();
        session.snapshot = { ...session.snapshot, interactiveRequests: [] };
        failPending(session, "PISS is shutting down");
        return { session, wasActive, interruptedRequests };
      });

      // Persist restart intent before waiting on child processes. If a runtime
      // or browser child wedges shutdown, the next generation can still
      // automatically recover every runtime that was active.
      yield* persist(false);
      yield* Effect.forEach(
        shutdownSessions,
        ({ session, wasActive, interruptedRequests }) => terminate(session).pipe(
          Effect.tap(() => Effect.sync(() => {
            if (wasActive) {
              session.snapshot = {
                ...session.snapshot,
                status: "stopped",
                pid: null,
                lastActivityAt: now(),
                error: interruptedRequests > 0
                  ? `${interruptedRequests} pending interactive request${interruptedRequests === 1 ? " was" : "s were"} cancelled when the control plane stopped`
                  : "The control plane stopped this runtime; the Pi transcript is preserved and can be resumed",
              };
              session.child = null;
            }
          })),
        ),
        { concurrency: "unbounded", discard: true },
      );
      yield* persist(false);
    }).pipe(
      Effect.catch((cause) => Effect.sync(() => console.error("Could not persist owned sessions during shutdown", cause))),
    ));

    const createSession = (input: CreateOwnedSessionInput, supervisor = false) =>
      creationLock.withPermit(Effect.gen(function* () {
        const sessionName = input.name.trim() || "New session";
        const initialPrompt = input.prompt?.trim();
        const workspace = yield* workspaces.findById(input.workspaceId);
        if (!workspace) return yield* Effect.fail(new WorkspaceNotFoundError({ workspaceId: input.workspaceId }));
        if (sessions.size >= MAX_RETAINED_SESSIONS) {
          return yield* Effect.fail(new SessionLimitError({ maximum: MAX_RETAINED_SESSIONS }));
        }
        const activeRuntimeCount = [...sessions.values()].filter(
          (session) => session.child && session.child.exitCode === null && session.child.signalCode === null,
        ).length;
        if (activeRuntimeCount >= MAX_ACTIVE_RUNTIMES) {
          return yield* Effect.fail(new ActiveRuntimeLimitError({ maximum: MAX_ACTIVE_RUNTIMES }));
        }
        const rootHandle = yield* directories.openAuthorized(workspace.root);
        const rootStat = yield* Effect.tryPromise({
          try: () => rootHandle.stat({ bigint: true }),
          catch: (cause) => new WorkspacePathError({ path: workspace.root, message: "Could not identify the workspace checkout", cause }),
        }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
        const branch = yield* Effect.promise(() => detectBranch(rootHandle.fd));
        const id = randomUUID();
        const runtimeId = randomUUID();
        const createdAt = now();
        const artifactStagingDirectory = yield* Effect.tryPromise({
          try: () => prepareRuntimeArtifactStaging(config.stateDir, id, runtimeId),
          catch: (cause) => new SessionStorageError({ message: "Could not prepare browser artifact staging", cause }),
        }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
        const child = yield* Effect.try({
          try: () => spawn(config.piCommand, processArguments(workspace, sessionName, config.workflowResourceDir, undefined, supervisor), {
            cwd: "/proc/self/fd/3",
            detached: true,
            env: {
              ...process.env,
              ...(config.browserExecutablePath ? { PISS_BROWSER_EXECUTABLE_PATH: config.browserExecutablePath } : {}),
              PISS_BROWSER_ARTIFACT_STAGING_DIR: artifactStagingDirectory,
            },
            stdio: ["pipe", "pipe", "pipe", rootHandle.fd],
          }) as ChildProcessWithoutNullStreams,
          catch: (cause) => new PiSpawnError({ command: config.piCommand, cause }),
        }).pipe(Effect.tapError(() => Effect.all([
          Effect.promise(() => rootHandle.close()),
          Effect.promise(() => removeRuntimeArtifactStaging(config.stateDir, id, runtimeId)),
        ], { discard: true })));
        const mutationLock = yield* Semaphore.make(1);
        const session: MutableOwnedSession = {
          child,
          eventBytes: 0,
          sequence: 0,
          stderr: "",
          activeRunImageCharacters: 0,
          resumeAfterRestart: false,
          resumeRunAfterRestart: false,
          finalResponseRecoveryAttempted: false,
          quarantined: false,
          workflowDispatchPending: false,
          workflowEventTail: Promise.resolve(),
          workflowCancelRequested: null,
          pendingWorkflowAuthority: new Map(),
          resolvedWorkflowAuthority: new Map(),
          pending: new Map(),
          mutationLock,
          workspaceIdentity: { device: rootStat.dev, inode: rootStat.ino },
          sessionFileIdentity: null,
          acceptedCommandIds: new Set(),
          processedWorkflowStartMutationIds: new Set(),
          interactiveTimers: new Map(),
          snapshot: {
            id,
            runtimeId,
            workspaceId: workspace.id,
            name: sessionName,
            branch,
            status: "starting",
            pid: child.pid ?? null,
            piSessionId: null,
            sessionFile: null,
            model: null,
            thinkingLevel: null,
            usage: null,
            autoCompactionEnabled: null,
            pendingMessageCount: 0,
            compaction: idleCompaction(),
            workflow: null,
            createdAt,
            lastActivityAt: createdAt,
            events: [],
            interactiveRequests: [],
            error: null,
          },
        };
        sessions.set(id, session);
        attach(session);

        return yield* Effect.gen(function* () {
          yield* awaitSpawn(child, config.piCommand).pipe(
            Effect.ensuring(Effect.promise(() => rootHandle.close())),
          );
          session.snapshot = { ...session.snapshot, pid: child.pid ?? null };
          const state = yield* request(session, { id: `${id}:state`, type: "get_state" });
          const data = stateData(state);
          session.snapshot = {
            ...session.snapshot,
            piSessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
            sessionFile: typeof data?.sessionFile === "string" ? data.sessionFile : null,
            model: availableModel(data?.model) ?? null,
            thinkingLevel: thinkingLevel(data?.thinkingLevel),
            autoCompactionEnabled: typeof data?.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : null,
            pendingMessageCount: nonNegativeInteger(data?.pendingMessageCount) ?? 0,
          };
          if (!session.snapshot.sessionFile || !session.snapshot.piSessionId) {
            return yield* Effect.fail(new PiCommandError({ sessionId: id, message: "Pi did not provide a durable session identity" }));
          }
          session.sessionFileIdentity = yield* inspectSessionFile(id, session.snapshot.sessionFile, workspace.root, session.snapshot.piSessionId).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          yield* persist();
          if (initialPrompt) {
            const initialCommandId = `${id}:initial-prompt`;
            session.acceptedCommandIds.add(initialCommandId);
            yield* persist();
            yield* request(session, { id: initialCommandId, type: "prompt", message: initialPrompt }).pipe(
              Effect.tapError(() => Effect.sync(() => session.acceptedCommandIds.delete(initialCommandId)).pipe(Effect.andThen(persist()))),
            );
          } else {
            session.snapshot = { ...session.snapshot, status: "idle", lastActivityAt: now() };
            yield* persist();
          }
          return cloneSession(session.snapshot);
        }).pipe(
          Effect.tapError((error) => Effect.sync(() => crash(session, error.message, error))),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void;
            return Effect.sync(() => {
              if (!TERMINAL_STATUSES.has(session.snapshot.status)) {
                crash(session, "Owned session creation was interrupted");
              }
            }).pipe(Effect.andThen(terminate(session)));
          }),
        );
      }));

    const create: PiRuntimeSupervisorShape["create"] = (input) => createSession(input);

    const importSession: PiRuntimeSupervisorShape["import"] = (input) => creationLock.withPermit(Effect.gen(function* () {
      const workspace = yield* workspaces.findById(input.workspaceId);
      if (!workspace) return yield* Effect.fail(new WorkspaceNotFoundError({ workspaceId: input.workspaceId }));
      if (sessions.size >= MAX_RETAINED_SESSIONS) {
        return yield* Effect.fail(new SessionLimitError({ maximum: MAX_RETAINED_SESSIONS }));
      }
      const rootHandle = yield* directories.openAuthorized(workspace.root);
      const workspaceState = yield* Effect.gen(function* () {
        const rootStat = yield* Effect.tryPromise({
          try: () => rootHandle.stat({ bigint: true }),
          catch: (cause) => new WorkspacePathError({ path: workspace.root, message: "Could not identify the workspace checkout", cause }),
        });
        const branch = yield* Effect.promise(() => detectBranch(rootHandle.fd));
        return { rootStat, branch };
      }).pipe(Effect.ensuring(Effect.promise(() => rootHandle.close())));
      const id = randomUUID();
      const transcript = yield* inspectSessionFile(id, input.sessionFile, workspace.root);
      if ([...sessions.values()].some((session) => session.sessionFileIdentity?.device === transcript.device && session.sessionFileIdentity.inode === transcript.inode)) {
        return yield* Effect.fail(new SessionResumeError({ sessionId: id, message: "This Pi transcript has already been imported" }));
      }
      const runtimeId = randomUUID();
      const createdAt = now();
      const mutationLock = yield* Semaphore.make(1);
      const session: MutableOwnedSession = {
        child: null,
        eventBytes: 0,
        sequence: 0,
        stderr: "",
        activeRunImageCharacters: 0,
        resumeAfterRestart: false,
        resumeRunAfterRestart: false,
        finalResponseRecoveryAttempted: false,
        quarantined: false,
        workflowDispatchPending: false,
        workflowEventTail: Promise.resolve(),
        workflowCancelRequested: null,
        pendingWorkflowAuthority: new Map(),
        resolvedWorkflowAuthority: new Map(),
        pending: new Map(),
        mutationLock,
        workspaceIdentity: { device: workspaceState.rootStat.dev, inode: workspaceState.rootStat.ino },
        sessionFileIdentity: { device: transcript.device, inode: transcript.inode },
        acceptedCommandIds: new Set(),
        processedWorkflowStartMutationIds: new Set(),
        interactiveTimers: new Map(),
        snapshot: {
          id,
          runtimeId,
          workspaceId: workspace.id,
          name: input.name.trim() || "Imported session",
          branch: workspaceState.branch,
          status: "stopped",
          pid: null,
          piSessionId: transcript.piSessionId,
          sessionFile: input.sessionFile,
          model: null,
          thinkingLevel: null,
          usage: null,
          autoCompactionEnabled: null,
          pendingMessageCount: 0,
          compaction: idleCompaction(),
          workflow: null,
          createdAt,
          lastActivityAt: createdAt,
          events: [],
          interactiveRequests: [],
          error: null,
        },
      };
      sessions.set(id, session);
      yield* persist().pipe(Effect.tapError(() => Effect.sync(() => { sessions.delete(id); })));
      return cloneSession(session.snapshot);
    }));

    const resume: PiRuntimeSupervisorShape["resume"] = (target) => creationLock.withPermit(Effect.gen(function* () {
      const session = yield* resolveTarget(target);
      const resumeInterruptedRun = session.resumeRunAfterRestart;
      session.resumeAfterRestart = false;
      session.resumeRunAfterRestart = false;
      if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
        return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "This session already has an active runtime" }));
      }
      if (session.snapshot.status !== "stopped" && session.snapshot.status !== "crashed") {
        return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: `A ${session.snapshot.status} session cannot be resumed` }));
      }
      const activeRuntimeCount = [...sessions.values()].filter(
        (candidate) => candidate.child && candidate.child.exitCode === null && candidate.child.signalCode === null,
      ).length;
      if (activeRuntimeCount >= MAX_ACTIVE_RUNTIMES) {
        return yield* Effect.fail(new ActiveRuntimeLimitError({ maximum: MAX_ACTIVE_RUNTIMES }));
      }
      const workspace = yield* workspaces.findById(session.snapshot.workspaceId);
      if (!workspace) return yield* Effect.fail(new WorkspaceNotFoundError({ workspaceId: session.snapshot.workspaceId }));
      const sessionFile = session.snapshot.sessionFile;
      const piSessionId = session.snapshot.piSessionId;
      if (session.sessionFileIdentity && (!sessionFile || !piSessionId)) {
        return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "This session has incomplete transcript metadata" }));
      }
      if (resumeInterruptedRun && !session.sessionFileIdentity && sessionFile && piSessionId) {
        session.sessionFileIdentity = yield* inspectSessionFile(session.snapshot.id, sessionFile, workspace.root, piSessionId);
      }
      const durableTranscript = Boolean(sessionFile && piSessionId && session.sessionFileIdentity);
      const shouldReplayTranscript = durableTranscript && session.snapshot.events.length === 0;
      const rootHandle = yield* directories.openAuthorized(workspace.root);
      const rootStat = yield* Effect.tryPromise({
        try: () => rootHandle.stat({ bigint: true }),
        catch: (cause) => new WorkspacePathError({ path: workspace.root, message: "Could not identify the workspace checkout", cause }),
      }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
      if (rootStat.dev !== session.workspaceIdentity.device || rootStat.ino !== session.workspaceIdentity.inode) {
        yield* Effect.promise(() => rootHandle.close());
        return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "The authorized workspace checkout changed on disk" }));
      }
      if (durableTranscript) {
        yield* inspectSessionFile(session.snapshot.id, sessionFile!, workspace.root, piSessionId!, session.sessionFileIdentity!).pipe(
          Effect.tapError(() => Effect.promise(() => rootHandle.close())),
        );
      }
      const branch = yield* Effect.promise(() => detectBranch(rootHandle.fd));
      const runtimeId = randomUUID();
      yield* Effect.promise(() => artifactAdoptionTails.get(session.snapshot.id) ?? Promise.resolve());
      const artifactStagingDirectory = yield* Effect.tryPromise({
        try: () => prepareRuntimeArtifactStaging(config.stateDir, session.snapshot.id, runtimeId),
        catch: (cause) => new SessionStorageError({ message: "Could not prepare browser artifact staging", cause }),
      }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
      const supervisorSession = [...sessions.values()].some((candidate) => candidate.snapshot.workflow?.supervisor?.sessionId === session.snapshot.id);
      const child = yield* Effect.try({
        try: () => spawn(config.piCommand, processArguments(workspace, session.snapshot.name, config.workflowResourceDir, durableTranscript ? sessionFile! : undefined, supervisorSession), {
          cwd: "/proc/self/fd/3",
          detached: true,
          env: {
            ...process.env,
            ...(config.browserExecutablePath ? { PISS_BROWSER_EXECUTABLE_PATH: config.browserExecutablePath } : {}),
            PISS_BROWSER_ARTIFACT_STAGING_DIR: artifactStagingDirectory,
          },
          stdio: ["pipe", "pipe", "pipe", rootHandle.fd],
        }) as ChildProcessWithoutNullStreams,
        catch: (cause) => new PiSpawnError({ command: config.piCommand, cause }),
      }).pipe(Effect.tapError(() => Effect.all([
        Effect.promise(() => rootHandle.close()),
        Effect.promise(() => removeRuntimeArtifactStaging(config.stateDir, session.snapshot.id, runtimeId)),
      ], { discard: true })));
      session.child = child;
      session.termination = undefined;
      session.quarantined = false;
      session.stderr = "";
      session.activeRunImageCharacters = 0;
      session.snapshot = {
        ...session.snapshot,
        runtimeId,
        branch,
        status: "starting",
        pid: child.pid ?? null,
        lastActivityAt: now(),
        error: null,
      };
      attach(session);

      return yield* Effect.gen(function* () {
        yield* awaitSpawn(child, config.piCommand).pipe(Effect.ensuring(Effect.promise(() => rootHandle.close())));
        yield* persist();
        const state = yield* request(session, { id: `${session.snapshot.id}:resume-state`, type: "get_state" });
        const data = stateData(state);
        if (durableTranscript) {
          if (data?.sessionId !== piSessionId || data?.sessionFile !== sessionFile) {
            return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "Pi resumed a different transcript than requested" }));
          }
          session.sessionFileIdentity = yield* inspectSessionFile(session.snapshot.id, sessionFile!, workspace.root, piSessionId!, session.sessionFileIdentity);
          const guidanceNeedsReconciliation = Boolean(session.snapshot.workflow?.guidance?.some((item) => item.status === "queued"));
          if (shouldReplayTranscript || guidanceNeedsReconciliation) {
            const entriesResponse = yield* request(session, { id: `${session.snapshot.id}:resume-entries`, type: "get_entries" });
            const entries = stateData(entriesResponse)?.entries;
            if (!Array.isArray(entries)) {
              return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "Pi did not return resumable transcript entries" }));
            }
            if (shouldReplayTranscript) {
              for (const entry of entries.slice(-250)) {
                for (const replayed of replayEventsFromTranscriptEntry(entry)) appendEvent(session, replayed.type, replayed.data);
              }
            }
            const workflowBeforeGuidance = session.snapshot.workflow;
            if (workflowBeforeGuidance && guidanceNeedsReconciliation) {
              const deliveredAt = now();
              const observedIds = transcriptGuidanceIds(workflowBeforeGuidance, entries);
              const workflowAfterGuidance = reconcileTranscriptGuidance(workflowBeforeGuidance, entries, deliveredAt);
              if (workflowAfterGuidance !== workflowBeforeGuidance) {
                for (const item of workflowBeforeGuidance.guidance ?? []) {
                  if (item.status !== "queued" || !observedIds.has(item.id)) continue;
                  session.acceptedCommandIds.add(item.commandId);
                  appendEvent(session, "workflow_guidance_delivery", {
                    workflowId: workflowBeforeGuidance.id,
                    event: { eventId: `guidance-delivered:${item.commandId}`, guidanceId: item.id, commandId: item.commandId, planRevision: item.planRevision, deliveredAt },
                  }, true);
                }
                session.snapshot = { ...session.snapshot, workflow: workflowAfterGuidance, lastActivityAt: deliveredAt };
              }
            }
          }
        } else {
          const freshSessionId = typeof data?.sessionId === "string" ? data.sessionId : null;
          const freshSessionFile = typeof data?.sessionFile === "string" ? data.sessionFile : null;
          if (!freshSessionId || !freshSessionFile) {
            return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "Pi did not provide a fresh durable session identity" }));
          }
          session.sessionFileIdentity = yield* inspectSessionFile(session.snapshot.id, freshSessionFile, workspace.root, freshSessionId).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          session.snapshot = { ...session.snapshot, piSessionId: freshSessionId, sessionFile: freshSessionFile };
        }
        session.snapshot = {
          ...session.snapshot,
          status: data?.isStreaming === true ? "working" : resumeInterruptedRun ? "idle" : durableTranscript ? "finished" : "idle",
          pid: child.pid ?? null,
          model: availableModel(data?.model) ?? session.snapshot.model,
          thinkingLevel: thinkingLevel(data?.thinkingLevel) ?? session.snapshot.thinkingLevel,
          autoCompactionEnabled: typeof data?.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : session.snapshot.autoCompactionEnabled,
          pendingMessageCount: nonNegativeInteger(data?.pendingMessageCount) ?? 0,
          lastActivityAt: now(),
          error: null,
        };
        yield* persist();
        if (resumeInterruptedRun && data?.isStreaming !== true) {
          const workflow = session.snapshot.workflow;
          if (workflow && (isAutonomousWorkflowPhase(workflow.phase) || workflow.phase === "defining" || workflow.phase === "planning")) {
            yield* dispatchWorkflowPhaseWithRecovery(
              session,
              "The control plane restarted. Reconcile durable progress and operation receipts, then resume from the first incomplete approved criterion. Do not repeat completed side effects.",
            );
          } else {
            // Exact in-flight OS process continuity is deliberately outside the
            // workflow contract; transcript-aware recovery resumes at a safe boundary.
            yield* request(session, {
              id: `${session.snapshot.id}:continue-after-restart:${session.snapshot.runtimeId}`,
              type: "prompt",
              message: INTERRUPTED_RUN_CONTINUATION,
            });
          }
        }
        return cloneSession(session.snapshot);
      }).pipe(
        Effect.tapError((error) => Effect.sync(() => crash(session, error.message, error)).pipe(Effect.andThen(persist()))),
        Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : terminate(session)),
      );
    }));

    const automaticResumeTargets = loaded.flatMap((record) => {
      const session = sessions.get(record.id);
      if (!session?.resumeAfterRestart || session.snapshot.status !== "stopped") return [];
      session.resumeAfterRestart = false;
      return [{ sessionId: session.snapshot.id, runtimeId: session.snapshot.runtimeId }];
    });
    if (automaticResumeTargets.length > 0) {
      yield* persist();
      yield* Effect.forEach(automaticResumeTargets, (target) =>
        resume(target).pipe(
          Effect.catch((cause) => {
            const session = sessions.get(target.sessionId);
            if (session && session.snapshot.status === "stopped") {
              session.snapshot = {
                ...session.snapshot,
                error: `Could not automatically resume after the PISS update: ${cause instanceof Error ? cause.message : "unknown error"}`,
                lastActivityAt: now(),
              };
            }
            return persist().pipe(
              Effect.catch((persistCause) => Effect.sync(() => console.error("Could not persist automatic resume failure", persistCause))),
            );
          }),
        ), { concurrency: 1, discard: true });
    }

    const legacyBlockedWorkers = [...sessions.values()].filter((session) => {
      const workflow = session.snapshot.workflow;
      return workflow?.phase === "blocked"
        && !workflow.supervisor
        && (workflow.checkpoint?.stage === "build" || workflow.checkpoint?.stage === "verify" || workflow.checkpoint?.stage === "review")
        && !TERMINAL_STATUSES.has(session.snapshot.status);
    });
    if (legacyBlockedWorkers.length > 0) {
      yield* Effect.forEach(legacyBlockedWorkers, (session) =>
        session.mutationLock.withPermit(consultWorkflowSupervisor(session)).pipe(
          Effect.catch((cause) => Effect.sync(() => console.error("Could not consult a supervisor for an existing blocked workflow", cause))),
        ), { concurrency: 1, discard: true });
    }

    const get: PiRuntimeSupervisorShape["get"] = (id) => {
      const session = sessions.get(id);
      return session
        ? Effect.succeed(cloneSession(session.snapshot))
        : Effect.fail(new SessionNotFoundError({ sessionId: id }));
    };

    const timelinePage: PiRuntimeSupervisorShape["timelinePage"] = (id, beforeSequence, limit) => {
      if (!sessions.has(id)) return Effect.fail(new SessionNotFoundError({ sessionId: id }));
      return Effect.tryPromise({
        try: async () => {
          await timelinePersistenceTails.get(id);
          return loadOwnedSessionTimelinePage(timelineDirectory, id, beforeSequence, limit);
        },
        catch: (cause) => new SessionStorageError({ message: `Could not load timeline history for session ${id}`, cause }),
      });
    };

    const toolOutput: PiRuntimeSupervisorShape["toolOutput"] = (id, ref) => {
      if (!sessions.has(id)) return Effect.fail(new SessionNotFoundError({ sessionId: id }));
      return Effect.tryPromise({
        try: async () => {
          await timelinePersistenceTails.get(id);
          return loadOwnedSessionToolOutput(timelineDirectory, id, ref);
        },
        catch: (cause) => new SessionStorageError({ message: `Could not load tool output for session ${id}`, cause }),
      });
    };

    const subscribe: PiRuntimeSupervisorShape["subscribe"] = (id, listener) => {
      const session = sessions.get(id);
      if (!session) return Effect.fail(new SessionNotFoundError({ sessionId: id }));
      const listeners = sessionSubscribers.get(id) ?? new Set<(session: OwnedSession) => void>();
      listeners.add(listener);
      sessionSubscribers.set(id, listeners);
      listener(cloneSession(session.snapshot));
      return Effect.succeed(() => {
        listeners.delete(listener);
        if (listeners.size === 0) sessionSubscribers.delete(id);
      });
    };

    const removeWorkspace: PiRuntimeSupervisorShape["removeWorkspace"] = (id) => creationLock.withPermit(Effect.gen(function* () {
      const sessionCount = [...sessions.values()].filter((session) => session.snapshot.workspaceId === id).length;
      if (sessionCount > 0) return yield* Effect.fail(new WorkspaceHasSessionsError({ workspaceId: id, sessionCount }));
      const workspace = yield* workspaces.findById(id);
      yield* workspaces.remove(id);
      if (workspace) yield* fileMentions.release(workspace.root);
    }));

    const sendText = (target: RuntimeTarget, type: "prompt" | "steer" | "follow_up", text: string, images: ReadonlyArray<ImageInput> = [], commandId?: string) =>
      resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          if (commandId && session.acceptedCommandIds.has(commandId)) return;
          const slashCommandPrompt = type === "prompt" && /^\/[^\s/]+(?:\s|$)/u.test(text);
          const available = type === "prompt"
            ? canAcceptPrompt(session.snapshot.status) || slashCommandPrompt && session.snapshot.status === "working"
            : session.snapshot.status === "working";
          if (!available) {
            return yield* Effect.fail(new PiCommandError({
              sessionId: session.snapshot.id,
              message: `${type} is unavailable while the runtime is ${session.snapshot.status}`,
            }));
          }
          const imageCharacters = images.reduce((total, image) => total + image.data.length, 0);
          if (session.activeRunImageCharacters + imageCharacters > MAX_ACTIVE_RUN_IMAGE_CHARACTERS) {
            return yield* Effect.fail(new PiCommandError({
              sessionId: session.snapshot.id,
              message: "Wait for the current agent run to settle before sending more image data",
            }));
          }
          const priorStatus = session.snapshot.status;
          if (commandId) {
            session.acceptedCommandIds.add(commandId);
            while (session.acceptedCommandIds.size > 128) {
              const oldest = session.acceptedCommandIds.values().next().value;
              if (typeof oldest !== "string") break;
              session.acceptedCommandIds.delete(oldest);
            }
          }
          if (type === "prompt") {
            session.finalResponseRecoveryAttempted = false;
            // RPC extension commands may complete without an agent run. Let
            // lifecycle events move slash submissions to working only when Pi
            // actually starts the agent; ordinary prompts remain optimistic so
            // no second mutation can slip in before agent_start is projected.
            session.snapshot = { ...session.snapshot, status: slashCommandPrompt ? session.snapshot.status : "working", error: null, lastActivityAt: now() };
          }
          session.activeRunImageCharacters += imageCharacters;
          yield* persist();
          yield* request(session, {
            ...(commandId ? { id: commandId } : {}),
            type,
            message: text,
            ...(images.length > 0 ? { images: images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })) } : {}),
          }).pipe(
            Effect.tapError(() => Effect.sync(() => {
              session.activeRunImageCharacters = Math.max(0, session.activeRunImageCharacters - imageCharacters);
              if (commandId) session.acceptedCommandIds.delete(commandId);
              if (type === "prompt" && !slashCommandPrompt && session.snapshot.status === "working") {
                session.snapshot = { ...session.snapshot, status: priorStatus, lastActivityAt: now() };
              }
            }).pipe(Effect.andThen(persist()))),
          );
        }))),
      );

    const mutateWorkflow: PiRuntimeSupervisorShape["mutateWorkflow"] = (target, input) => resolveTarget(target).pipe(
      Effect.tap((session) => Effect.sync(() => {
        if (input.action !== "cancel") return;
        const current = session.snapshot.workflow;
        if (!current || isTerminalWorkflowPhase(current.phase)) return;
        if (input.workflowId && input.workflowId !== current.id) return;
        if (input.expectedRevision !== undefined && input.expectedRevision !== workflowRevision(current)) return;
        if (input.expectedPhase && input.expectedPhase !== current.phase) return;
        if (input.expectedPhaseRunId && input.expectedPhaseRunId !== current.phaseRun?.id) return;
        session.workflowCancelRequested = {
          key: workflowCancelIntentKey(input),
          workflowId: current.id,
          workflowRevision: workflowRevision(current),
          phase: current.phase,
          ...(current.phaseRun ? { phaseRunId: current.phaseRun.id } : {}),
        };
      })),
      Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
        const current = session.snapshot.workflow;
        const cancelIntentKey = input.action === "cancel" ? workflowCancelIntentKey(input) : undefined;
        const clearCancelIntent = () => {
          if (cancelIntentKey && session.workflowCancelRequested?.key === cancelIntentKey) session.workflowCancelRequested = null;
        };
        const unavailable = (message: string) => {
          clearCancelIntent();
          return Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message }));
        };
        const mutationProcessed = (workflow: EngineeringWorkflow) => workflow.processedMutationIds?.includes(input.mutationId) === true;
        const withProcessedMutation = <T extends EngineeringWorkflow>(workflow: T): T => ({
          ...workflow,
          processedMutationIds: [...new Set([...(workflow.processedMutationIds ?? []), input.mutationId])],
        });
        if (input.action === "start" && session.processedWorkflowStartMutationIds.has(input.mutationId)) {
          clearCancelIntent();
          return cloneSession(session.snapshot);
        }
        if (current) {
          if (input.action === "cancel" && current.cancellationMutationId === input.mutationId) {
            clearCancelIntent();
            return cloneSession(session.snapshot);
          }
          if (mutationProcessed(current)) {
            clearCancelIntent();
            return cloneSession(session.snapshot);
          }
          if (input.action !== "start") {
            if (input.workflowId !== current.id) return yield* unavailable("This workflow mutation targets a stale workflow");
            if (input.expectedRevision !== workflowRevision(current)) return yield* unavailable(`This workflow mutation targets stale workflow revision ${input.expectedRevision}; current revision is ${workflowRevision(current)}`);
            if (input.expectedPhase !== current.phase) return yield* unavailable("This workflow mutation targets a stale workflow phase");
            if (input.expectedPhaseRunId !== current.phaseRun?.id) return yield* unavailable("This workflow mutation targets a stale phase run");
            if (!workflowCanRecordMutation(current, input.action === "cancel")) {
              return yield* unavailable("This workflow has reached its durable mutation receipt limit; cancel it or start a replacement workflow rather than evicting replay protection");
            }
          }
        }
        if (input.action === "accept") {
          if (!current || current.phase !== "readyToShip") return yield* unavailable("Only a workflow ready to ship can be accepted");
          const updatedAt = now();
          session.snapshot = {
            ...session.snapshot,
            workflow: withProcessedMutation({ ...current, phase: "accepted", blockedFromPhase: null, revision: workflowRevision(current) + 1, updatedAt, error: null }),
            lastActivityAt: updatedAt,
          };
          yield* persist();
          yield* stopWorkflowSupervisor(current);
          return cloneSession(session.snapshot);
        }
        if (input.action === "cancel") {
          if (!current || isTerminalWorkflowPhase(current.phase)) return cloneSession(session.snapshot);
          session.workflowDispatchPending = false;
          const updatedAt = now();
          session.snapshot = {
            ...session.snapshot,
            workflow: cancelEngineeringWorkflowWithReceipt(current, input.mutationId, updatedAt),
            lastActivityAt: updatedAt,
          };
          yield* persist();
          yield* request(session, { id: `workflow:${current.id}:cancel:${input.mutationId ?? randomUUID()}`, type: "abort" }).pipe(Effect.catch(() => Effect.void));
          session.snapshot = { ...session.snapshot, status: "finished", lastActivityAt: now() };
          yield* persist();
          yield* stopWorkflowSupervisor(current);
          return cloneSession(session.snapshot);
        }
        if (input.action === "start") {
          if (!canAcceptPrompt(session.snapshot.status)) return yield* unavailable("Start an engineering workflow only while Pi is idle");
          if (current && !isTerminalWorkflowPhase(current.phase)) return yield* unavailable("This session already has an active engineering workflow");
          if (session.processedWorkflowStartMutationIds.size >= MAX_PROCESSED_WORKFLOW_START_MUTATION_IDS) {
            return yield* unavailable("This session has reached its durable workflow-start receipt limit; create a new session rather than evicting replay protection");
          }
          const createdAt = now();
          session.workflowCancelRequested = null;
          session.processedWorkflowStartMutationIds.add(input.mutationId);
          const workflow: EngineeringWorkflow = {
            id: randomUUID(),
            phase: "defining",
            objective: input.objective.trim(),
            researchPolicy: input.researchPolicy ?? "local_only",
            researchQuestions: [],
            repairAttempts: 0,
            maxRepairAttempts: input.maxRepairAttempts ?? 3,
            specification: null,
            plan: null,
            checkpoint: null,
            blockedFromPhase: null,
            revision: 0,
            artifactRevision: 0,
            progress: initialWorkflowProgress(createdAt),
            guidance: [],
            authorityDecisions: [],
            operationReceipts: [],
            processedEventIds: [],
            processedMutationIds: input.mutationId ? [input.mutationId] : [],
            supersededRevisions: [],
            openQuestions: [],
            createdAt,
            updatedAt: createdAt,
            error: null,
          };
          session.snapshot = { ...session.snapshot, workflow, lastActivityAt: createdAt };
          yield* persist();
          yield* dispatchWorkflowPhaseWithRecovery(session);
          return cloneSession(session.snapshot);
        }
        if (!current) return yield* unavailable("This session has no engineering workflow");
        if (input.action === "continueRepairs") {
          if (current.phase !== "failed") return yield* unavailable("Only a failed workflow can continue with more repairs");
          const maxRepairAttempts = Math.min(100, current.maxRepairAttempts + input.additionalRepairAttempts);
          const repairAttempts = current.repairAttempts + 1;
          if (maxRepairAttempts < repairAttempts) return yield* unavailable("This workflow has reached the maximum cumulative repair budget");
          const updatedAt = now();
          session.snapshot = {
            ...session.snapshot,
            workflow: withProcessedMutation({
              ...current,
              phase: "repairing",
              repairAttempts,
              maxRepairAttempts,
              revision: workflowRevision(current) + 1,
              blockedFromPhase: null,
              progress: current.progress ? { ...current.progress, condition: "working", activity: `Starting repair attempt ${repairAttempts} of ${maxRepairAttempts}`, nextAction: "Repair all remaining blocking findings", lastActivityAt: updatedAt } : current.progress,
              updatedAt,
              error: null,
            }),
            lastActivityAt: updatedAt,
          };
          yield* persist();
          yield* dispatchWorkflowPhaseWithRecovery(session);
          return cloneSession(session.snapshot);
        }
        if (input.action === "approve") {
          const approvesExecution = current.phase === "awaitingPlanApproval";
          const phase: EngineeringWorkflowPhase = current.phase === "awaitingSpecApproval"
            ? "planning"
            : approvesExecution
              ? "building"
              : current.phase;
          if (phase === current.phase) return yield* unavailable("This workflow is not waiting for final approval");
          if (approvesExecution) {
            const unappliedGuidanceIds = workflowUnappliedGuidanceIdsForCurrentPhase(current);
            if (unappliedGuidanceIds.length > 0) {
              const updatedAt = now();
              const replanning = withProcessedMutation(reconcileWorkflowApprovalGuidance(current, updatedAt));
              session.snapshot = { ...session.snapshot, workflow: replanning, lastActivityAt: updatedAt };
              yield* persist();
              if (session.snapshot.status === "working") {
                session.workflowDispatchPending = true;
                yield* request(session, { id: `workflow:${current.id}:approval-guidance:${input.mutationId}`, type: "abort" }).pipe(Effect.catch(() => Effect.void));
              } else {
                yield* dispatchWorkflowPhaseWithRecovery(session);
              }
              return cloneSession(session.snapshot);
            }
          }
          if (approvesExecution && (current.revision !== undefined || current.artifactRevision !== undefined)) {
            const dossierError = workflowDossierValidationError(current.dossier);
            if (dossierError) return yield* unavailable(dossierError);
            if (current.dossier!.unresolved.length > 0 || current.dossier!.readiness.some((item) => item.status === "unresolved")) {
              return yield* unavailable("Resolve every plan readiness requirement before final approval");
            }
          }
          const updatedAt = now();
          const artifactDigest = createHash("sha256")
            .update(`${current.specification ?? ""}\n---PLAN---\n${current.plan ?? ""}\n---DOSSIER---\n${JSON.stringify(current.dossier ?? null)}`)
            .digest("hex");
          const progress = current.progress ?? initialWorkflowProgress(updatedAt, "working", current.dossier);
          session.snapshot = {
            ...session.snapshot,
            workflow: withProcessedMutation({
              ...current,
              phase,
              checkpoint: current.checkpoint,
              revision: workflowRevision(current) + 1,
              progress: { ...progress, condition: "working", activity: approvesExecution ? "Final plan approved; starting autonomous execution" : "Continuing to planning", nextAction: approvesExecution ? "Execute the first incomplete delivery slice" : "Prepare the complete delivery plan", lastActivityAt: updatedAt },
              ...(approvesExecution ? { executionAuthority: { mode: "approved_plan" as const, grantedAt: updatedAt, planRevision: workflowPlanRevision(current), artifactDigest } } : {}),
              updatedAt,
              error: null,
            }),
            lastActivityAt: updatedAt,
          };
          yield* persist();
          if (session.snapshot.status === "working") {
            session.workflowDispatchPending = true;
          } else {
            yield* dispatchWorkflowPhaseWithRecovery(session);
          }
          return cloneSession(session.snapshot);
        }
        if (input.action === "intervene") {
          const feedback = input.feedback.trim();
          const acceptsGuidance = isAutonomousWorkflowPhase(current.phase)
            || current.phase === "defining"
            || current.phase === "planning"
            || current.phase === "blocked" && Boolean(current.blockedFromPhase);
          if (!acceptsGuidance) return yield* unavailable("Guidance is unavailable in this workflow phase");
          const submittedAt = now();
          const guidanceId = input.mutationId ?? randomUUID();
          const commandId = `workflow:${current.id}:guidance:${guidanceId}`;
          if (input.scopeChange === true && current.executionAuthority) {
            const previousProgress = current.progress;
            const superseded = {
              planRevision: workflowPlanRevision(current),
              completedSliceIds: previousProgress?.completedSliceIds ?? [],
              passedCriterionIds: previousProgress?.passedCriterionIds ?? [],
              evidence: previousProgress?.evidence ?? [],
              supersededAt: submittedAt,
              reason: feedback,
            };
            const nextPlanRevision = workflowPlanRevision(current) + 1;
            const nextSupersededRevisions = appendBoundedSupersededRevision(current.supersededRevisions, superseded);
            if (!nextSupersededRevisions) return yield* unavailable("This workflow has reached its retained superseded-evidence limit; start a replacement workflow rather than discarding prior evidence");
            const scopeGuidance = {
              id: guidanceId,
              text: feedback,
              status: "queued" as const,
              planRevision: nextPlanRevision,
              submittedRuntimeId: session.snapshot.runtimeId,
              commandId,
              submittedAt,
              deliveredAt: null,
              appliedAt: null,
            };
            const carriedGuidance = (current.guidance ?? []).map((item) => item.status === "applied"
              ? item
              : { ...item, applicationPlanRevision: nextPlanRevision });
            const nextGuidance = appendBoundedWorkflowGuidance(carriedGuidance, scopeGuidance);
            if (!nextGuidance) return yield* unavailable("This workflow has reached the 64-item durable guidance limit");
            const { executionAuthority: _authority, phaseRun: _phaseRun, ...unapproved } = current;
            const progress = initialWorkflowProgress(submittedAt, "waiting_internal", current.dossier);
            // TODO(tracer): Route scope-changing guidance through Define → Research once specification revisions own a replacement research-question set; this narrow slice leaves the existing replacement-Plan authority path unchanged.
            const replanning = withProcessedMutation({
              ...unapproved,
              phase: "planning" as const,
              blockedFromPhase: null,
              revision: workflowRevision(current) + 1,
              artifactRevision: nextPlanRevision,
              guidance: nextGuidance,
              supersededRevisions: nextSupersededRevisions,
              progress: { ...progress, activity: "Approved execution paused for a scope or authority revision", nextAction: "Deliver the scope revision to Plan, then request a new Approve & Run", lastCheckpointSummary: current.checkpoint?.summary ?? null },
              openQuestions: [],
              updatedAt: submittedAt,
              error: null,
            });
            session.snapshot = { ...session.snapshot, workflow: replanning, lastActivityAt: submittedAt };
            yield* persist();
            yield* stopWorkflowSupervisor(current);
            if (session.snapshot.status === "working") {
              session.workflowDispatchPending = true;
              yield* request(session, { id: `workflow:${current.id}:scope-change:${guidanceId}`, type: "abort" }).pipe(Effect.catch(() => Effect.void));
            } else {
              yield* dispatchWorkflowPhaseWithRecovery(session);
            }
            return cloneSession(session.snapshot);
          }
          const guidance = {
            id: guidanceId,
            text: feedback,
            status: "queued" as const,
            planRevision: workflowPlanRevision(current),
            submittedRuntimeId: session.snapshot.runtimeId,
            commandId,
            submittedAt,
            deliveredAt: null,
            appliedAt: null,
          };
          const nextGuidance = appendBoundedWorkflowGuidance(current.guidance, guidance);
          if (!nextGuidance) return yield* unavailable("This workflow has reached the 64-item durable guidance limit");
          const withGuidance = withProcessedMutation({
            ...current,
            revision: workflowRevision(current) + 1,
            guidance: nextGuidance,
            progress: current.progress ? { ...current.progress, nextAction: "Apply queued operator guidance at the next safe boundary", lastActivityAt: submittedAt } : current.progress,
            updatedAt: submittedAt,
          });
          session.snapshot = { ...session.snapshot, workflow: withGuidance, lastActivityAt: submittedAt };
          yield* persist();
          if (session.snapshot.status === "working" && current.phase !== "blocked" && workflowHasActiveCurrentPhaseRun(current)) {
            yield* request(session, {
              id: commandId,
              type: "steer",
              message: `[Workflow guidance ${guidanceId} — ${current.phase.toUpperCase()}]\n\n${feedback}\n\nAcknowledge application by including this guidance ID in your next piss_workflow_progress or checkpoint call.`,
            });
            session.acceptedCommandIds.add(commandId);
            const deliveredAt = now();
            const latest = session.snapshot.workflow;
            if (latest?.id === current.id) {
              const delivery: WorkflowGuidanceDeliveryEvent = { eventId: `guidance-delivered:${commandId}`, guidanceId, commandId, planRevision: guidance.planRevision, deliveredAt };
              const deliveredWorkflow = recordWorkflowGuidanceDelivery(latest, delivery);
              session.snapshot = { ...session.snapshot, workflow: deliveredWorkflow, lastActivityAt: deliveredAt };
              appendEvent(session, "workflow_guidance_delivery", { workflowId: latest.id, event: delivery }, true);
              yield* persist();
            }
          } else if (current.phase !== "blocked" && !session.workflowDispatchPending
            && (isAutonomousWorkflowPhase(current.phase) || current.phase === "defining" || current.phase === "planning")) {
            yield* dispatchWorkflowPhaseWithRecovery(session);
          }
          return cloneSession(session.snapshot);
        }
        if (input.action === "revise") {
          const phase: EngineeringWorkflowPhase = current.phase === "awaitingSpecApproval"
            ? "defining"
            : current.phase === "awaitingPlanApproval"
              ? "planning"
              : current.phase;
          if (phase === current.phase) return yield* unavailable("Only a specification or plan awaiting approval can be revised");
          const updatedAt = now();
          session.snapshot = { ...session.snapshot, workflow: withProcessedMutation({ ...current, phase, revision: workflowRevision(current) + 1, artifactRevision: (current.artifactRevision ?? 0) + 1, updatedAt, error: null }), lastActivityAt: updatedAt };
          yield* persist();
          yield* dispatchWorkflowPhaseWithRecovery(session, input.feedback.trim());
          return cloneSession(session.snapshot);
        }
        if (input.action === "resume") {
          const interruptedCancellation = current.phase === "cancelled" && current.error?.includes("runtime stopped");
          if (!interruptedCancellation && current.supervisor?.lastAdvice?.action === "human_authority_required" && !input.feedback?.trim()) {
            return yield* unavailable("Provide the exact non-secret human input before resuming this workflow");
          }
          const recoveryPhase = interruptedCancellation ? interruptedWorkflowRecoveryPhase(current) : current.blockedFromPhase;
          if ((current.phase !== "blocked" && !interruptedCancellation) || !recoveryPhase) return yield* unavailable("This workflow is not resumable");
          if (!isAutonomousWorkflowPhase(recoveryPhase)
            && recoveryPhase !== "defining"
            && recoveryPhase !== "planning"
            && recoveryPhase !== "awaitingSpecApproval"
            && recoveryPhase !== "awaitingPlanApproval"
            && recoveryPhase !== "readyToShip") {
            return yield* unavailable("This workflow must be revised or cancelled");
          }
          const updatedAt = now();
          const workflow = withProcessedMutation({
            ...current,
            phase: recoveryPhase,
            blockedFromPhase: null,
            revision: workflowRevision(current) + 1,
            ...(current.supervisor ? { supervisor: { ...current.supervisor, status: "idle" as const, pendingGuidance: null } } : {}),
            updatedAt,
            error: null,
          });
          session.snapshot = { ...session.snapshot, workflow, lastActivityAt: updatedAt };
          yield* persist();
          if (isAutonomousWorkflowPhase(recoveryPhase) || recoveryPhase === "defining" || recoveryPhase === "planning") {
            yield* dispatchWorkflowPhaseWithRecovery(session, input.feedback?.trim(), interruptedCancellation);
          }
          return cloneSession(session.snapshot);
        }
        return yield* unavailable("Unsupported workflow action");
      }))),
    );

    const refreshConfiguration = (session: MutableOwnedSession) =>
      request(session, { type: "get_state" }).pipe(
        Effect.map((response) => {
          const data = stateData(response);
          session.snapshot = {
            ...session.snapshot,
            model: availableModel(data?.model) ?? null,
            thinkingLevel: thinkingLevel(data?.thinkingLevel),
            lastActivityAt: now(),
          };
          return cloneSession(session.snapshot);
        }),
        Effect.tap(() => persist()),
      );

    const searchMentions: PiRuntimeSupervisorShape["searchMentions"] = (target, query) => Effect.gen(function* () {
      const session = yield* resolveTarget(target);
      if (TERMINAL_STATUSES.has(session.snapshot.status)) {
        return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "File mentions are unavailable after the session stops" }));
      }
      const workspace = yield* workspaces.findById(session.snapshot.workspaceId);
      if (!workspace) return yield* Effect.fail(new WorkspaceNotFoundError({ workspaceId: session.snapshot.workspaceId }));
      return yield* fileMentions.search(workspace.root, query);
    });

    const listModels = (target: RuntimeTarget) =>
      resolveTarget(target).pipe(
        Effect.flatMap((session) => request(session, { type: "get_available_models" })),
        Effect.map((response) => {
          const models = stateData(response)?.models;
          if (!Array.isArray(models)) return [];
          return models.slice(0, 2_000).flatMap((model) => {
            const projected = availableModel(model);
            return projected ? [projected] : [];
          }).sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
        }),
      );

    const listCommands = (target: RuntimeTarget) =>
      resolveTarget(target).pipe(
        Effect.flatMap((session) => request(session, { type: "get_commands" })),
        Effect.map((response) => {
          const commands = stateData(response)?.commands;
          if (!Array.isArray(commands)) return [];
          return commands.slice(0, 2_000).flatMap((command) => {
            const projected = slashCommand(command);
            return projected ? [projected] : [];
          });
        }),
      );

    const setModel = (target: RuntimeTarget, provider: string, modelId: string) =>
      resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          if (!canConfigureSession(session.snapshot.status)) {
            return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Wait for Pi to finish before changing model" }));
          }
          yield* request(session, { type: "set_model", provider, modelId });
          return yield* refreshConfiguration(session);
        }))),
      );

    const setThinkingLevel = (target: RuntimeTarget, level: ThinkingLevel) =>
      resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          if (!canConfigureSession(session.snapshot.status)) {
            return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Wait for Pi to finish before changing thinking level" }));
          }
          yield* request(session, { type: "set_thinking_level", level });
          return yield* refreshConfiguration(session);
        }))),
      );

    const refreshUsage = (target: RuntimeTarget) => resolveTarget(target).pipe(
      Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
        const [statsResponse, stateResponse] = yield* Effect.all([
          request(session, { type: "get_session_stats" }),
          request(session, { type: "get_state" }),
        ]);
        const usage = sessionUsage(stateData(statsResponse));
        if (!usage) return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Pi returned invalid session statistics" }));
        const state = stateData(stateResponse);
        session.snapshot = {
          ...session.snapshot,
          usage,
          autoCompactionEnabled: typeof state?.autoCompactionEnabled === "boolean" ? state.autoCompactionEnabled : session.snapshot.autoCompactionEnabled,
          pendingMessageCount: nonNegativeInteger(state?.pendingMessageCount) ?? session.snapshot.pendingMessageCount,
          lastActivityAt: now(),
        };
        yield* persist();
        return cloneSession(session.snapshot);
      }))),
    );

    const compact = (target: RuntimeTarget) => resolveTarget(target).pipe(
      Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
        if (!canConfigureSession(session.snapshot.status)) {
          return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Compaction is available only while Pi is idle" }));
        }
        session.snapshot = { ...session.snapshot, compaction: { status: "running", reason: "manual", tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: now() } };
        yield* persist();
        const response = yield* request(session, { type: "compact" }).pipe(
          Effect.tapError((error) => Effect.sync(() => {
            session.snapshot = { ...session.snapshot, compaction: { ...session.snapshot.compaction, status: "failed", error: error.message, updatedAt: now() } };
          }).pipe(Effect.andThen(persist()))),
        );
        const result = stateData(response);
        session.snapshot = {
          ...session.snapshot,
          compaction: {
            status: "succeeded",
            reason: "manual",
            tokensBefore: nonNegativeInteger(result?.tokensBefore) ?? null,
            estimatedTokensAfter: nonNegativeInteger(result?.estimatedTokensAfter) ?? null,
            error: null,
            updatedAt: now(),
          },
          usage: session.snapshot.usage ? {
            ...session.snapshot.usage,
            contextUsage: session.snapshot.usage.contextUsage ? { ...session.snapshot.usage.contextUsage, tokens: null, percent: null } : null,
            updatedAt: now(),
          } : null,
        };
        yield* persist();
        return cloneSession(session.snapshot);
      }))),
    );

    const setAutoCompaction = (target: RuntimeTarget, enabled: boolean) => resolveTarget(target).pipe(
      Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
        if (!canConfigureSession(session.snapshot.status)) {
          return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "Automatic compaction can be changed only while Pi is idle" }));
        }
        yield* request(session, { type: "set_auto_compaction", enabled });
        session.snapshot = { ...session.snapshot, autoCompactionEnabled: enabled, lastActivityAt: now() };
        yield* persist();
        return cloneSession(session.snapshot);
      }))),
    );

    return PiRuntimeSupervisor.of({
      create,
      import: importSession,
      list: Effect.sync(() => [...sessions.values()].map((session) => cloneSession(session.snapshot))),
      listSummaries: Effect.sync(() => [...sessions.values()].map((session) => summarizeSession(session.snapshot))),
      awaitUpdateSafe: Effect.gen(function* () {
        while ([...sessions.values()].some((session) => !isSessionUpdateSafe(session.snapshot, session.pending.size))) {
          yield* Effect.sleep("250 millis");
        }
      }),
      workspaceCounts: Effect.sync(() => {
        const counts = new Map<string, { sessions: number; active: number }>();
        for (const session of sessions.values()) {
          const current = counts.get(session.snapshot.workspaceId) ?? { sessions: 0, active: 0 };
          counts.set(session.snapshot.workspaceId, {
            sessions: current.sessions + 1,
            active: current.active + (session.child && session.child.exitCode === null && session.child.signalCode === null ? 1 : 0),
          });
        }
        return counts;
      }),
      get,
      timelinePage,
      toolOutput,
      subscribe,
      rename: (target, name) => resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          const previous = session.snapshot;
          session.snapshot = { ...session.snapshot, name };
          yield* persist().pipe(Effect.tapError(() => Effect.sync(() => { session.snapshot = previous; })));
          return cloneSession(session.snapshot);
        }))),
      ),
      acknowledge: (target) => resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          const status = transitionAttentionState(session.snapshot.status, "acknowledged");
          if (status !== session.snapshot.status) {
            session.snapshot = { ...session.snapshot, status, lastActivityAt: now() };
            yield* persist();
          }
          return cloneSession(session.snapshot);
        }))),
      ),
      respondInteractive: (target, input) => resolveTarget(target).pipe(
        Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
          const pending = session.snapshot.interactiveRequests[0];
          if (!pending || pending.id !== input.requestId) {
            return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "This interactive request is no longer active" }));
          }
          let response: Record<string, unknown>;
          if (input.cancelled === true) response = { id: pending.id, cancelled: true };
          else if (pending.method === "confirm" && typeof input.confirmed === "boolean") response = { id: pending.id, confirmed: input.confirmed };
          else if (pending.method === "select" && typeof input.value === "string" && pending.options?.includes(input.value)) response = { id: pending.id, value: input.value };
          else if ((pending.method === "input" || pending.method === "editor") && typeof input.value === "string") response = { id: pending.id, value: input.value };
          else return yield* Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message: "The interactive response does not match the pending request" }));
          yield* Effect.tryPromise({
            try: () => writeInteractiveResponse(session, response),
            catch: (cause) => new PiCommandError({ sessionId: session.snapshot.id, message: "Could not answer the Pi interactive request", cause }),
          });
          const timer = session.interactiveTimers.get(pending.id);
          if (timer) clearTimeout(timer);
          session.interactiveTimers.delete(pending.id);
          const interactiveRequests = session.snapshot.interactiveRequests.slice(1);
          session.snapshot = {
            ...session.snapshot,
            interactiveRequests,
            status: interactiveRequests.length > 0 ? "blocked" : transitionAttentionState(session.snapshot.status, "interactiveResolved"),
            lastActivityAt: now(),
            error: null,
          };
          yield* persist();
          return cloneSession(session.snapshot);
        }))),
      ),
      resume,
      reviewWorkspace: (target) => resolveTarget(target).pipe(Effect.map((session) => ({
        workspaceId: session.snapshot.workspaceId,
        device: session.workspaceIdentity.device,
        inode: session.workspaceIdentity.inode,
      }))),
      removeWorkspace,
      listModels,
      listCommands,
      searchMentions,
      setModel,
      setThinkingLevel,
      refreshUsage,
      compact,
      setAutoCompaction,
      mutateWorkflow,
      prompt: (target, text, images, commandId) => sendText(target, "prompt", text, images, commandId),
      steer: (target, text, images, commandId) => sendText(target, "steer", text, images, commandId),
      followUp: (target, text, images, commandId) => sendText(target, "follow_up", text, images, commandId),
      abort: (target) => resolveTarget(target).pipe(
        Effect.flatMap((session) => Effect.gen(function* () {
          // Release an HTTP submission waiting on an extension command before
          // asking Pi to abort. RPC abort does not cancel command handlers that
          // are blocked in unsupported terminal-only UI.
          failPending(session, "Pi command was aborted before it acknowledged the request", undefined, "prompt");
          const workflow = session.snapshot.workflow;
          if (workflow && !isTerminalWorkflowPhase(workflow.phase)) {
            const updatedAt = now();
            session.workflowDispatchPending = false;
            session.snapshot = {
              ...session.snapshot,
              workflow: { ...workflow, phase: "cancelled", blockedFromPhase: null, updatedAt, error: "The workflow was cancelled when its run was aborted" },
              lastActivityAt: updatedAt,
            };
            yield* persist();
          }
          yield* request(session, { type: "abort" });
        })),
        Effect.asVoid,
      ),
      stop: (target) =>
        resolveTarget(target).pipe(
          Effect.flatMap((session) => {
            if (TERMINAL_STATUSES.has(session.snapshot.status)) return Effect.void;
            session.resumeAfterRestart = false;
            session.resumeRunAfterRestart = false;
            const workflow = session.snapshot.workflow;
            const interruptedRequests = session.snapshot.interactiveRequests.length;
            for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
            session.interactiveTimers.clear();
            session.snapshot = {
              ...session.snapshot,
              status: transitionAttentionState(session.snapshot.status, "stopRequested"),
              interactiveRequests: [],
              lastActivityAt: now(),
              error: interruptedRequests > 0 ? `${interruptedRequests} pending interactive request${interruptedRequests === 1 ? " was" : "s were"} cancelled when the runtime stopped` : session.snapshot.error,
              workflow: workflow && !isTerminalWorkflowPhase(workflow.phase)
                ? { ...workflow, phase: "blocked", blockedFromPhase: workflow.phase === "blocked" ? workflow.blockedFromPhase : workflow.phase, updatedAt: now(), error: "The workflow paused because its runtime stopped" }
                : workflow,
            };
            failPending(session, "Pi runtime was stopped");
            return terminate(session).pipe(
              Effect.tap(() => Effect.sync(() => {
                session.snapshot = { ...session.snapshot, status: "stopped", pid: null, lastActivityAt: now() };
                session.child = null;
              })),
              Effect.andThen(persist()),
            );
          }),
        ),
      remove: (target) =>
        resolveTarget(target).pipe(
          Effect.flatMap((session) => session.mutationLock.withPermit(Effect.gen(function* () {
            if (sessions.get(session.snapshot.id) !== session) {
              return yield* Effect.fail(new SessionNotFoundError({ sessionId: session.snapshot.id }));
            }
            const sessionId = session.snapshot.id;
            removingSessionIds.add(sessionId);
            yield* Effect.gen(function* () {
              if (!TERMINAL_STATUSES.has(session.snapshot.status)) {
                session.resumeAfterRestart = false;
                session.resumeRunAfterRestart = false;
                for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
                session.interactiveTimers.clear();
                session.snapshot = {
                  ...session.snapshot,
                  status: transitionAttentionState(session.snapshot.status, "stopRequested"),
                  interactiveRequests: [],
                  lastActivityAt: now(),
                };
                failPending(session, "Pi runtime was archived");
              }
              yield* terminate(session);
              if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
                return yield* Effect.fail(new PiCommandError({
                  sessionId,
                  message: "Pi process exit could not be confirmed; the session remains supervised",
                }));
              }
              session.child = null;
              yield* removeTimeline(sessionId);
              sessions.delete(sessionId);
              yield* persist();
              if (![...sessions.values()].some((candidate) => candidate.snapshot.workspaceId === session.snapshot.workspaceId)) {
                const workspace = yield* workspaces.findById(session.snapshot.workspaceId);
                if (workspace) yield* fileMentions.release(workspace.root);
              }
            }).pipe(Effect.ensuring(Effect.sync(() => removingSessionIds.delete(sessionId))));
          }))),
        ),
    });
  }),
);
