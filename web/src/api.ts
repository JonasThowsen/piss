import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AvailableModelListResponse,
  CreateOwnedSessionResponse,
  CreateWorkspaceResponse,
  DirectorySearchResponse,
  FileMentionSearchResponse,
  NotificationCapabilityResponse,
  OwnedSessionDetailResponse,
  OwnedSessionListResponse,
  OwnedSessionStreamResponse,
  OwnedSessionTimelinePageResponse,
  OwnedSessionToolOutputResponse,
  PiSlashCommandListResponse,
  ReviewSnapshotResponse,
  WorkspaceListResponse,
  type CreateOwnedSessionInput,
  type CreateWorkspaceInput,
  type EngineeringWorkflowMutationInput,
  type ImageInput,
  type OwnedSessionCommandAction,
  type ThinkingLevel,
} from "../../shared/domain.ts";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}> {}

const RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const TRANSIENT_RESPONSE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function requestLabel(path: string, method: string): string {
  return `${method} ${path.split("?", 1)[0]}`;
}

function interrupted(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

async function requestOnce(path: string, init: RequestInit, method: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError({
      message: "Could not reach the control plane",
      cause,
      retryable: !interrupted(cause),
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiError({
      message: `The response from ${requestLabel(path, method)} was interrupted`,
      status: response.status,
      cause,
      retryable: !interrupted(cause),
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch (cause) {
    const retryable = TRANSIENT_RESPONSE_STATUSES.has(response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "an unknown content type";
    const message = retryable
      ? `The server is temporarily unavailable (${response.status})`
      : `Expected JSON from ${requestLabel(path, method)}, but received ${contentType} (${response.status})`;
    throw new ApiError({ message, status: response.status, cause, retryable });
  }

  if (response.ok) return body;
  const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error
    : `The server responded with ${response.status}`;
  throw new ApiError({ message, status: response.status, retryable: TRANSIENT_RESPONSE_STATUSES.has(response.status) });
}

function request(path: string, init?: RequestInit, policy?: { readonly retryTransient?: boolean }): Effect.Effect<unknown, ApiError> {
  return Effect.tryPromise({
    try: async () => {
      const method = init?.method?.toUpperCase() ?? "GET";
      const mayRetry = policy?.retryTransient === true || method === "GET" || method === "HEAD";
      const signal = init?.signal ?? AbortSignal.timeout(15_000);
      const requestInit = { cache: "no-store" as const, ...init, signal };
      let attempt = 0;
      while (true) {
        try {
          return await requestOnce(path, requestInit, method);
        } catch (cause) {
          if (!(cause instanceof ApiError) || !cause.retryable || !mayRetry || attempt >= RETRY_DELAYS_MS.length) throw cause;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt++]));
        }
      }
    },
    catch: (cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The API request failed", cause }),
  });
}

export const loadNotificationCapability = request("/api/notifications").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(NotificationCapabilityResponse)),
  Effect.mapError((cause) => cause instanceof ApiError
    ? cause
    : new ApiError({ message: "The notification capability did not match its schema", cause })),
);

export function updatePushSubscription(input: unknown) {
  return request("/api/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).pipe(Effect.asVoid);
}

export const loadWorkspaces = request("/api/workspaces").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceListResponse)),
  Effect.mapError((cause) => cause instanceof ApiError
    ? cause
    : new ApiError({ message: "The workspace response did not match its schema", cause })),
);

export function searchDirectories(query: string) {
  return request(`/api/directories?query=${encodeURIComponent(query)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DirectorySearchResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The directory response did not match its schema", cause })),
  );
}

export function createWorkspace(input: CreateWorkspaceInput) {
  return request("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CreateWorkspaceResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The created workspace did not match its schema", cause })),
  );
}

export function renameWorkspace(workspaceId: string, name: string) {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CreateWorkspaceResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The renamed workspace did not match its schema", cause })),
  );
}

export function deleteWorkspace(workspaceId: string) {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" }).pipe(Effect.asVoid);
}

export const loadSessions = request("/api/sessions").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionListResponse)),
  Effect.mapError((cause) => cause instanceof ApiError
    ? cause
    : new ApiError({ message: "The session response did not match its schema", cause })),
);

export function loadSession(sessionId: string, afterSequence?: number) {
  const query = afterSequence === undefined ? "" : `?afterSequence=${encodeURIComponent(afterSequence)}`;
  return request(`/api/sessions/${encodeURIComponent(sessionId)}${query}`, { signal: AbortSignal.timeout(30_000) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The session detail did not match its schema", cause })),
  );
}

export function loadTimelinePage(sessionId: string, beforeSequence: number, limit = 100) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/timeline?beforeSequence=${encodeURIComponent(beforeSequence)}&limit=${encodeURIComponent(limit)}`, { signal: AbortSignal.timeout(30_000) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionTimelinePageResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The timeline page did not match its schema", cause })),
  );
}

export function loadToolOutput(sessionId: string, ref: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(30_000) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionToolOutputResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The tool output did not match its schema", cause })),
  );
}

