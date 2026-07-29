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
  PiSlashCommandListResponse,
  ReviewSnapshotResponse,
  WorkspaceListResponse,
  type CreateOwnedSessionInput,
  type CreateWorkspaceInput,
  type ImageInput,
  type OwnedSessionCommandAction,
  type ThinkingLevel,
} from "../../shared/domain.ts";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

function responseJson(response: Response): Effect.Effect<unknown, ApiError> {
  return Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new ApiError({ message: "The server returned invalid JSON", status: response.status, cause }),
  });
}

function request(path: string, init?: RequestInit): Effect.Effect<unknown, ApiError> {
  return Effect.tryPromise({
    try: () => fetch(path, { cache: "no-store", signal: AbortSignal.timeout(15_000), ...init }),
    catch: (cause) => new ApiError({ message: "Could not reach the control plane", cause }),
  }).pipe(
    Effect.flatMap((response) =>
      responseJson(response).pipe(
        Effect.flatMap((body) => {
          if (response.ok) return Effect.succeed(body);
          const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
            ? body.error
            : `The server responded with ${response.status}`;
          return Effect.fail(new ApiError({ message, status: response.status }));
        }),
      ),
    ),
  );
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

export function subscribeSession(
  sessionId: string,
  afterSequence: number | undefined,
  onSession: (response: OwnedSessionDetailResponse, sequence: number) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  const query = afterSequence === undefined ? "" : `?afterSequence=${encodeURIComponent(afterSequence)}`;
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events${query}`);
  const onEvent = (event: Event) => {
    try {
      const message = event as MessageEvent<string>;
      const response = Schema.decodeUnknownSync(OwnedSessionDetailResponse)(JSON.parse(message.data));
      const sequence = Number(message.lastEventId);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Session event cursor is invalid");
      onConnectionChange?.(true);
      onSession(response, sequence);
    } catch {
      onConnectionChange?.(false);
    }
  };
  const onError = () => onConnectionChange?.(false);
  source.addEventListener("session", onEvent);
  source.addEventListener("error", onError);
  return () => {
    source.removeEventListener("session", onEvent);
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
  }).pipe(Effect.asVoid);
}
