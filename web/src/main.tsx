import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MAX_IMAGE_BYTES,
  type BrowserToServer,
  type ImageInput,
  type ReviewFile,
  type ReviewSnapshot,
  type ServerToBrowser,
  type SessionEvent,
  type SessionInfo,
} from "../../shared/protocol.ts";
import "./styles.css";

type RawEntry = { type?: string; message?: PiMessage };
type PiMessage = { role?: string; content?: unknown; timestamp?: number; toolName?: string; isError?: boolean };
type ToolActivity = { id: string; name: string; state: "running" | "done"; detail: string; error?: boolean };
type CommandResult = { ok: boolean; error?: string };
type ReviewResultMessage = Extract<ServerToBrowser, { type: "review.result" }>;
type OutboxItem = {
  id: string;
  text: string;
  imageCount: number;
  baselineMessages: number;
  action: "prompt" | "steer" | "followUp";
  status: "sending" | "accepted" | "rejected";
  error?: string;
};
type StoredDraft = { text: string; delivery: "steer" | "followUp"; updatedAt: number };
type ConnectionStatus = "connecting" | "reconnecting" | "online" | "offline";

const DRAFT_PREFIX = "piss:draft:";
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function readDraft(sessionId: string): StoredDraft | undefined {
  try {
    const value = localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`);
    if (!value) return;
    const draft = JSON.parse(value) as Partial<StoredDraft>;
    if (typeof draft.text !== "string") return;
    const updatedAt = typeof draft.updatedAt === "number" ? draft.updatedAt : Date.now();
    if (Date.now() - updatedAt > DRAFT_MAX_AGE) {
      localStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`);
      return;
    }
    return {
      text: draft.text,
      delivery: draft.delivery === "followUp" ? "followUp" : "steer",
      updatedAt,
    };
  } catch {
    return;
  }
}

function writeDraft(sessionId: string, text: string, delivery: "steer" | "followUp") {
  try {
    const key = `${DRAFT_PREFIX}${sessionId}`;
    if (!text) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ text, delivery, updatedAt: Date.now() } satisfies StoredDraft));
  } catch {
    // Storage can be unavailable in strict private-browsing configurations.
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string; name?: string; arguments?: unknown } => !!part && typeof part === "object")
    .map((part) => part.type === "text" ? part.text ?? "" : part.type === "toolCall" ? `Tool · ${part.name ?? "unknown"}` : "")
    .filter(Boolean)
    .join("\n");
}