export function subscribeSession(
  sessionId: string,
  afterSequence: number | undefined,
  onSession: (response: OwnedSessionStreamResponse, sequence: number) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  const query = afterSequence === undefined ? "" : `?afterSequence=${encodeURIComponent(afterSequence)}`;
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events${query}`);
  let validated = false;
  let heartbeatTimer = 0;
  const armHeartbeatTimeout = () => {
    window.clearTimeout(heartbeatTimer);
    heartbeatTimer = window.setTimeout(() => {
      validated = false;
      onConnectionChange?.(false);
    }, 35_000);
  };
  const onEvent = (event: Event) => {
    try {
      const message = event as MessageEvent<string>;
      const response = Schema.decodeUnknownSync(OwnedSessionStreamResponse)(JSON.parse(message.data));
      const sequence = Number(message.lastEventId);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Session event cursor is invalid");
      onSession(response, sequence);
      validated = true;
      armHeartbeatTimeout();
      onConnectionChange?.(true);
    } catch {
      validated = false;
      onConnectionChange?.(false);
    }
  };
  const onHeartbeat = () => {
    if (validated) armHeartbeatTimeout();
  };
  const onError = () => {
    validated = false;
    window.clearTimeout(heartbeatTimer);
    onConnectionChange?.(false);
  };
  source.addEventListener("session", onEvent);
  source.addEventListener("heartbeat", onHeartbeat);
  source.addEventListener("error", onError);
  return () => {
    window.clearTimeout(heartbeatTimer);
    source.removeEventListener("session", onEvent);
    source.removeEventListener("heartbeat", onHeartbeat);
    source.removeEventListener("error", onError);
    source.close();
  };
}

export function renameOwnedSession(sessionId: string, runtimeId: string, name: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId, name }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The renamed session did not match its schema", cause })),
  );
}

export function archiveOwnedSession(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}?runtimeId=${encodeURIComponent(runtimeId)}`, {
    method: "DELETE",
  }).pipe(Effect.asVoid);
}

export function createOwnedSession(input: CreateOwnedSessionInput) {
  return request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CreateOwnedSessionResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The created session did not match its schema", cause })),
  );
}

export function searchFileMentions(sessionId: string, runtimeId: string, query: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/mentions?runtimeId=${encodeURIComponent(runtimeId)}&query=${encodeURIComponent(query)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FileMentionSearchResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The file mention response did not match its schema", cause })),
  );
}

export function loadReview(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/review?runtimeId=${encodeURIComponent(runtimeId)}`, { signal: AbortSignal.timeout(30_000) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ReviewSnapshotResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The Git review did not match its schema", cause })),
  );
}

export function loadAvailableModels(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/models?runtimeId=${encodeURIComponent(runtimeId)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AvailableModelListResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The model catalog did not match its schema", cause })),
  );
}

export function loadSlashCommands(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/commands?runtimeId=${encodeURIComponent(runtimeId)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PiSlashCommandListResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The Pi command catalog did not match its schema", cause })),
  );
}

export function loadSessionUsage(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/stats?runtimeId=${encodeURIComponent(runtimeId)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The session statistics did not match their schema", cause })),
  );
}

export function compactSession(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5 * 60_000),
    body: JSON.stringify({ runtimeId, action: "compact" }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The compacted session did not match its schema", cause })),
  );
}

export function setSessionAutoCompaction(sessionId: string, runtimeId: string, enabled: boolean) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId, action: "setAutoCompaction", enabled }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The automatic compaction setting did not match its schema", cause })),
  );
}

export function setSessionModel(input: {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly provider: string;
  readonly modelId: string;
}) {
  return request(`/api/sessions/${encodeURIComponent(input.sessionId)}/configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId: input.runtimeId, action: "setModel", provider: input.provider, modelId: input.modelId }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The configured session did not match its schema", cause })),
  );
}

export function setSessionThinkingLevel(input: {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly level: ThinkingLevel;
}) {
  return request(`/api/sessions/${encodeURIComponent(input.sessionId)}/configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId: input.runtimeId, action: "setThinkingLevel", level: input.level }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The configured session did not match its schema", cause })),
  );
}

export function mutateEngineeringWorkflow(sessionId: string, input: EngineeringWorkflowMutationInput) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5 * 60_000),
    body: JSON.stringify(input),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The engineering workflow response did not match its schema", cause })),
  );
}

export function respondToInteractiveRequest(input: {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly requestId: string;
  readonly cancelled?: boolean;
  readonly value?: string;
  readonly confirmed?: boolean;
}) {
  return request(`/api/sessions/${encodeURIComponent(input.sessionId)}/interactive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The interactive response did not match its schema", cause })),
  );
}

export function acknowledgeOwnedSession(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/acknowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The acknowledged session did not match its schema", cause })),
  );
}

export function resumeOwnedSession(sessionId: string, runtimeId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeId }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionDetailResponse)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ message: "The resumed session did not match its schema", cause })),
  );
}

export function sendSessionCommand(input: {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly commandId?: string;
  readonly action: OwnedSessionCommandAction;
  readonly text?: string;
  readonly images?: ReadonlyArray<ImageInput>;
}) {
  return request(`/api/sessions/${encodeURIComponent(input.sessionId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ runtimeId: input.runtimeId, commandId: input.commandId, action: input.action, text: input.text, images: input.images }),
  }, {
    // The supervisor persists accepted content-command IDs, so a replay after a
    // gateway interruption cannot enqueue the same prompt twice.
    retryTransient: input.action === "prompt" || input.action === "steer" || input.action === "followUp",
  }).pipe(Effect.asVoid);
}
