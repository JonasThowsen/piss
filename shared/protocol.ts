export const PROTOCOL_VERSION = 1 as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type Delivery = "prompt" | "steer" | "followUp";

export interface SessionInfo {
  sessionId: string;
  runtimeId: string;
  pid: number;
  cwd: string;
  name?: string;
  sessionFile?: string;
  model?: string;
  thinkingLevel?: string;
  state: "idle" | "streaming" | "offline";
  startedAt: number;
  lastActivity: number;
}

export interface ImageInput {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

export type BridgeHello = {
  type: "bridge.hello";
  protocolVersion: 1;
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
};

export type ServerToBridge = {
  type: "bridge.command";
  commandId: string;
  runtimeId: string;
  action: "prompt" | "steer" | "followUp" | "abort" | "snapshot";
  text?: string;
  images?: ImageInput[];
};

export type SessionEvent = {
  sequence: number;
  runtimeId: string;
  event: string;
  data: unknown;
  timestamp: number;
};

export type BrowserToServer =
  | { type: "browser.subscribe"; sessionId: string; after?: number }
  | { type: "browser.command"; commandId: string; sessionId: string; runtimeId: string; action: Delivery | "abort"; text?: string; images?: ImageInput[] }
  | { type: "browser.ping" };

export type ServerToBrowser =
  | { type: "server.hello"; user: string; sessions: SessionInfo[] }
  | { type: "sessions.updated"; sessions: SessionInfo[] }
  | { type: "session.snapshot"; session: SessionInfo; entries: unknown[]; sequence: number }
  | { type: "session.event"; sessionId: string; event: SessionEvent }
  | { type: "command.result"; commandId: string; ok: boolean; error?: string }
  | { type: "server.pong" }
  | { type: "server.error"; error: string };

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
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
