export const PROTOCOL_VERSION = 2 as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type Delivery = "prompt" | "steer" | "followUp";

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface NotificationCapability {
  supported: boolean;
  vapidPublicKey?: string;
}

export type AgentStatus = "working" | "idle" | "blocked" | "finished";

export interface SessionInfo {
  sessionId: string;
  runtimeId: string;
  pid: number;
  cwd: string;
  name?: string;
  branch?: string;
  sessionFile?: string;
  model?: string;
  thinkingLevel?: string;
  state: "idle" | "streaming" | "offline";
  status?: AgentStatus;
  statusChangedAt?: number;
  startedAt: number;
  lastActivity: number;
}

export interface ImageInput {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

export interface ReviewFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

export interface ReviewSnapshot {
  cwd: string;
  generatedAt: number;
  files: ReviewFile[];
  truncated: boolean;
  totalFiles: number;
}

export type BridgeHello = {
  type: "bridge.hello";
  protocolVersion: 2;
  session: SessionInfo;
  snapshot: unknown[];
};

export type BridgeEvent = {
  type: "bridge.event";
  runtimeId: string;
  event: string;
  data: unknown;
  timestamp: number;
};

export type BridgeToServer = BridgeHello | BridgeEvent | {
  type: "bridge.command_result";
  commandId: string;
  ok: boolean;
  error?: string;
  review?: ReviewSnapshot;
  models?: AvailableModel[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
};

export type ServerToBridge = {
  type: "bridge.command";
  commandId: string;
  runtimeId: string;
  action: "prompt" | "steer" | "followUp" | "abort" | "snapshot" | "review" | "list_models" | "set_model" | "set_thinking_level";
  text?: string;
  images?: ImageInput[];
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type SessionEvent = {
  sequence: number;
  runtimeId: string;
  event: string;
  data: unknown;
  timestamp: number;
};

export type BrowserToServer =
  | { type: "browser.subscribe"; sessionId: string; runtimeId?: string; after?: number }
  | { type: "browser.archive"; sessionId: string; runtimeId: string }
  | { type: "browser.review_request"; requestId: string; sessionId: string; runtimeId: string }
  | { type: "browser.models_request"; requestId: string; sessionId: string; runtimeId: string }
  | { type: "browser.set_model"; requestId: string; sessionId: string; runtimeId: string; provider: string; modelId: string }
  | { type: "browser.set_thinking_level"; requestId: string; sessionId: string; runtimeId: string; level: ThinkingLevel }
  | { type: "browser.push_subscribe"; subscription: BrowserPushSubscription }
  | { type: "browser.push_unsubscribe"; endpoint: string }
  | { type: "browser.command"; commandId: string; sessionId: string; runtimeId: string; action: Delivery | "abort"; text?: string; images?: ImageInput[] }
  | { type: "browser.ping" };

export type ServerToBrowser =
  | { type: "server.hello"; user: string; sessions: SessionInfo[]; notifications: NotificationCapability }
  | { type: "sessions.updated"; sessions: SessionInfo[] }
  | { type: "session.snapshot"; session: SessionInfo; entries: unknown[]; sequence: number }
  | { type: "session.event"; sessionId: string; event: SessionEvent }
  | { type: "session.resumed"; session: SessionInfo; sequence: number }
  | { type: "command.result"; commandId: string; ok: boolean; error?: string }
  | { type: "review.result"; requestId: string; ok: boolean; review?: ReviewSnapshot; error?: string }
  | { type: "models.result"; requestId: string; ok: boolean; models?: AvailableModel[]; error?: string }
  | { type: "notifications.updated"; enabled: boolean; error?: string }
  | { type: "server.pong" }
  | { type: "server.error"; error: string };

const DELIVERY_ACTIONS = new Set(["prompt", "steer", "followUp", "abort"]);
const BRIDGE_COMMAND_ACTIONS = new Set(["prompt", "steer", "followUp", "abort", "snapshot", "review", "list_models", "set_model", "set_thinking_level"]);
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const BRIDGE_EVENTS = new Set([
  "agent.started",
  "agent.settled",
  "message.started",
  "message.updated",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "session.info",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

function isPushSubscription(value: unknown): value is BrowserPushSubscription {
  if (!isRecord(value) || !isBoundedString(value.endpoint, 4096) || !value.endpoint.startsWith("https://") || !isRecord(value.keys)) return false;
  return (value.expirationTime === undefined || value.expirationTime === null || isFiniteTimestamp(value.expirationTime)) &&
    isBoundedString(value.keys.p256dh, 512) && isBoundedString(value.keys.auth, 512);
}

function isAvailableModel(value: unknown): value is AvailableModel {
  return isRecord(value) && isBoundedString(value.provider, 256) && isBoundedString(value.id, 1024) &&
    isBoundedString(value.name, 1024) && typeof value.reasoning === "boolean" &&
    Array.isArray(value.thinkingLevels) && value.thinkingLevels.length <= THINKING_LEVELS.length &&
    value.thinkingLevels.every(isThinkingLevel);
}

function hasValidImages(value: unknown): value is ImageInput[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 4) return false;
  return value.every((image) =>
    isRecord(image) &&
    typeof image.mediaType === "string" && isImageMediaType(image.mediaType) &&
    typeof image.data === "string" &&
    (image.name === undefined || isBoundedString(image.name, 255, true))
  );
}

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

export function isServerToBridge(value: unknown): value is ServerToBridge {
  if (!isRecord(value) || value.type !== "bridge.command" || !isBoundedString(value.commandId, 128) ||
    !isBoundedString(value.runtimeId, 128) || typeof value.action !== "string" || !BRIDGE_COMMAND_ACTIONS.has(value.action)) return false;
  if (value.action === "set_model") return isBoundedString(value.provider, 256) && isBoundedString(value.modelId, 1024);
  if (value.action === "set_thinking_level") return isThinkingLevel(value.thinkingLevel);
  return (value.text === undefined || isBoundedString(value.text, 512 * 1024, true)) && hasValidImages(value.images);
}

export function isBrowserToServer(value: unknown): value is BrowserToServer {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "browser.ping") return true;
  if (value.type === "browser.subscribe") {
    return isBoundedString(value.sessionId, 512) &&
      (value.runtimeId === undefined || isBoundedString(value.runtimeId, 128)) &&
      (value.after === undefined || (Number.isSafeInteger(value.after) && Number(value.after) >= 0));
  }
  if (value.type === "browser.archive") {
    return isBoundedString(value.sessionId, 512) && isBoundedString(value.runtimeId, 128);
  }
  if (value.type === "browser.review_request" || value.type === "browser.models_request") {
    return isBoundedString(value.requestId, 128) && isBoundedString(value.sessionId, 512) &&
      isBoundedString(value.runtimeId, 128);
  }
  if (value.type === "browser.set_model") {
    return isBoundedString(value.requestId, 128) && isBoundedString(value.sessionId, 512) &&
      isBoundedString(value.runtimeId, 128) && isBoundedString(value.provider, 256) && isBoundedString(value.modelId, 1024);
  }
  if (value.type === "browser.set_thinking_level") {
    return isBoundedString(value.requestId, 128) && isBoundedString(value.sessionId, 512) &&
      isBoundedString(value.runtimeId, 128) && isThinkingLevel(value.level);
  }
  if (value.type === "browser.push_subscribe") return isPushSubscription(value.subscription);
  if (value.type === "browser.push_unsubscribe") return isBoundedString(value.endpoint, 4096);
  if (value.type !== "browser.command") return false;
  return isBoundedString(value.commandId, 128) &&
    isBoundedString(value.sessionId, 512) &&
    isBoundedString(value.runtimeId, 128) &&
    typeof value.action === "string" && DELIVERY_ACTIONS.has(value.action) &&
    (value.text === undefined || isBoundedString(value.text, 512 * 1024, true)) &&
    hasValidImages(value.images);
}

export function isReviewSnapshot(value: unknown): value is ReviewSnapshot {
  if (!isRecord(value) || !isBoundedString(value.cwd, 16 * 1024) || !isFiniteTimestamp(value.generatedAt) ||
    typeof value.truncated !== "boolean" || !Number.isSafeInteger(value.totalFiles) || Number(value.totalFiles) < 0 ||
    !Array.isArray(value.files) || value.files.length > 100) return false;
  return value.files.every((file) =>
    isRecord(file) && isBoundedString(file.path, 16 * 1024) &&
    isBoundedString(file.indexStatus, 1, true) && isBoundedString(file.worktreeStatus, 1, true) &&
    isBoundedString(file.patch, 256 * 1024, true) &&
    typeof file.truncated === "boolean" && typeof file.binary === "boolean"
  );
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) return false;
  return isBoundedString(value.sessionId, 512) &&
    isBoundedString(value.runtimeId, 128) &&
    Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
    isBoundedString(value.cwd, 16 * 1024) &&
    (value.name === undefined || isBoundedString(value.name, 1024, true)) &&
    (value.branch === undefined || isBoundedString(value.branch, 1024)) &&
    (value.sessionFile === undefined || isBoundedString(value.sessionFile, 16 * 1024, true)) &&
    (value.model === undefined || isBoundedString(value.model, 1024, true)) &&
    (value.thinkingLevel === undefined || isBoundedString(value.thinkingLevel, 64, true)) &&
    (value.state === "idle" || value.state === "streaming" || value.state === "offline") &&
    (value.status === undefined || value.status === "working" || value.status === "idle" || value.status === "blocked" || value.status === "finished") &&
    (value.statusChangedAt === undefined || isFiniteTimestamp(value.statusChangedAt)) &&
    isFiniteTimestamp(value.startedAt) && isFiniteTimestamp(value.lastActivity);
}

export function isBridgeToServer(value: unknown): value is BridgeToServer {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "bridge.hello") {
    return value.protocolVersion === PROTOCOL_VERSION && isSessionInfo(value.session) &&
      Array.isArray(value.snapshot) && value.snapshot.length <= 10_000;
  }
  if (value.type === "bridge.command_result") {
    return isBoundedString(value.commandId, 128) && typeof value.ok === "boolean" &&
      (value.error === undefined || isBoundedString(value.error, 4096, true)) &&
      (value.review === undefined || isReviewSnapshot(value.review)) &&
      (value.models === undefined || (Array.isArray(value.models) && value.models.length <= 2_000 && value.models.every(isAvailableModel))) &&
      (value.model === undefined || isBoundedString(value.model, 1024, true)) &&
      (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel));
  }
  if (value.type !== "bridge.event") return false;
  return isBoundedString(value.runtimeId, 128) &&
    typeof value.event === "string" && BRIDGE_EVENTS.has(value.event) &&
    isFiniteTimestamp(value.timestamp);
}

export function decodedBase64Bytes(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) return Number.POSITIVE_INFINITY;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

export function sniffImageMediaType(data: string): ImageMediaType | undefined {
  try {
    const bytes = Uint8Array.from(atob(data.slice(0, 32)), (character) => character.charCodeAt(0));
    const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  } catch {
    return;
  }
}

export function validateImages(images: ImageInput[] | undefined): string | undefined {
  if (!images) return;
  if (images.length > 4) return "At most four images may be attached";
  let total = 0;
  for (const image of images) {
    if (!isImageMediaType(image.mediaType)) return `Unsupported image type: ${image.mediaType}`;
    const size = decodedBase64Bytes(image.data);
    if (!Number.isFinite(size) || size === 0) return "Malformed base64 image data";
    if (sniffImageMediaType(image.data) !== image.mediaType) return `Image bytes do not match declared type: ${image.mediaType}`;
    total += size;
  }
  if (total > MAX_IMAGE_BYTES) return "Image attachments exceed the 10 MiB limit";
}
