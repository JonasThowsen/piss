import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import type {
  AvailableModel,
  CreateOwnedSessionInput,
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
  SessionUsage,
  ThinkingLevel,
  Workspace,
  WorkspaceId,
} from "../../shared/domain.ts";
import { canAcceptPrompt, canConfigureSession, transitionAttentionState } from "../../shared/sessionState.ts";
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
import { loadOwnedSessions, persistOwnedSessions, type PersistedOwnedSession } from "./OwnedSessionStore.ts";
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
const TERMINATE_TIMEOUT_MS = 2_000;
const TERMINAL_STATUSES: ReadonlySet<OwnedSessionStatus> = new Set(["stopped", "crashed"]);
const MONOTONIC_STATUSES: ReadonlySet<OwnedSessionStatus> = new Set(["stopping", "stopped", "crashed"]);

type RpcMessage = Record<string, unknown> & { readonly type: string };
type CommandResume = (effect: Effect.Effect<RpcMessage, PiCommandError>) => void;

interface PendingCommand {
  readonly command: string;
  readonly resume: CommandResume;
  readonly timer: NodeJS.Timeout;
}

interface MutableOwnedSession {
  snapshot: OwnedSession;
  child: ChildProcessWithoutNullStreams | null;
  eventBytes: number;
  sequence: number;
  stderr: string;
  activeRunImageCharacters: number;
  resumeAfterRestart: boolean;
  quarantined: boolean;
  termination?: Promise<void>;
  readonly pending: Map<string, PendingCommand>;
  readonly mutationLock: Semaphore.Semaphore;
  readonly workspaceIdentity: { readonly device: bigint; readonly inode: bigint };
  sessionFileIdentity: { readonly device: bigint; readonly inode: bigint } | null;
  readonly acceptedCommandIds: Set<string>;
  readonly interactiveTimers: Map<string, NodeJS.Timeout>;
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
  readonly setModel: (target: RuntimeTarget, provider: string, modelId: string) => Effect.Effect<OwnedSession, RuntimeCommandError>;
  readonly setThinkingLevel: (target: RuntimeTarget, level: ThinkingLevel) => Effect.Effect<OwnedSession, RuntimeCommandError>;
  readonly refreshUsage: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly compact: (target: RuntimeTarget) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly setAutoCompaction: (target: RuntimeTarget, enabled: boolean) => Effect.Effect<OwnedSession, RuntimeCommandError | SessionStorageError>;
  readonly prompt: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly steer: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly followUp: (target: RuntimeTarget, text: string, images?: ReadonlyArray<ImageInput>, commandId?: string) => Effect.Effect<void, RuntimeCommandError | SessionStorageError>;
  readonly abort: (target: RuntimeTarget) => Effect.Effect<void, RuntimeCommandError>;
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

function cloneSession(session: OwnedSession): OwnedSession {
  return structuredClone(session);
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

function processArguments(workspace: Workspace, name: string, sessionFile?: string): ReadonlyArray<string> {
  return [
    "--mode",
    "rpc",
    "--name",
    name,
    ...(sessionFile ? ["--session", sessionFile] : []),
    workspace.trustProjectResources ? "--approve" : "--no-approve",
  ];
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
    let persistenceTail = Promise.resolve();

    const persistedRecords = (): ReadonlyArray<PersistedOwnedSession> => [...sessions.values()].map((session) => ({
      id: session.snapshot.id,
      runtimeId: session.snapshot.runtimeId,
      workspaceId: session.snapshot.workspaceId,
      name: session.snapshot.name,
      branch: session.snapshot.branch,
      status: session.snapshot.status,
      resumeAfterRestart: session.resumeAfterRestart,
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
      createdAt: session.snapshot.createdAt,
      lastActivityAt: session.snapshot.lastActivityAt,
      error: session.snapshot.error,
      interactiveRequests: session.snapshot.interactiveRequests,
      acceptedCommandIds: [...session.acceptedCommandIds].slice(-128),
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

    const persist = (): Effect.Effect<void, SessionStorageError> => Effect.tryPromise({
      try: () => {
        const snapshot = persistedRecords();
        const next = persistenceTail.then(() => persistOwnedSessions(storagePath, snapshot));
        persistenceTail = next.catch(() => undefined);
        return next;
      },
      catch: (cause) => new SessionStorageError({ message: "Could not persist owned-session metadata", cause }),
    });

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
        await timelinePersistenceTails.get(sessionId);
        timelinePersistenceTails.delete(sessionId);
        await removeOwnedSessionTimeline(timelineDirectory, sessionId);
      },
      catch: (cause) => new SessionStorageError({ message: `Could not remove timeline for session ${sessionId}`, cause }),
    });

    const loaded = yield* Effect.tryPromise({
      try: () => loadOwnedSessions(storagePath),
      catch: (cause) => new SessionStorageError({ message: "Could not load owned-session metadata", cause }),
    });
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
      const mutationLock = yield* Semaphore.make(1);
      const interrupted = record.status !== "stopped" && record.status !== "crashed";
      const interruptedRequestCount = record.interactiveRequests?.length ?? 0;
      const status: OwnedSessionStatus = workspaceChanged || record.status === "crashed" ? "crashed" : "stopped";
      sessions.set(record.id, {
        child: null,
        eventBytes: timeline.events.reduce((total, event) => total + eventBytes(event), 0),
        sequence: timeline.sequence,
        stderr: "",
        activeRunImageCharacters: 0,
        resumeAfterRestart: record.resumeAfterRestart === true && status === "stopped",
        quarantined: status === "crashed",
        pending: new Map(),
        mutationLock,
        workspaceIdentity: expectedWorkspace,
        sessionFileIdentity: record.sessionFileIdentity
          ? { device: BigInt(record.sessionFileIdentity.device), inode: BigInt(record.sessionFileIdentity.inode) }
          : null,
        acceptedCommandIds: new Set(record.acceptedCommandIds),
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
    if (loaded.some((record) => record.status !== "stopped" && record.status !== "crashed" || (record.interactiveRequests?.length ?? 0) > 0)) yield* persist();
    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([...timelinePersistenceTails.values()])).pipe(Effect.asVoid));

    const publishSession = (session: MutableOwnedSession): void => {
      const snapshot = cloneSession(session.snapshot);
      for (const listener of sessionSubscribers.get(snapshot.id) ?? []) {
        try { listener(snapshot); }
        catch (cause) { console.error(`Session subscriber failed for ${snapshot.id}`, cause); }
      }
    };

    const notifyAttention = (session: MutableOwnedSession): void => {
      const status = session.snapshot.status;
      if (status !== "finished" && status !== "blocked" && status !== "crashed") return;
      void Effect.runPromise(notifications.notify(cloneSession(session.snapshot), status)).catch(() => undefined);
    };

    const appendEvent = (session: MutableOwnedSession, type: string, data: unknown): void => {
      if (session.quarantined) return;
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

    const failPending = (session: MutableOwnedSession, message: string, cause?: unknown): void => {
      for (const [id, pending] of session.pending) {
        clearTimeout(pending.timer);
        pending.resume(Effect.fail(new PiCommandError({ sessionId: session.snapshot.id, message, cause })));
        session.pending.delete(id);
      }
    };

    const crash = (session: MutableOwnedSession, error: string, cause?: unknown): void => {
      if (MONOTONIC_STATUSES.has(session.snapshot.status)) return;
      session.resumeAfterRestart = false;
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
      const request = interactiveRequest(message);
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

    const handleLine = (session: MutableOwnedSession, line: string): boolean => {
      if (session.quarantined) return false;
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
      if (message.type === "extension_ui_request") queueInteractiveRequest(session, message);
      if (message.type === "queue_update") {
        const steering = Array.isArray(message.steering) ? message.steering.length : 0;
        const followUp = Array.isArray(message.followUp) ? message.followUp.length : 0;
        session.snapshot = { ...session.snapshot, pendingMessageCount: Math.min(steering + followUp, 10_000), lastActivityAt: now() };
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
      appendEvent(session, message.type, message);
      return true;
    };

    const attach = (session: MutableOwnedSession): void => {
      const child = session.child;
      if (!child) return;
      const framer = new JsonlFramer();
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const line of framer.push(chunk)) {
            if (!handleLine(session, line)) break;
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
            if (!handleLine(session, line)) break;
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

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions.values(),
        (session) => {
          const wasActive = !TERMINAL_STATUSES.has(session.snapshot.status);
          if (wasActive) {
            session.resumeAfterRestart = true;
            session.snapshot = { ...session.snapshot, status: "stopping", lastActivityAt: now() };
          }
          const interruptedRequests = session.snapshot.interactiveRequests.length;
          for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
          session.interactiveTimers.clear();
          session.snapshot = { ...session.snapshot, interactiveRequests: [] };
          failPending(session, "PISS is shutting down");
          return terminate(session).pipe(
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
          );
        },
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.andThen(persist()),
        Effect.catch((cause) => Effect.sync(() => console.error("Could not persist owned sessions during shutdown", cause))),
      ),
    );

    const create: PiRuntimeSupervisorShape["create"] = (input) =>
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
        const child = yield* Effect.try({
          try: () => spawn(config.piCommand, processArguments(workspace, sessionName), {
            cwd: "/proc/self/fd/3",
            detached: true,
            stdio: ["pipe", "pipe", "pipe", rootHandle.fd],
          }) as ChildProcessWithoutNullStreams,
          catch: (cause) => new PiSpawnError({ command: config.piCommand, cause }),
        }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
        const mutationLock = yield* Semaphore.make(1);
        const session: MutableOwnedSession = {
          child,
          eventBytes: 0,
          sequence: 0,
          stderr: "",
          activeRunImageCharacters: 0,
          resumeAfterRestart: false,
          quarantined: false,
          pending: new Map(),
          mutationLock,
          workspaceIdentity: { device: rootStat.dev, inode: rootStat.ino },
          sessionFileIdentity: null,
          acceptedCommandIds: new Set(),
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
        quarantined: false,
        pending: new Map(),
        mutationLock,
        workspaceIdentity: { device: workspaceState.rootStat.dev, inode: workspaceState.rootStat.ino },
        sessionFileIdentity: { device: transcript.device, inode: transcript.inode },
        acceptedCommandIds: new Set(),
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
      session.resumeAfterRestart = false;
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
      const durableTranscript = Boolean(sessionFile && piSessionId && session.sessionFileIdentity);
      const shouldReplayTranscript = durableTranscript && session.snapshot.events.length === 0;
      if (session.sessionFileIdentity && (!sessionFile || !piSessionId)) {
        return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "This session has incomplete transcript metadata" }));
      }
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
      const child = yield* Effect.try({
        try: () => spawn(config.piCommand, processArguments(workspace, session.snapshot.name, durableTranscript ? sessionFile! : undefined), {
          cwd: "/proc/self/fd/3",
          detached: true,
          stdio: ["pipe", "pipe", "pipe", rootHandle.fd],
        }) as ChildProcessWithoutNullStreams,
        catch: (cause) => new PiSpawnError({ command: config.piCommand, cause }),
      }).pipe(Effect.tapError(() => Effect.promise(() => rootHandle.close())));
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
          if (shouldReplayTranscript) {
            const entriesResponse = yield* request(session, { id: `${session.snapshot.id}:resume-entries`, type: "get_entries" });
            const entries = stateData(entriesResponse)?.entries;
            if (!Array.isArray(entries)) {
              return yield* Effect.fail(new SessionResumeError({ sessionId: session.snapshot.id, message: "Pi did not return resumable transcript entries" }));
            }
            for (const entry of entries.slice(-250)) {
              for (const replayed of replayEventsFromTranscriptEntry(entry)) appendEvent(session, replayed.type, replayed.data);
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
          status: data?.isStreaming === true ? "working" : durableTranscript ? "finished" : "idle",
          pid: child.pid ?? null,
          model: availableModel(data?.model) ?? session.snapshot.model,
          thinkingLevel: thinkingLevel(data?.thinkingLevel) ?? session.snapshot.thinkingLevel,
          autoCompactionEnabled: typeof data?.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : session.snapshot.autoCompactionEnabled,
          pendingMessageCount: nonNegativeInteger(data?.pendingMessageCount) ?? 0,
          lastActivityAt: now(),
          error: null,
        };
        yield* persist();
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
            session.snapshot = { ...session.snapshot, status: "working", error: null, lastActivityAt: now() };
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
              if (type === "prompt" && session.snapshot.status === "working") {
                session.snapshot = { ...session.snapshot, status: priorStatus, lastActivityAt: now() };
              }
            }).pipe(Effect.andThen(persist()))),
          );
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
      prompt: (target, text, images, commandId) => sendText(target, "prompt", text, images, commandId),
      steer: (target, text, images, commandId) => sendText(target, "steer", text, images, commandId),
      followUp: (target, text, images, commandId) => sendText(target, "follow_up", text, images, commandId),
      abort: (target) => resolveTarget(target).pipe(Effect.flatMap((session) => request(session, { type: "abort" })), Effect.asVoid),
      stop: (target) =>
        resolveTarget(target).pipe(
          Effect.flatMap((session) => {
            if (TERMINAL_STATUSES.has(session.snapshot.status)) return Effect.void;
            session.resumeAfterRestart = false;
            const interruptedRequests = session.snapshot.interactiveRequests.length;
            for (const timer of session.interactiveTimers.values()) clearTimeout(timer);
            session.interactiveTimers.clear();
            session.snapshot = {
              ...session.snapshot,
              status: transitionAttentionState(session.snapshot.status, "stopRequested"),
              interactiveRequests: [],
              lastActivityAt: now(),
              error: interruptedRequests > 0 ? `${interruptedRequests} pending interactive request${interruptedRequests === 1 ? " was" : "s were"} cancelled when the runtime stopped` : session.snapshot.error,
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
            if (!TERMINAL_STATUSES.has(session.snapshot.status)) {
              session.resumeAfterRestart = false;
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
                sessionId: session.snapshot.id,
                message: "Pi process exit could not be confirmed; the session remains supervised",
              }));
            }
            session.child = null;
            yield* removeTimeline(session.snapshot.id);
            sessions.delete(session.snapshot.id);
            yield* persist();
            if (![...sessions.values()].some((candidate) => candidate.snapshot.workspaceId === session.snapshot.workspaceId)) {
              const workspace = yield* workspaces.findById(session.snapshot.workspaceId);
              if (workspace) yield* fileMentions.release(workspace.root);
            }
          }))),
        ),
    });
  }),
);