function imageAttachments(content: unknown): Array<{ mimeType: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "image") return [];
    const image = part as { mimeType?: unknown; source?: { mediaType?: unknown } };
    const mimeType = typeof image.mimeType === "string"
      ? image.mimeType
      : typeof image.source?.mediaType === "string"
        ? image.source.mediaType
        : "image";
    return [{ mimeType }];
  });
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function shortProject(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

function compactDirectory(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

function useSidecarSocket(onMessage: (message: ServerToBrowser) => void) {
  const [status, setStatus] = useState<ConnectionStatus>(navigator.onLine ? "connecting" : "offline");
  const [connectionId, setConnectionId] = useState(0);
  const socket = useRef<WebSocket | undefined>(undefined);
  const callback = useRef(onMessage);
  callback.current = onMessage;

  useEffect(() => {
    let stopped = false;
    let hasConnected = false;
    let retry = 250;
    let reconnectTimer: number | undefined;
    let lastReceivedAt = Date.now();
    let lastWakeAt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    const connect = () => {
      clearReconnectTimer();
      if (stopped || document.visibilityState === "hidden") return;
      if (!navigator.onLine) { setStatus("offline"); return; }
      if (socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return;

      setStatus(hasConnected ? "reconnecting" : "connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/api/ws`);
      socket.current = ws;
      ws.onopen = () => {
        if (socket.current !== ws) { ws.close(); return; }
        hasConnected = true;
        retry = 250;
        lastReceivedAt = Date.now();
        setStatus("online");
        setConnectionId((id) => id + 1);
        ws.send(JSON.stringify({ type: "browser.ping" }));
      };
      ws.onmessage = (event) => {
        if (socket.current !== ws) return;
        lastReceivedAt = Date.now();
        try {
          const message = JSON.parse(event.data) as ServerToBrowser;
          if (message.type !== "server.pong") callback.current(message);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        socket.current = undefined;
        if (stopped) return;
        setStatus(navigator.onLine ? "reconnecting" : "offline");
        if (document.visibilityState !== "hidden" && navigator.onLine) {
          reconnectTimer = window.setTimeout(connect, retry);
          retry = Math.min(retry * 2, 5000);
        }
      };
      ws.onerror = () => ws.close();
    };
    const disconnect = () => {
      clearReconnectTimer();
      const current = socket.current;
      socket.current = undefined;
      if (current && current.readyState < WebSocket.CLOSING) current.close(4000, "app suspended");
    };
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastWakeAt < 500) return;
      lastWakeAt = now;
      retry = 250;
      disconnect();
      setStatus(navigator.onLine ? "reconnecting" : "offline");
      connect();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") {
        disconnect();
        setStatus("reconnecting");
      } else {
        wake();
      }
    };
    const wentOffline = () => { disconnect(); setStatus("offline"); };

    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wentOffline);
    connect();
    const heartbeat = window.setInterval(() => {
      const current = socket.current;
      if (current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastReceivedAt > 30_000) {
        current.close(4002, "heartbeat timed out");
        return;
      }
      current.send(JSON.stringify({ type: "browser.ping" }));
    }, 10_000);
    return () => {
      stopped = true;
      clearReconnectTimer();
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wentOffline);
      disconnect();
    };
  }, []);

  const send = useCallback((message: BrowserToServer) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  return { connected: status === "online", status, connectionId, send };
}

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [entries, setEntries] = useState<RawEntry[]>([]);
  const [liveMessage, setLiveMessage] = useState<PiMessage>();
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [user, setUser] = useState("");
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [commandResults, setCommandResults] = useState<Record<string, CommandResult>>({});
  const [reviewResult, setReviewResult] = useState<ReviewResultMessage>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const lastCompletedMessage = useRef<PiMessage | undefined>(undefined);
  const currentId = useRef<string | undefined>(undefined);
  currentId.current = selectedId;

  const onMessage = useCallback((message: ServerToBrowser) => {
    if (message.type === "server.hello") { setUser(message.user); setSessions(message.sessions); }
    if (message.type === "sessions.updated") setSessions(message.sessions);
    if (message.type === "session.snapshot" && message.session.sessionId === currentId.current) {
      setEntries(message.entries as RawEntry[]); setLiveMessage(undefined); setTools([]); setSyncing(false);
    }
    if (message.type === "session.event" && message.sessionId === currentId.current) { setSyncing(false); handleEvent(message.event); }
    if (message.type === "review.result") setReviewResult(message);
    if (message.type === "command.result") {
      setPending((id) => id === message.commandId ? undefined : id);
      setCommandResults((results) => ({ ...results, [message.commandId]: { ok: message.ok, error: message.error } }));
      if (!message.ok) setNotice(message.error ?? "Command rejected");
    }
    if (message.type === "server.error") setNotice(message.error);
  }, []);

  const { connected, status: connectionStatus, connectionId, send } = useSidecarSocket(onMessage);
  const selected = sessions.find((session) => session.sessionId === selectedId);
  const outputLoading = !!selected && (!connected || syncing);
  const networkState = connectionStatus === "online" ? (syncing && selected ? "syncing" : "live") : connectionStatus;
  const networkLabel = networkState === "live" ? "LIVE OUTPUT"
    : networkState === "syncing" ? "SYNCING OUTPUT"
      : networkState === "offline" ? "DEVICE OFFLINE"
        : networkState === "connecting" ? "CONNECTING" : "RESTORING LINK";
  const selectedName = selected ? selected.name || shortProject(selected.cwd) : undefined;

  useEffect(() => {
    if (!selected) { document.title = "PISS · Pi sin sidecar"; return; }
    const directory = shortProject(selected.cwd);
    document.title = selectedName === directory ? `${directory} · PISS` : `${selectedName} · ${directory} · PISS`;
  }, [selected, selectedName]);

  function handleEvent(event: SessionEvent) {
    const data = event.data as { message?: PiMessage; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean };
    if ((event.event === "message.started" || event.event === "message.updated") && data.message) {
      const completed = lastCompletedMessage.current;
      const isStaleFinalUpdate = completed && data.message.role === completed.role &&
        (data.message.timestamp !== undefined
          ? data.message.timestamp === completed.timestamp
          : textContent(data.message.content) === textContent(completed.content));
      if (!isStaleFinalUpdate) setLiveMessage(data.message);
    }
    if (event.event === "message.completed" && data.message) {
      lastCompletedMessage.current = data.message;
      setEntries((old) => [...old, { type: "message", message: data.message }]);
      setLiveMessage(undefined);
    }
    if (event.event === "tool.started") {
      const id = data.toolCallId ?? crypto.randomUUID();
      setTools((old) => [...old.filter((tool) => tool.id !== id), { id, name: data.toolName ?? "tool", state: "running", detail: summarize(data.args) }]);
    }
    if (event.event === "tool.updated" || event.event === "tool.completed") {
      const id = data.toolCallId ?? "";
      setTools((old) => old.map((tool) => tool.id === id ? { ...tool, state: event.event === "tool.completed" ? "done" : "running", detail: summarize(data.result ?? data.args), error: data.isError } : tool));
    }
  }

  useEffect(() => {
    if (!selectedId && sessions.length) setSelectedId(sessions[0]?.sessionId);
    if (selectedId && !sessions.some((session) => session.sessionId === selectedId)) setSelectedId(sessions[0]?.sessionId);
  }, [sessions, selectedId]);

  useEffect(() => {
    setEntries([]); setTools([]); setLiveMessage(undefined); setSyncing(!!selectedId);
    lastCompletedMessage.current = undefined;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) { setSyncing(false); return; }
    setSyncing(true);
    if (connected) send({ type: "browser.subscribe", sessionId: selectedId });
  }, [selectedId, connected, connectionId, send]);

  return <div className="shell">
    <header className="masthead">
      <button className="mobile-menu" onClick={() => setSidebarOpen((open) => !open)} aria-label={selected ? `Open sessions. Current session: ${selectedName} in ${selected.cwd}` : "Open sessions"} aria-expanded={sidebarOpen}><span>☰</span></button>
      <div className={`brand ${selected ? "session-brand" : ""}`} title={selected?.cwd}>
        <span className="brand-mark">π</span>
        <div><b>{selectedName ?? "PISS"}</b><small>{selected ? <><span className="full-directory">{selected.cwd}</span><span className="compact-directory">{compactDirectory(selected.cwd)}</span></> : "PI SIN SIDECAR"}</small></div>
      </div>
      <div className={`network ${networkState}`} role="status" aria-live="polite"><i />{networkLabel}<span>{user}</span></div>
    </header>
    <button className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`} onClick={() => setSidebarOpen(false)} aria-label="Close sessions" />
    <aside className={`rail ${selected ? "rail-has-selection" : ""} ${sidebarOpen ? "mobile-open" : ""}`}>
      <div className="rail-label"><span>ACTIVE RUNTIMES</span><b>{sessions.filter((s) => s.state !== "offline").length.toString().padStart(2, "0")}</b></div>
      <div className="session-list">
        {sessions.length === 0 && <div className="empty-rail"><strong>No signal</strong><span>Start Pi with the PISS extension installed.</span></div>}
        {sessions.map((session, index) => <div key={session.sessionId} role="button" tabIndex={0} className={`session-card ${selectedId === session.sessionId ? "selected" : ""}`} onClick={() => { setSelectedId(session.sessionId); setSidebarOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(session.sessionId); setSidebarOpen(false); } }}>
          <span className={`state-dot ${session.state}`} />
          <span className="session-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="session-copy"><strong>{session.name || shortProject(session.cwd)}</strong><small>{session.cwd}</small></span>
          <span className="session-meta">{session.state}<small>{relativeTime(session.lastActivity)}</small>{session.state === "offline" && <button className="session-archive" onClick={(event) => { event.stopPropagation(); send({ type: "browser.archive", sessionId: session.sessionId, runtimeId: session.runtimeId }); }} aria-label={`Archive ${session.name || shortProject(session.cwd)}`}>ARCHIVE</button>}</span>
        </div>)}
      </div>
    </aside>
    <main className="workspace">
      {selected ? <SessionView session={selected} entries={entries} liveMessage={liveMessage} tools={tools} loading={outputLoading} connected={connected} pending={pending} commandResults={commandResults} reviewResult={reviewResult} requestReview={(requestId) => {
        setReviewResult(undefined);
        if (!send({ type: "browser.review_request", requestId, sessionId: selected.sessionId, runtimeId: selected.runtimeId })) {
          setReviewResult({ type: "review.result", requestId, ok: false, error: "Sidecar is disconnected" });
        }
      }} notice={notice} clearNotice={() => setNotice(undefined)} sendCommand={(message) => {
        setPending(message.commandId); setNotice(undefined);
        if (!send(message)) {
          setPending(undefined);
          setNotice("Sidecar is disconnected");
          setCommandResults((results) => ({ ...results, [message.commandId]: { ok: false, error: "Sidecar is disconnected" } }));
        }
      }} /> : <div className="blank-state"><span>π</span><h1>Awaiting runtime</h1><p>The control surface is ready. Open a Pi session to establish a bridge.</p></div>}
    </main>
  </div>;
}

function summarize(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 180);
  try { return JSON.stringify(value).slice(0, 180); } catch { return "Activity update"; }
}

function SessionView({ session, entries, liveMessage, tools, loading, connected, pending, commandResults, reviewResult, requestReview, notice, clearNotice, sendCommand }: {
  session: SessionInfo; entries: RawEntry[]; liveMessage?: PiMessage; tools: ToolActivity[]; loading: boolean; connected: boolean; pending?: string; commandResults: Record<string, CommandResult>; reviewResult?: ReviewResultMessage; requestReview: (requestId: string) => void; notice?: string; clearNotice: () => void; sendCommand: (message: BrowserToServer & { type: "browser.command" }) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<ImageInput & { preview: string }>>([]);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRequestId, setReviewRequestId] = useState<string | undefined>(undefined);
  const timelineRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const touchYRef = useRef<number | undefined>(undefined);
  const draftSessionRef = useRef(session.sessionId);
  const submittedDrafts = useRef(new Map<string, { sessionId: string }>());
  const isRunning = session.state === "streaming";
  const ready = connected && !loading;
  const messages = useMemo(() => entries.filter((entry) => entry.type === "message" && entry.message).map((entry) => entry.message!), [entries]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !followingRef.current) return;
    timeline.scrollTop = timeline.scrollHeight;
  }, [messages.length, liveMessage, tools, outbox]);
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) timeline.scrollTop = timeline.scrollHeight;
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    followingRef.current = true;
    userScrollIntentRef.current = false;
    setAtBottom(true);
    const draft = readDraft(session.sessionId);
    draftSessionRef.current = session.sessionId;
    setText(draft?.text ?? "");
    setDelivery(draft?.delivery ?? "steer");
    setImages([]); setOutbox([]); setReviewOpen(false); setReviewRequestId(undefined); clearNotice();
  }, [session.sessionId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draftSessionRef.current === session.sessionId) writeDraft(session.sessionId, text, delivery);
    }, 200);
    return () => clearTimeout(timer);
  }, [session.sessionId, text, delivery]);
  useEffect(() => {
    const saveBeforePageSleep = () => writeDraft(session.sessionId, text, delivery);
    window.addEventListener("pagehide", saveBeforePageSleep);
    return () => window.removeEventListener("pagehide", saveBeforePageSleep);
  }, [session.sessionId, text, delivery]);
  useEffect(() => {
    setOutbox((items) => items.map((item) => {
      const result = commandResults[item.id];
      if (!result || item.status !== "sending") return item;
      return { ...item, status: result.ok ? "accepted" : "rejected", error: result.error };
    }));
    for (const [commandId, submitted] of submittedDrafts.current) {
      const result = commandResults[commandId];
      if (!result) continue;
      if (result.ok && submitted.sessionId === session.sessionId) {
        writeDraft(session.sessionId, "", delivery);
        setText("");
        setImages([]);
      } else if (result.ok) {
        writeDraft(submitted.sessionId, "", "steer");
      }
      submittedDrafts.current.delete(commandId);
    }
  }, [commandResults, session.sessionId, delivery]);
  useEffect(() => {
    setOutbox((items) => items.filter((item) => {
      if (item.status !== "accepted") return true;
      return !messages.slice(item.baselineMessages).some((message) =>
        message.role === "user" && (!item.text || textContent(message.content).trim() === item.text),
      );
    }));
    const stored = readDraft(session.sessionId);
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (stored && latestUserMessage?.timestamp &&
      textContent(latestUserMessage.content).trim() === stored.text.trim() &&
      latestUserMessage.timestamp >= stored.updatedAt - 2_000) {
      writeDraft(session.sessionId, "", delivery);
      setText((current) => current.trim() === stored.text.trim() ? "" : current);
    }
  }, [messages, commandResults, session.sessionId, delivery]);

  async function selectImages(files: Iterable<File> | null) {
    if (!files) return;
    const next: Array<ImageInput & { preview: string }> = [];
    for (const file of [...files].slice(0, 4 - images.length)) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) { clearNotice(); continue; }
      const dataUrl = await fileToDataUrl(file);
      next.push({ mediaType: file.type as ImageInput["mediaType"], data: dataUrl.split(",")[1] ?? "", name: file.name, preview: dataUrl });
    }
    if ([...images, ...next].reduce((total, image) => total + image.data.length * .75, 0) > MAX_IMAGE_BYTES) return;
    setImages((old) => [...old, ...next]);
  }

  function submit() {
    if ((!text.trim() && !images.length) || pending || !ready || session.state === "offline") return;
    const commandId = crypto.randomUUID();
    const action = isRunning ? delivery : "prompt";
    const submittedText = text.trim();
    submittedDrafts.current.set(commandId, { sessionId: session.sessionId });
    setOutbox((items) => [...items, { id: commandId, text: submittedText, imageCount: images.length, baselineMessages: messages.length, action, status: "sending" }]);
    sendCommand({ type: "browser.command", commandId, sessionId: session.sessionId, runtimeId: session.runtimeId, action, text: submittedText, images: images.map(({ preview: _, ...image }) => image) });
  }

  function updateScrollPosition() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const nextAtBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 64;
    if (nextAtBottom) {
      followingRef.current = true;
      userScrollIntentRef.current = false;
      setAtBottom(true);
    } else if (userScrollIntentRef.current) {
      followingRef.current = false;
      setAtBottom(false);
    }
  }

  function noteWheelIntent(event: React.WheelEvent<HTMLElement>) {
    if (event.deltaY < 0) userScrollIntentRef.current = true;
  }

  function noteTouchStart(event: React.TouchEvent<HTMLElement>) {
    touchYRef.current = event.touches[0]?.clientY;
  }

  function noteTouchMove(event: React.TouchEvent<HTMLElement>) {
    const currentY = event.touches[0]?.clientY;
    if (currentY === undefined || touchYRef.current === undefined) return;
    if (currentY - touchYRef.current > 3) userScrollIntentRef.current = true;
    touchYRef.current = currentY;
  }

  function noteScrollbarIntent(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const right = event.currentTarget.getBoundingClientRect().right;
    if (right - event.clientX < 20) userScrollIntentRef.current = true;
  }

  function jumpToBottom() {
    followingRef.current = true;
    setAtBottom(true);
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }

  return <div className="session-view">
    <div className="timeline-wrap">
      {loading && <div className="sync-banner" role="status"><i /><div><b>{connected ? "SYNCING LATEST OUTPUT" : "RESTORING LIVE LINK"}</b><span>{connected ? "Checking the session snapshot before resuming the stream…" : "Reconnecting automatically…"}</span></div></div>}
      <section ref={timelineRef} className="timeline" aria-live="polite" aria-busy={loading} onScroll={updateScrollPosition} onWheel={noteWheelIntent} onTouchStart={noteTouchStart} onTouchMove={noteTouchMove} onPointerDown={noteScrollbarIntent}>
        {messages.length === 0 && !liveMessage && !loading && <div className="timeline-empty"><span>EVENT STREAM / {session.runtimeId.slice(0, 8)}</span><p>No conversation entries in this runtime yet.</p></div>}
        {messages.map((message, index) => <Message key={`${message.timestamp ?? index}-${index}`} message={message} />)}
        {outbox.map((item) => <OutboxMessage key={item.id} item={item} />)}
        {tools.map((tool) => <div className={`tool-row ${tool.error ? "error" : ""}`} key={tool.id}><i className={tool.state} /><div><b>{tool.name}</b><span>{tool.detail || (tool.state === "running" ? "Executing…" : "Complete")}</span></div><small>{tool.state}</small></div>)}
        {liveMessage && <Message message={liveMessage} live />}
        <div ref={endRef} />
      </section>
      <button className={`jump-bottom ${atBottom ? "at-bottom" : ""}`} onClick={jumpToBottom} aria-label="Jump to latest message"><span>↓</span><small>LATEST</small></button>
    </div>
    {reviewOpen && <ReviewPanel result={reviewResult?.requestId === reviewRequestId ? reviewResult : undefined} loading={reviewResult?.requestId !== reviewRequestId} onRefresh={() => { const requestId = crypto.randomUUID(); setReviewRequestId(requestId); requestReview(requestId); }} onClose={() => setReviewOpen(false)} />}
    <section className="control-deck">
      {notice && <button className="notice" onClick={clearNotice}>{notice}<span>×</span></button>}
      {images.length > 0 && <div className="image-strip">{images.map((image, index) => <button key={`${image.name}-${index}`} onClick={() => setImages((old) => old.filter((_, item) => item !== index))}><img src={image.preview} alt="" /><span>REMOVE</span></button>)}</div>}
      <div className="composer">
        <label className={`attach ${pending || !ready ? "disabled" : ""}`} title="Attach images"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={!!pending || !ready} onChange={(event) => { void selectImages(event.target.files); event.target.value = ""; }} /><span>＋</span><small>IMAGE</small></label>
        <textarea value={text} disabled={!!pending || !ready} onChange={(event) => setText(event.target.value)} onPaste={(event) => {
          const pastedImages = [...event.clipboardData.items]
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (pastedImages.length) void selectImages(pastedImages);
        }} onKeyDown={(event) => {
          const mobileLayout = window.matchMedia("(max-width: 760px)").matches;
          if (!mobileLayout && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }} placeholder={isRunning ? "Steer the active operation…" : "Issue a new instruction…"} rows={3} />
        <button className="send-button" disabled={!!pending || !ready || session.state === "offline" || (!text.trim() && !images.length)} onClick={submit}><span>{pending || !ready ? "…" : "↗"}</span><small>{loading ? "SYNC" : isRunning ? delivery === "steer" ? "STEER" : "QUEUE" : "SEND"}</small></button>
      </div>
      <div className="control-meta">
        <div className={`deck-footer ${isRunning ? "" : "idle-footer"}`}>
          {isRunning ? <div className="delivery-toggle"><button className={delivery === "steer" ? "active" : ""} onClick={() => setDelivery("steer")}>STEER AFTER CURRENT TOOL</button><button className={delivery === "followUp" ? "active" : ""} onClick={() => setDelivery("followUp")}>FOLLOW-UP AFTER SETTLE</button></div> : <span className="desktop-hint">ENTER TO SEND · SHIFT+ENTER FOR NEW LINE</span>}
          {isRunning && <button className="abort" disabled={!ready} onClick={() => sendCommand({ type: "browser.command", commandId: crypto.randomUUID(), sessionId: session.sessionId, runtimeId: session.runtimeId, action: "abort" })}>ABORT OPERATION</button>}
        </div>
        <div className="session-status"><button className="review-trigger" disabled={!ready} onClick={() => { const requestId = crypto.randomUUID(); setReviewOpen(true); setReviewRequestId(requestId); requestReview(requestId); }}>REVIEW CHANGES</button><span>MODEL <b>{session.model?.split("/").at(-1) ?? "—"}</b></span><span>THINKING <b>{session.thinkingLevel ?? "—"}</b></span></div>
      </div>
    </section>
  </div>;
}

function reviewLabels(file: ReviewFile): string[] {
  if (file.indexStatus === "?" && file.worktreeStatus === "?") return ["UNTRACKED"];
  const labels: string[] = [];
  if (file.indexStatus !== " ") labels.push(`INDEX ${file.indexStatus}`);
  if (file.worktreeStatus !== " ") labels.push(`WORKTREE ${file.worktreeStatus}`);
  return labels;
}

function DiffPatch({ patch }: { patch: string }) {
  return <pre className="diff-patch">{patch.split("\n").map((line, index) => {
    const className = line.startsWith("@@") ? "hunk"
      : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("# ") ? "meta"
        : line.startsWith("+") ? "added"
          : line.startsWith("-") ? "removed"
            : "context";
    return <span className={className} key={index}>{line || " "}{"\n"}</span>;
  })}</pre>;
}

function ReviewPanel({ result, loading, onRefresh, onClose }: {
  result?: ReviewResultMessage;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const review: ReviewSnapshot | undefined = result?.review;
  return <section className="review-panel" aria-label="Uncommitted changes">
    <header className="review-header"><div><span>WORKTREE REVIEW</span><b>{review ? `${review.totalFiles} changed file${review.totalFiles === 1 ? "" : "s"}` : "Current uncommitted code"}</b></div><nav><button onClick={onRefresh} disabled={loading}>REFRESH</button><button onClick={onClose}>CLOSE</button></nav></header>
    <div className="review-body">
      {loading && <div className="review-state"><i />Reading staged, unstaged, and untracked changes…</div>}
      {!loading && result && !result.ok && <div className="review-state error">{result.error ?? "Unable to load changes"}</div>}
      {!loading && review?.files.length === 0 && <div className="review-state">Working tree is clean.</div>}
      {!loading && review?.truncated && <div className="review-warning">The review was bounded for safety. Some files or patch content are omitted.</div>}
      {!loading && review?.files.map((file) => <details className="review-file" key={file.path}>
        <summary><span className="review-file-path">{file.path}</span><span className="review-badges">{reviewLabels(file).map((label) => <i key={label}>{label}</i>)}{file.binary && <i>BINARY</i>}{file.truncated && <i>BOUNDED</i>}</span></summary>
        {file.patch ? <DiffPatch patch={file.patch} /> : <div className="review-empty-patch">No textual patch is available for this change.</div>}
      </details>)}
    </div>
  </section>;
}

function OutboxMessage({ item }: { item: OutboxItem }) {
  const label = item.action === "steer" ? "STEER" : item.action === "followUp" ? "FOLLOW-UP" : "PROMPT";
  const status = item.status === "sending"
    ? "Sending to Pi…"
    : item.status === "rejected"
      ? item.error ?? "Rejected by Pi"
      : item.action === "steer"
        ? "Queued — applies after the current tool call finishes"
        : item.action === "followUp"
          ? "Queued — waits until the agent settles"
          : "Accepted — starting the next turn";
  return <article className={`outbox-message ${item.status}`}>
    <header><span>{label}</span><i>{item.status}</i></header>
    {item.text && <div>{item.text}</div>}
    {item.imageCount > 0 && <small>{item.imageCount} image{item.imageCount === 1 ? "" : "s"} attached</small>}
    <footer>{status}</footer>
  </article>;
}

function Message({ message, live }: { message: PiMessage; live?: boolean }) {
  const role = message.role ?? "event";
  const text = textContent(message.content);
  const images = imageAttachments(message.content);
  if (!text && images.length === 0 && role === "toolResult") return null;
  return <article className={`message ${role} ${live ? "live" : ""}`}>
    <header><span>{role === "assistant" ? "PI" : role === "user" ? "REMOTE" : role.toUpperCase()}</span>{live && <i>STREAMING</i>}</header>
    {text && <div>{text}</div>}
    {images.length > 0 && <div className="message-attachments">{images.map((image, index) => <span key={`${image.mimeType}-${index}`}>▧ IMAGE ATTACHED <small>{image.mimeType.replace("image/", "").toUpperCase()}</small></span>)}</div>}
    {!text && images.length === 0 && <div>Structured content</div>}
  </article>;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
}

if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void (async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const wasControlled = navigator.serviceWorker.controller !== null || registrations.length > 0;
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("piss-shell-")).map((key) => caches.delete(key)));
    }

    const reloadKey = "piss:dev-without-service-worker";
    if (wasControlled && sessionStorage.getItem(reloadKey) !== "1") {
      sessionStorage.setItem(reloadKey, "1");
      location.reload();
    } else {
      sessionStorage.removeItem(reloadKey);
    }
  })().catch(() => undefined);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void (async () => {
      let reloadOnControllerChange = navigator.serviceWorker.controller !== null;
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadOnControllerChange && !reloading) {
          reloading = true;
          location.reload();
        }
        reloadOnControllerChange = true;
      });
      const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" });
      const checkForUpdate = () => { if (document.visibilityState === "visible") void registration.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", checkForUpdate);
      window.addEventListener("online", checkForUpdate);
      checkForUpdate();
      window.setInterval(checkForUpdate, 60 * 60_000);
    })().catch(() => undefined);
  });
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
