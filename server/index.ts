import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { browserUser, defaultDevOrigins, validBrowserOrigin, type BrowserAuthConfig } from "./browser-auth.ts";
import { eventsAfter } from "./event-replay.ts";
import {
  MAX_IMAGE_BYTES,
  PROTOCOL_VERSION,
  isBridgeToServer,
  isBrowserToServer,
  validateImages,
  type BridgeToServer,
  type BrowserToServer,
  type ServerToBridge,
  type ServerToBrowser,
  type SessionEvent,
  type SessionInfo,
} from "../shared/protocol.ts";

const HOST = process.env.PISS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PISS_PORT ?? "4317");
const DEV_BYPASS = process.env.PISS_DEV_BYPASS_AUTH === "1";
const DEV_WEB_PORT = Number(process.env.PISS_DEV_WEB_PORT ?? "5173");
const ALLOWED_USERS = new Set((process.env.PISS_ALLOWED_USERS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const configuredDevOrigins = new Set((process.env.PISS_DEV_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const browserAuth: BrowserAuthConfig = {
  devBypass: DEV_BYPASS,
  allowedUsers: ALLOWED_USERS,
  devAllowedOrigins: configuredDevOrigins.size > 0 ? configuredDevOrigins : defaultDevOrigins(DEV_WEB_PORT),
};
const STATE_DIR = process.env.PISS_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "piss");
const TOKEN_FILE = process.env.PISS_BRIDGE_TOKEN_FILE ?? join(STATE_DIR, "bridge-token");
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const MAX_EVENTS = 750;
const MAX_EVENT_BUFFER_BYTES = 8 * 1024 * 1024;
const OFFLINE_RETENTION_MS = 5 * 60_000;
const MAX_SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 250;

if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
  throw new Error("PISS only permits a loopback bind; use its private Tailscale node for remote access");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PISS_PORT");
if (!Number.isInteger(DEV_WEB_PORT) || DEV_WEB_PORT < 1 || DEV_WEB_PORT > 65535) throw new Error("Invalid PISS_DEV_WEB_PORT");
if (DEV_BYPASS && process.env.NODE_ENV === "production") throw new Error("Development auth bypass is forbidden with NODE_ENV=production");

interface LiveSession {
  info: SessionInfo;
  bridge?: WebSocket;
  snapshot: unknown[];
  events: SessionEvent[];
  eventBytes: number;
  sequence: number;
  offlineTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, LiveSession>();
const browsers = new Set<WebSocket>();
const browserSubscriptions = new Map<WebSocket, string>();
const pendingCommands = new Map<string, { browser: WebSocket; timer: NodeJS.Timeout; kind: "command" | "review" }>();
const bridgeSessions = new Map<WebSocket, string>();
const liveness = new WeakMap<WebSocket, boolean>();
const commandWindows = new WeakMap<WebSocket, number[]>();
const lastReviewAt = new WeakMap<WebSocket, number>();

await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
await chmod(STATE_DIR, 0o700);
let bridgeToken: string;
try {
  bridgeToken = (await readFile(TOKEN_FILE, "utf8")).trim();
  if (bridgeToken.length < 32) throw new Error("token too short");
} catch {
  bridgeToken = randomBytes(32).toString("base64url");
  await writeFile(TOKEN_FILE, `${bridgeToken}\n`, { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    bridgeToken = (await readFile(TOKEN_FILE, "utf8")).trim();
  });
}
await chmod(TOKEN_FILE, 0o600);
const bridgeTokenHash = createHash("sha256").update(bridgeToken).digest();

function send(ws: WebSocket, message: ServerToBrowser | ServerToBridge) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    ws.close(1013, "client is not keeping up");
    return;
  }
  ws.send(JSON.stringify(message));
}

function publicSessions(): SessionInfo[] {
  return [...sessions.values()]
    .map((session) => session.info)
    .sort((a, b) => Number(a.state === "offline") - Number(b.state === "offline") || b.lastActivity - a.lastActivity);
}

function broadcastSessions() {
  const message: ServerToBrowser = { type: "sessions.updated", sessions: publicSessions() };
  for (const browser of browsers) send(browser, message);
}

function bridgeAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const candidate = createHash("sha256").update(authorization.slice(7)).digest();
  return candidate.length === bridgeTokenHash.length && timingSafeEqual(candidate, bridgeTokenHash);
}

function parseJson(raw: Buffer | ArrayBuffer | Buffer[]): unknown {
  const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
  return JSON.parse(text);
}

function handleBridgeMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]) {
  let parsed: unknown;
  try { parsed = parseJson(raw); } catch { ws.close(1003, "invalid JSON"); return; }
  if (!isBridgeToServer(parsed)) { ws.close(1008, "invalid bridge message"); return; }
  const message: BridgeToServer = parsed;

  if (message.type === "bridge.hello") {
    if (message.protocolVersion !== PROTOCOL_VERSION) { ws.close(1002, "protocol mismatch"); return; }
    const previousId = bridgeSessions.get(ws);
    if (previousId && previousId !== message.session.sessionId) sessions.get(previousId)!.bridge = undefined;
    const existing = sessions.get(message.session.sessionId);
    if (existing?.offlineTimer) clearTimeout(existing.offlineTimer);
    if (existing?.bridge && existing.bridge !== ws) existing.bridge.close(4001, "runtime replaced");
    sessions.set(message.session.sessionId, {
      info: { ...message.session, state: message.session.state, lastActivity: Date.now() },
      bridge: ws,
      snapshot: message.snapshot.slice(-MAX_SNAPSHOT_ENTRIES),
      events: existing?.info.runtimeId === message.session.runtimeId ? existing.events : [],
      eventBytes: existing?.info.runtimeId === message.session.runtimeId ? existing.eventBytes : 0,
      sequence: existing?.info.runtimeId === message.session.runtimeId ? existing.sequence : 0,
    });
    bridgeSessions.set(ws, message.session.sessionId);
    broadcastSessions();
    return;
  }

  if (message.type === "bridge.command_result") {
    const pending = pendingCommands.get(message.commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCommands.delete(message.commandId);
    if (pending.kind === "review") {
      send(pending.browser, { type: "review.result", requestId: message.commandId, ok: message.ok, review: message.review, error: message.error });
    } else {
      send(pending.browser, { type: "command.result", commandId: message.commandId, ok: message.ok, error: message.error });
    }
    return;
  }

  const sessionId = bridgeSessions.get(ws);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.info.runtimeId !== message.runtimeId) return;
  session.sequence += 1;
  session.info.lastActivity = message.timestamp;
  if (message.event === "agent.started") session.info.state = "streaming";
  if (message.event === "agent.settled") session.info.state = "idle";
  if (message.event === "session.info" && message.data && typeof message.data === "object") {
    const update = message.data as Partial<SessionInfo>;
    session.info = {
      ...session.info,
      ...(typeof update.name === "string" || update.name === undefined ? { name: update.name } : {}),
      ...(typeof update.cwd === "string" ? { cwd: update.cwd } : {}),
      ...(typeof update.model === "string" || update.model === undefined ? { model: update.model } : {}),
      ...(typeof update.thinkingLevel === "string" || update.thinkingLevel === undefined ? { thinkingLevel: update.thinkingLevel } : {}),
      lastActivity: message.timestamp,
    };
  }
  if (message.event === "message.completed") {
    const data = message.data as { message?: unknown };
    if (data?.message) {
      session.snapshot.push({ type: "message", message: data.message });
      if (session.snapshot.length > MAX_SNAPSHOT_ENTRIES) session.snapshot.splice(0, session.snapshot.length - MAX_SNAPSHOT_ENTRIES);
    }
  }
  const event: SessionEvent = {
    sequence: session.sequence,
    runtimeId: session.info.runtimeId,
    event: message.event,
    data: message.data,
    timestamp: message.timestamp,
  };
  session.events.push(event);
  session.eventBytes += Buffer.byteLength(JSON.stringify(event));
  while (session.events.length > MAX_EVENTS || session.eventBytes > MAX_EVENT_BUFFER_BYTES) {
    const removed = session.events.shift();
    if (!removed) break;
    session.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
  }
  for (const browser of browsers) {
    if (browserSubscriptions.get(browser) === sessionId) send(browser, { type: "session.event", sessionId: sessionId!, event });
  }
  if (message.event.startsWith("agent.") || message.event === "session.info") broadcastSessions();
}

function handleBrowserMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]) {
  let parsed: unknown;
  try { parsed = parseJson(raw); } catch { send(ws, { type: "server.error", error: "Invalid JSON" }); return; }
  if (!isBrowserToServer(parsed)) { send(ws, { type: "server.error", error: "Invalid message" }); return; }
  const message: BrowserToServer = parsed;
  if (message.type === "browser.ping") { send(ws, { type: "server.pong" }); return; }

  if (message.type === "browser.subscribe") {
    const session = sessions.get(message.sessionId);
    if (!session) { send(ws, { type: "server.error", error: "Session not found" }); return; }
    browserSubscriptions.set(ws, message.sessionId);
    const replay = message.runtimeId === session.info.runtimeId && message.after !== undefined
      ? eventsAfter(session.events, session.sequence, message.after)
      : undefined;
    if (replay !== undefined) {
      for (const event of replay) send(ws, { type: "session.event", sessionId: message.sessionId, event });
      send(ws, { type: "session.resumed", session: session.info, sequence: session.sequence });
    } else {
      send(ws, { type: "session.snapshot", session: session.info, entries: session.snapshot, sequence: session.sequence });
    }
    return;
  }

  if (message.type === "browser.archive") {
    const session = sessions.get(message.sessionId);
    if (!session || session.info.runtimeId !== message.runtimeId) {
      send(ws, { type: "server.error", error: "Offline session no longer exists" });
      return;
    }
    if (session.bridge || session.info.state !== "offline") {
      send(ws, { type: "server.error", error: "Only offline sessions can be archived" });
      return;
    }
    if (session.offlineTimer) clearTimeout(session.offlineTimer);
    sessions.delete(message.sessionId);
    for (const [browser, subscribedSessionId] of browserSubscriptions) {
      if (subscribedSessionId === message.sessionId) browserSubscriptions.delete(browser);
    }
    broadcastSessions();
    return;
  }

  if (message.type === "browser.review_request") {
    const now = Date.now();
    if (now - (lastReviewAt.get(ws) ?? 0) < 3_000) {
      send(ws, { type: "review.result", requestId: message.requestId, ok: false, error: "Wait before refreshing the review" });
      return;
    }
    lastReviewAt.set(ws, now);
    const session = sessions.get(message.sessionId);
    if (!session?.bridge || session.bridge.readyState !== WebSocket.OPEN || session.info.runtimeId !== message.runtimeId) {
      send(ws, { type: "review.result", requestId: message.requestId, ok: false, error: "Pi session is offline or has changed" });
      return;
    }
    if (pendingCommands.has(message.requestId)) {
      send(ws, { type: "review.result", requestId: message.requestId, ok: false, error: "Duplicate review request ID" });
      return;
    }
    const timer = setTimeout(() => {
      pendingCommands.delete(message.requestId);
      send(ws, { type: "review.result", requestId: message.requestId, ok: false, error: "Pi did not return the review in time" });
    }, 30_000);
    pendingCommands.set(message.requestId, { browser: ws, timer, kind: "review" });
    send(session.bridge, {
      type: "bridge.command",
      commandId: message.requestId,
      runtimeId: message.runtimeId,
      action: "review",
    });
    return;
  }

  const now = Date.now();
  const recentCommands = (commandWindows.get(ws) ?? []).filter((timestamp) => now - timestamp < 10_000);
  if (recentCommands.length >= 30) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Command rate limit exceeded" });
    return;
  }
  recentCommands.push(now);
  commandWindows.set(ws, recentCommands);
  if ((message.text?.length ?? 0) > 512 * 1024) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Message exceeds 512 KiB" });
    return;
  }
  const session = sessions.get(message.sessionId);
  if (!session?.bridge || session.bridge.readyState !== WebSocket.OPEN) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Pi session is offline" });
    return;
  }
  if (session.info.runtimeId !== message.runtimeId) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Session runtime changed; refresh before sending" });
    return;
  }
  const imageError = validateImages(message.images);
  if (imageError) { send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: imageError }); return; }
  if (message.action !== "abort" && !message.text?.trim() && !message.images?.length) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Message is empty" });
    return;
  }
  if (pendingCommands.has(message.commandId)) {
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Duplicate command ID" });
    return;
  }
  const timer = setTimeout(() => {
    pendingCommands.delete(message.commandId);
    send(ws, { type: "command.result", commandId: message.commandId, ok: false, error: "Pi did not acknowledge the command" });
  }, 10_000);
  pendingCommands.set(message.commandId, { browser: ws, timer, kind: "command" });
  send(session.bridge, {
    type: "bridge.command",
    commandId: message.commandId,
    runtimeId: message.runtimeId,
    action: message.action,
    text: message.text,
    images: message.images,
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

function json(response: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

async function serveStatic(request: IncomingMessage, response: ServerResponse) {
  if (!browserUser(request, browserAuth)) { json(response, 401, { error: "Tailscale identity required" }); return; }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  let path = resolve(PUBLIC_DIR, requested);
  const outsidePublicDirectory = relative(PUBLIC_DIR, path).startsWith("..") || resolve(path) === resolve(PUBLIC_DIR);
  if (outsidePublicDirectory) { response.writeHead(404).end(); return; }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not file");
  } catch {
    path = join(PUBLIC_DIR, "index.html");
  }
  try {
    const info = await stat(path);
    response.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": path.endsWith("index.html") || path.endsWith("service-worker.js") || path.endsWith("manifest.webmanifest") ? "no-cache" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "strict-transport-security": "max-age=31536000",
      "referrer-policy": "no-referrer",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
  } catch { response.writeHead(503).end("Web client is not built. Run npm run build.\n"); }
}

const server = createServer((request, response) => {
  if (request.url === "/api/health") { json(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION }); return; }
  void serveStatic(request, response);
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const browserWss = new WebSocketServer({ noServer: true, maxPayload: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/bridge" && bridgeAuthorized(request)) {
    bridgeWss.handleUpgrade(request, socket, head, (ws) => bridgeWss.emit("connection", ws, request));
  } else if (pathname === "/api/ws" && browserUser(request, browserAuth) && validBrowserOrigin(request, browserAuth)) {
    browserWss.handleUpgrade(request, socket, head, (ws) => browserWss.emit("connection", ws, request));
  } else {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

bridgeWss.on("connection", (ws) => {
  liveness.set(ws, true);
  ws.on("pong", () => liveness.set(ws, true));
  ws.on("message", (raw) => handleBridgeMessage(ws, raw as Buffer));
  ws.on("close", () => {
    const sessionId = bridgeSessions.get(ws);
    bridgeSessions.delete(ws);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || session.bridge !== ws) return;
    session.bridge = undefined;
    session.info.state = "offline";
    session.info.lastActivity = Date.now();
    session.offlineTimer = setTimeout(() => { sessions.delete(sessionId!); broadcastSessions(); }, OFFLINE_RETENTION_MS);
    broadcastSessions();
  });
});

browserWss.on("connection", (ws, request) => {
  browsers.add(ws);
  liveness.set(ws, true);
  ws.on("pong", () => liveness.set(ws, true));
  send(ws, { type: "server.hello", user: browserUser(request, browserAuth)!, sessions: publicSessions() });
  ws.on("message", (raw) => handleBrowserMessage(ws, raw as Buffer));
  ws.on("close", () => {
    browsers.delete(ws);
    browserSubscriptions.delete(ws);
    for (const [commandId, pending] of pendingCommands) {
      if (pending.browser !== ws) continue;
      clearTimeout(pending.timer);
      pendingCommands.delete(commandId);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of [...bridgeWss.clients, ...browserWss.clients]) {
    if (!liveness.get(ws)) {
      ws.terminate();
      continue;
    }
    if (ws.readyState === WebSocket.OPEN) {
      liveness.set(ws, false);
      ws.ping();
    }
  }
}, 20_000);
heartbeat.unref();

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  clearInterval(heartbeat);
  for (const pending of pendingCommands.values()) clearTimeout(pending.timer);
  for (const ws of [...bridgeWss.clients, ...browserWss.clients]) ws.close(1001, "server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`PISS listening on http://${HOST}:${PORT}`);
  console.log(`Bridge token: ${TOKEN_FILE}`);
  if (DEV_BYPASS) console.warn("Development authentication bypass is enabled; loopback access only.");
  else console.log("Remote access is expected through the independent PISS Tailscale node.");
  if (ALLOWED_USERS.size) console.log(`Allowed Tailscale users: ${[...ALLOWED_USERS].join(", ")}`);
});
