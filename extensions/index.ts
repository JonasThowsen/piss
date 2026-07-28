import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { assistantOutcome, statusFromEntries } from "./agent-status.ts";
import { collectReview } from "./review.ts";
import {
  PROTOCOL_VERSION,
  THINKING_LEVELS,
  isServerToBridge,
  validateImages,
  type AgentStatus,
  type AvailableModel,
  type BridgeToServer,
  type ImageInput,
  type ServerToBridge,
  type SessionInfo,
  type ThinkingLevel,
} from "../shared/protocol.ts";

const BROKER_URL = process.env.PISS_BRIDGE_URL ?? "ws://127.0.0.1:4317/bridge";
const TOKEN_FILE = process.env.PISS_BRIDGE_TOKEN_FILE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "piss", "bridge-token");
const MAX_RECONNECT_MS = 10_000;
const MAX_SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 250;

function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? typeof mapped === "string" : true;
  });
}

function publicModel(model: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): AvailableModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning === true,
    thinkingLevels: supportedThinkingLevels(model),
  };
}

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
  if (process.env.PISS_V2_OWNED_RUNTIME === "1") return;

  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = 250;
  let connectionGeneration = 0;
  let connecting = false;
  let runtimeId = "";
  let startedAt = 0;
  let branch: string | undefined;
  let status: AgentStatus = "idle";
  let statusChangedAt = 0;
  let settledStatus: AgentStatus = "finished";
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
    branch,
    sessionFile: ctx.sessionManager.getSessionFile(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    state: ctx.isIdle() ? "idle" : "streaming",
    status,
    statusChangedAt,
    startedAt,
    lastActivity: Date.now(),
  });

  const detectBranch = async (ctx: ExtensionContext): Promise<string | undefined> => {
    try {
      const named = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ctx.cwd, timeout: 2_000 });
      if (named.code === 0 && named.stdout.trim()) return named.stdout.trim();
      const detached = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd: ctx.cwd, timeout: 2_000 });
      return detached.code === 0 && detached.stdout.trim() ? `detached@${detached.stdout.trim()}` : undefined;
    } catch {
      return;
    }
  };

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

  const handleCommand = async (message: ServerToBridge) => {
    if (message.type !== "bridge.command" || message.runtimeId !== runtimeId || !context) return;
    try {
      if (message.action === "review") {
        const review = await collectReview(pi, context.cwd);
        send({ type: "bridge.command_result", commandId: message.commandId, ok: true, review });
        return;
      }
      if (message.action === "list_models") {
        await context.modelRegistry.refresh();
        const models = context.modelRegistry.getAvailable()
          .map(publicModel)
          .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
        send({ type: "bridge.command_result", commandId: message.commandId, ok: true, models });
        return;
      }
      if (message.action === "set_model") {
        if (!context.isIdle()) throw new Error("Wait for the agent to finish before changing model");
        await context.modelRegistry.refresh();
        const model = context.modelRegistry.find(message.provider!, message.modelId!);
        if (!model || !context.modelRegistry.getAvailable().some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
          throw new Error("Model is unavailable or has no configured authentication");
        }
        if (!await pi.setModel(model)) throw new Error("Model authentication is unavailable");
        send({
          type: "bridge.command_result",
          commandId: message.commandId,
          ok: true,
          model: `${model.provider}/${model.id}`,
          thinkingLevel: pi.getThinkingLevel(),
        });
        return;
      }
      if (message.action === "set_thinking_level") {
        if (!context.isIdle()) throw new Error("Wait for the agent to finish before changing effort");
        pi.setThinkingLevel(message.thinkingLevel!);
        send({
          type: "bridge.command_result",
          commandId: message.commandId,
          ok: true,
          thinkingLevel: pi.getThinkingLevel(),
        });
        return;
      }
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
    if (stopped || socket || connecting) return;
    const generation = connectionGeneration;
    connecting = true;
    try {
      const token = (await readFile(TOKEN_FILE, "utf8")).trim();
      if (stopped || generation !== connectionGeneration) return;
      if (!token) throw new Error("empty bridge token");
      const candidate = new WebSocket(BROKER_URL, {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: 16 * 1024 * 1024,
      });
      if (stopped || generation !== connectionGeneration) { candidate.close(); return; }
      socket = candidate;
      candidate.on("open", () => {
        if (generation !== connectionGeneration || stopped) { candidate.close(); return; }
        reconnectDelay = 250;
        sendHello();
      });
      candidate.on("message", (raw) => {
        if (generation !== connectionGeneration || stopped) return;
        try {
          const message: unknown = JSON.parse(raw.toString());
          if (isServerToBridge(message)) void handleCommand(message);
        } catch {
          // Invalid broker messages are ignored; authentication already happened.
        }
      });
      candidate.on("error", () => candidate.close());
      candidate.on("close", () => {
        if (socket === candidate) socket = undefined;
        if (generation === connectionGeneration) scheduleReconnect();
      });
    } catch {
      if (generation === connectionGeneration) {
        socket = undefined;
        scheduleReconnect();
      }
    } finally {
      if (generation === connectionGeneration) connecting = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    connecting = false;
    stopped = false;
    context = ctx;
    runtimeId = randomUUID();
    startedAt = Date.now();
    branch = undefined;
    ({ status, changedAt: statusChangedAt } = statusFromEntries(ctx.sessionManager.getBranch(), startedAt));
    settledStatus = "finished";
    reconnectDelay = 250;
    branch = await detectBranch(ctx);
    if (stopped || generation !== connectionGeneration) return;
    await connect();
  });

  pi.on("session_shutdown", () => {
    connectionGeneration += 1;
    connecting = false;
    stopped = true;
    context = undefined;
    branch = undefined;
    status = "idle";
    statusChangedAt = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (updateTimer) clearTimeout(updateTimer);
    reconnectTimer = undefined;
    updateTimer = undefined;
    socket?.close(1000, "session shutdown");
    socket = undefined;
  });

  pi.on("agent_start", () => {
    status = "working";
    statusChangedAt = Date.now();
    settledStatus = "finished";
    sendEvent("agent.started", { status });
  });
  pi.on("agent_settled", async () => {
    status = settledStatus;
    statusChangedAt = Date.now();
    sendEvent("agent.settled", { status });
    const ctx = context;
    const generation = connectionGeneration;
    if (!ctx) return;
    const nextBranch = await detectBranch(ctx);
    if (stopped || generation !== connectionGeneration || context !== ctx || nextBranch === branch) return;
    branch = nextBranch;
    sendEvent("session.info", sessionInfo(ctx));
  });
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
    settledStatus = assistantOutcome(event.message) ?? settledStatus;
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
