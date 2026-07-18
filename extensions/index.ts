import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  validateImages,
  type BridgeToServer,
  type ImageInput,
  type ServerToBridge,
  type SessionInfo,
} from "../shared/protocol.ts";

const BROKER_URL = process.env.PISS_BRIDGE_URL ?? "ws://127.0.0.1:4317/bridge";
const TOKEN_FILE = process.env.PISS_BRIDGE_TOKEN_FILE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "piss", "bridge-token");
const MAX_RECONNECT_MS = 10_000;
const MAX_SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 250;

function safeValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== "object") return nested;
      const image = nested as Record<string, unknown>;
      if (image.type !== "image") return nested;
      // Browsers only need attachment metadata for history. Never duplicate
      // base64 image bodies into event buffers and snapshots.
      const source = image.source && typeof image.source === "object"
        ? { ...(image.source as Record<string, unknown>), data: undefined }
        : image.source;
      return { ...image, data: undefined, source, redacted: true };
    }));
  } catch {
    return { unavailable: true };
  }
}

export default function pissExtension(pi: ExtensionAPI) {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = 250;
  let runtimeId = "";
  let startedAt = 0;
  let stopped = true;
  let context: ExtensionContext | undefined;
  let pendingUpdate: unknown;
  let updateTimer: NodeJS.Timeout | undefined;

  const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
    sessionId: ctx.sessionManager.getSessionId(),
    runtimeId,
    pid: process.pid,
    cwd: ctx.cwd,
    name: pi.getSessionName(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    state: ctx.isIdle() ? "idle" : "streaming",
    startedAt,
    lastActivity: Date.now(),
  });

  const send = (message: BridgeToServer) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      socket.close(1013, "broker is not keeping up");
      return;
    }
    socket.send(JSON.stringify(message));
  };

  const sendEvent = (event: string, data: unknown) => {
    if (!runtimeId) return;
    send({
      type: "bridge.event",
      runtimeId,
      event,
      data: safeValue(data),
      timestamp: Date.now(),
    });
  };

  const sendHello = () => {
    if (!context) return;
    send({
      type: "bridge.hello",
      protocolVersion: PROTOCOL_VERSION,
      session: sessionInfo(context),
      snapshot: safeValue(context.sessionManager.getBranch().slice(-MAX_SNAPSHOT_ENTRIES)) as unknown[],
    });
  };

  const handleCommand = (message: ServerToBridge) => {
    if (message.type !== "bridge.command" || message.runtimeId !== runtimeId || !context) return;
    try {
      if (message.action === "abort") {
        context.abort();
      } else if (message.action === "snapshot") {
        sendHello();
      } else {
        const imageError = validateImages(message.images);
        if (imageError) throw new Error(imageError);
        const content: string | Array<
          | { type: "text"; text: string }
          | { type: "image"; mimeType: string; data: string }
        > = message.images?.length
          ? [
              ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
              ...message.images.map((image: ImageInput) => ({
                type: "image" as const,
                mimeType: image.mediaType,
                data: image.data,
              })),
            ]
          : (message.text ?? "");
        if (!message.text?.trim() && !message.images?.length) throw new Error("Message is empty");
        const deliverAs = message.action === "prompt" ? undefined : message.action;
        pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
      }
      send({ type: "bridge.command_result", commandId: message.commandId, ok: true });
    } catch (error) {
      send({
        type: "bridge.command_result",
        commandId: message.commandId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  };

  const connect = async () => {
    if (stopped || socket) return;
    try {
      const token = (await readFile(TOKEN_FILE, "utf8")).trim();
      if (!token) throw new Error("empty bridge token");
      const candidate = new WebSocket(BROKER_URL, {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: 16 * 1024 * 1024,
      });
      socket = candidate;
      candidate.on("open", () => {
        reconnectDelay = 250;
        sendHello();
      });
      candidate.on("message", (raw) => {
        try {
          handleCommand(JSON.parse(raw.toString()) as ServerToBridge);
        } catch {
          // Invalid broker messages are ignored; authentication already happened.
        }
      });
      candidate.on("ping", () => candidate.pong());
      candidate.on("error", () => candidate.close());
      candidate.on("close", () => {
        if (socket === candidate) socket = undefined;
        scheduleReconnect();
      });
    } catch {
      socket = undefined;
      scheduleReconnect();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    context = ctx;
    runtimeId = randomUUID();
    startedAt = Date.now();
    reconnectDelay = 250;
    void connect();
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    context = undefined;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (updateTimer) clearTimeout(updateTimer);
    reconnectTimer = undefined;
    updateTimer = undefined;
    socket?.close(1000, "session shutdown");
    socket = undefined;
  });

  pi.on("agent_start", () => sendEvent("agent.started", {}));
  pi.on("agent_settled", () => sendEvent("agent.settled", {}));
  pi.on("message_start", (event) => sendEvent("message.started", { message: event.message }));
  pi.on("message_update", (event) => {
    pendingUpdate = { message: event.message };
    if (!updateTimer) {
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        sendEvent("message.updated", pendingUpdate);
        pendingUpdate = undefined;
      }, 50);
    }
  });
  pi.on("message_end", (event) => {
    // A final message can arrive before the 50 ms update batch flushes. Drop
    // that stale timer so a completed assistant message is not rendered again
    // as an indefinitely "streaming" duplicate in the browser.
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    pendingUpdate = undefined;
    sendEvent("message.completed", { message: event.message });
  });
  pi.on("tool_execution_start", (event) => sendEvent("tool.started", event));
  pi.on("tool_execution_update", (event) => sendEvent("tool.updated", event));
  pi.on("tool_execution_end", (event) => sendEvent("tool.completed", event));
  pi.on("session_info_changed", () => context && sendEvent("session.info", sessionInfo(context)));
  pi.on("model_select", () => context && sendEvent("session.info", sessionInfo(context)));
  pi.on("thinking_level_select", () => context && sendEvent("session.info", sessionInfo(context)));
}
