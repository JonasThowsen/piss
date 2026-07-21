import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MAX_IMAGE_BYTES,
  THINKING_LEVELS,
  type AvailableModel,
  type BrowserToServer,
  type ImageInput,
  type NotificationCapability,
  type ReviewFile,
  type ReviewSnapshot,
  type ServerToBrowser,
  type SessionEvent,
  type SessionInfo,
  type ThinkingLevel,
} from "../../shared/protocol.ts";
import { readDraft, writeDraft } from "./drafts.ts";
import { summarize, textContent, type PiMessage } from "./message-content.ts";
import { displaySessionStatus } from "./session-status.ts";
import { TimelineMessage } from "./TimelineMessage.tsx";
import { usePushNotifications, type PushNotificationStatus } from "./usePushNotifications.ts";
import { useSidecarSocket } from "./useSidecarSocket.ts";

type RawEntry = { type?: string; message?: PiMessage };
type ToolActivity = { id: string; name: string; state: "running" | "done"; detail: string; error?: boolean };
type CommandResult = { ok: boolean; error?: string };
type ReviewResultMessage = Extract<ServerToBrowser, { type: "review.result" }>;
type ModelResultMessage = Extract<ServerToBrowser, { type: "models.result" }>;
type NotificationUpdateMessage = Extract<ServerToBrowser, { type: "notifications.updated" }>;
type OutboxItem = {
  id: string;
  text: string;
  imageCount: number;
  baselineMessages: number;
  submittedAt: number;
  action: "prompt" | "steer" | "followUp";
  status: "sending" | "accepted" | "delivered" | "rejected";
  error?: string;
};
type SessionCursor = { sessionId: string; runtimeId: string; sequence: number };
type SessionViewCache = {
  cursor: SessionCursor;
  entries: RawEntry[];
  liveMessage?: PiMessage;
  tools: ToolActivity[];
  lastCompletedMessage?: PiMessage;
};

function applyEvent(view: SessionViewCache, event: SessionEvent): SessionViewCache {
  const data = event.data as { message?: PiMessage; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean };
  let next = { ...view, cursor: { sessionId: view.cursor.sessionId, runtimeId: event.runtimeId, sequence: event.sequence } };
  if ((event.event === "message.started" || event.event === "message.updated") && data.message) {
    const completed = view.lastCompletedMessage;
    const stale = completed && data.message.role === completed.role &&
      (data.message.timestamp !== undefined
        ? data.message.timestamp === completed.timestamp
        : textContent(data.message.content) === textContent(completed.content));
    if (!stale) next = { ...next, liveMessage: data.message };
  }
  if (event.event === "message.completed" && data.message) {
    next = { ...next, entries: [...view.entries, { type: "message", message: data.message }], liveMessage: undefined, lastCompletedMessage: data.message };
  }
  if (event.event === "tool.started") {
    const id = data.toolCallId ?? crypto.randomUUID();
    next = { ...next, tools: [...view.tools.filter((tool) => tool.id !== id), { id, name: data.toolName ?? "tool", state: "running", detail: summarize(data.args) }] };
  }
  if (event.event === "tool.updated" || event.event === "tool.completed") {
    const id = data.toolCallId ?? "";
    next = { ...next, tools: view.tools.map((tool) => tool.id === id ? { ...tool, state: event.event === "tool.completed" ? "done" : "running", detail: summarize(data.result ?? data.args), error: data.isError } : tool) };
  }
  return next;
}

const CONNECTION_INTERRUPTED = "Connection interrupted; check the refreshed output before retrying";

function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
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
  return parts.slice(-2).join("/");
}

function sessionLocation(session: SessionInfo): string {
  return session.branch ?? compactDirectory(session.cwd);
}

function notificationStatusLabel(status: PushNotificationStatus): string {
  switch (status) {
    case "enabled": return "ON FOR THIS DEVICE";
    case "enabling": return "CONNECTING PUSH…";
    case "denied": return "BLOCKED BY BROWSER";
    case "unavailable": return "INSTALL PWA TO ENABLE";
    case "error": return "RETRY ALERT SETUP";
    case "loading": return "CHECKING DEVICE…";
    default: return "OFF FOR THIS DEVICE";
  }
}

export function App() {
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
  const [modelResult, setModelResult] = useState<ModelResultMessage>();
  const [notificationCapability, setNotificationCapability] = useState<NotificationCapability>();
  const [notificationUpdate, setNotificationUpdate] = useState<NotificationUpdateMessage>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [now, setNow] = useState(Date.now);
  const sessionViews = useRef(new Map<string, SessionViewCache>());
  const warmedSessions = useRef({ connectionId: 0, ids: new Set<string>() });
  const currentId = useRef<string | undefined>(undefined);
  const requestedSessionId = useRef(new URLSearchParams(location.search).get("session") ?? undefined);
  currentId.current = selectedId;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const onMessage = useCallback((message: ServerToBrowser) => {
    if (message.type === "server.hello") {
      setUser(message.user);
      setSessions(message.sessions);
      setNotificationCapability(message.notifications);
    }
    if (message.type === "sessions.updated") setSessions(message.sessions);
    if (message.type === "session.snapshot") {
      const snapshotEntries = message.entries as RawEntry[];
      const view: SessionViewCache = {
        cursor: { sessionId: message.session.sessionId, runtimeId: message.session.runtimeId, sequence: message.sequence },
        entries: snapshotEntries,
        liveMessage: undefined,
        tools: [],
        lastCompletedMessage: snapshotEntries.findLast((entry) => entry.type === "message" && entry.message)?.message,
      };
      sessionViews.current.set(message.session.sessionId, view);
      if (message.session.sessionId === currentId.current) {
        setEntries(view.entries); setLiveMessage(view.liveMessage); setTools(view.tools); setSyncing(false);
      }
    }
    if (message.type === "session.event") {
      const previous = sessionViews.current.get(message.sessionId) ?? {
        cursor: { sessionId: message.sessionId, runtimeId: message.event.runtimeId, sequence: 0 }, entries: [], tools: [],
      };
      if (previous.cursor.runtimeId === message.event.runtimeId && message.event.sequence <= previous.cursor.sequence) return;
      const view = applyEvent(previous, message.event);
      sessionViews.current.set(message.sessionId, view);
      if (message.sessionId === currentId.current) {
        setEntries(view.entries); setLiveMessage(view.liveMessage); setTools(view.tools); setSyncing(false);
      }
    }
    if (message.type === "session.resumed") {
      const previous = sessionViews.current.get(message.session.sessionId);
      if (previous) sessionViews.current.set(message.session.sessionId, {
        ...previous,
        cursor: { sessionId: message.session.sessionId, runtimeId: message.session.runtimeId, sequence: message.sequence },
      });
      setSessions((old) => old.map((session) => session.sessionId === message.session.sessionId ? message.session : session));
      if (message.session.sessionId === currentId.current) setSyncing(false);
    }
    if (message.type === "review.result") setReviewResult(message);
    if (message.type === "models.result") setModelResult(message);
    if (message.type === "notifications.updated") setNotificationUpdate(message);
    if (message.type === "command.result") {
      setPending((id) => id === message.commandId ? undefined : id);
      setCommandResults((results) => ({ ...results, [message.commandId]: { ok: message.ok, error: message.error } }));
      if (!message.ok) setNotice(message.error ?? "Command rejected");
    }
    if (message.type === "server.error") setNotice(message.error);
  }, []);

  const { connected, status: connectionStatus, connectionId, send } = useSidecarSocket(onMessage);
  const taskAlerts = usePushNotifications({
    capability: notificationCapability,
    acknowledgement: notificationUpdate,
    connected,
    connectionId,
    send,
  });
  const selected = sessions.find((session) => session.sessionId === selectedId);
  const outputLoading = !!selected && (!connected || syncing);
  const networkState = connectionStatus === "online" ? (syncing && selected ? "syncing" : "live") : connectionStatus;
  const networkLabel = networkState === "live" ? "LIVE OUTPUT"
    : networkState === "syncing" ? "SYNCING OUTPUT"
      : networkState === "offline" ? "DEVICE OFFLINE"
        : networkState === "connecting" ? "CONNECTING" : "RESTORING LINK";
  const selectedName = selected ? selected.name || shortProject(selected.cwd) : undefined;
  const selectedModel = selected?.model?.split("/").at(-1);

  useEffect(() => {
    if (!selected) { document.title = "PISS · Pi sin sidecar"; return; }
    const context = selected.branch ?? shortProject(selected.cwd);
    document.title = selectedName === context ? `${context} · PISS` : `${selectedName} · ${context} · PISS`;
  }, [selected, selectedName]);

  useEffect(() => {
    const requested = requestedSessionId.current;
    if (requested && sessions.some((session) => session.sessionId === requested)) {
      requestedSessionId.current = undefined;
      history.replaceState(null, "", location.pathname);
      setSelectedId(requested);
      return;
    }
    if (requested && sessions.length) requestedSessionId.current = undefined;
    if (!selectedId && sessions.length) setSelectedId(sessions[0]?.sessionId);
    if (selectedId && !sessions.some((session) => session.sessionId === selectedId)) setSelectedId(sessions[0]?.sessionId);
  }, [sessions, selectedId]);

  useEffect(() => {
    if (!selectedId) { setEntries([]); setTools([]); setLiveMessage(undefined); setSyncing(false); return; }
    const cached = sessionViews.current.get(selectedId);
    setEntries(cached?.entries ?? []);
    setTools(cached?.tools ?? []);
    setLiveMessage(cached?.liveMessage);
    setSyncing(!cached);
  }, [selectedId]);

  useEffect(() => {
    if (!connected) return;
    if (warmedSessions.current.connectionId !== connectionId) {
      warmedSessions.current = { connectionId, ids: new Set() };
    }
    for (const session of sessions) {
      if (warmedSessions.current.ids.has(session.sessionId)) continue;
      const cached = sessionViews.current.get(session.sessionId);
      const cursor = cached?.cursor.runtimeId === session.runtimeId ? cached.cursor : undefined;
      if (send({ type: "browser.subscribe", sessionId: session.sessionId, runtimeId: cursor?.runtimeId, after: cursor?.sequence })) {
        warmedSessions.current.ids.add(session.sessionId);
        if (session.sessionId === currentId.current) setSyncing(true);
      }
    }
  }, [sessions, connected, connectionId, send]);

  useEffect(() => {
    if (connected || !pending) return;
    const commandId = pending;
    setPending(undefined);
    setCommandResults((results) => ({ ...results, [commandId]: { ok: false, error: CONNECTION_INTERRUPTED } }));
    setNotice(CONNECTION_INTERRUPTED);
  }, [connected, pending]);

  return <div className="shell">
    <header className="masthead">
      <button className="mobile-menu" onClick={() => setSidebarOpen((open) => !open)} aria-label={selected ? `Open sessions. Current session: ${selectedName}, ${sessionLocation(selected)}, in ${selected.cwd}` : "Open sessions"} aria-expanded={sidebarOpen}><span>☰</span></button>
      <div className={`brand ${selected ? "session-brand" : ""}`} title={selected?.cwd}>
        <span className="brand-mark">π</span>
        <div><b>{selectedName ?? "PISS"}</b><small>{selected ? <><span className={selected.branch ? "session-branch" : "session-location"}>{sessionLocation(selected)}</span><span className="session-runtime"> · {selectedModel ?? "—"} · {selected.thinkingLevel ?? "—"}</span></> : "PI SIN SIDECAR"}</small></div>
      </div>
      <div className={`network ${networkState}`} role="status" aria-live="polite"><i />{networkLabel}<span>{user}</span></div>
    </header>
    <button className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`} onClick={() => setSidebarOpen(false)} aria-label="Close sessions" />
    <aside className={`rail ${selected ? "rail-has-selection" : ""} ${sidebarOpen ? "mobile-open" : ""}`}>
      <div className="rail-label"><span>ACTIVE RUNTIMES</span><b>{sessions.filter((s) => s.state !== "offline").length.toString().padStart(2, "0")}</b></div>
      <button
        className={`notification-toggle ${taskAlerts.status}`}
        disabled={!connected || taskAlerts.status === "loading" || taskAlerts.status === "enabling" || taskAlerts.status === "unavailable" || taskAlerts.status === "denied"}
        title={taskAlerts.error ?? (taskAlerts.status === "denied" ? "Allow notifications in browser settings" : "Notify this device when an agent settles")}
        onClick={() => void (taskAlerts.status === "enabled" ? taskAlerts.disable() : taskAlerts.enable())}
      >
        <i>{taskAlerts.status === "enabled" ? "●" : "○"}</i>
        <span><b>TASK ALERTS</b><small>{notificationStatusLabel(taskAlerts.status)}</small></span>
      </button>
      <div className="session-list">
        {sessions.length === 0 && <div className="empty-rail"><strong>No signal</strong><span>Start Pi with the PISS extension installed.</span></div>}
        {sessions.map((session) => {
          const status = displaySessionStatus(session, now);
          return <div key={session.sessionId} role="button" tabIndex={0} title={session.cwd} className={`session-card ${selectedId === session.sessionId ? "selected" : ""}`} onClick={() => { setSelectedId(session.sessionId); setSidebarOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(session.sessionId); setSidebarOpen(false); } }}>
            <span className={`state-dot ${status}`} />
            <span className={`session-status ${status}`}>{status}</span>
            <span className="session-copy"><strong>{session.name || shortProject(session.cwd)}</strong><small className={session.branch ? "branch" : ""}>{sessionLocation(session)}</small></span>
            <span className="session-meta"><small>{relativeTime(session.lastActivity, now)}</small>{status === "offline" && <button className="session-archive" onClick={(event) => { event.stopPropagation(); send({ type: "browser.archive", sessionId: session.sessionId, runtimeId: session.runtimeId }); }} aria-label={`Archive ${session.name || shortProject(session.cwd)}`}>ARCHIVE</button>}</span>
          </div>;
        })}
      </div>
    </aside>
    <main className="workspace">
      {selected ? <SessionView session={selected} entries={entries} liveMessage={liveMessage} tools={tools} loading={outputLoading} connected={connected} pending={pending} commandResults={commandResults} reviewResult={reviewResult} requestReview={(requestId) => {
        setReviewResult(undefined);
        if (!send({ type: "browser.review_request", requestId, sessionId: selected.sessionId, runtimeId: selected.runtimeId })) {
          setReviewResult({ type: "review.result", requestId, ok: false, error: "Sidecar is disconnected" });
        }
      }} modelResult={modelResult} requestModels={(requestId) => {
        setModelResult(undefined);
        if (!send({ type: "browser.models_request", requestId, sessionId: selected.sessionId, runtimeId: selected.runtimeId })) {
          setModelResult({ type: "models.result", requestId, ok: false, error: "Sidecar is disconnected" });
        }
      }} notice={notice} clearNotice={() => setNotice(undefined)} sendControl={(message) => {
        setNotice(undefined);
        if (!send(message)) {
          setNotice("Sidecar is disconnected");
          if (message.type === "browser.set_model" || message.type === "browser.set_thinking_level") {
            setCommandResults((results) => ({ ...results, [message.requestId]: { ok: false, error: "Sidecar is disconnected" } }));
          }
        }
      }} sendCommand={(message) => {
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

function SessionView({ session, entries, liveMessage, tools, loading, connected, pending, commandResults, reviewResult, requestReview, modelResult, requestModels, notice, clearNotice, sendControl, sendCommand }: {
  session: SessionInfo;
  entries: RawEntry[];
  liveMessage?: PiMessage;
  tools: ToolActivity[];
  loading: boolean;
  connected: boolean;
  pending?: string;
  commandResults: Record<string, CommandResult>;
  reviewResult?: ReviewResultMessage;
  requestReview: (requestId: string) => void;
  modelResult?: ModelResultMessage;
  requestModels: (requestId: string) => void;
  notice?: string;
  clearNotice: () => void;
  sendControl: (message: BrowserToServer) => void;
  sendCommand: (message: BrowserToServer & { type: "browser.command" }) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<ImageInput & { preview: string }>>([]);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRequestId, setReviewRequestId] = useState<string | undefined>(undefined);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelRequestId, setModelRequestId] = useState<string | undefined>(undefined);
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
    setImages([]); setOutbox([]); setReviewOpen(false); setReviewRequestId(undefined); setModelOpen(false); setModelRequestId(undefined); clearNotice();
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
    setOutbox((items) => {
      let changed = false;
      const next = items.map((item) => {
        const mayHaveReachedPi = item.status === "accepted" || (item.status === "rejected" && item.error === CONNECTION_INTERRUPTED);
        if (!mayHaveReachedPi) return item;
        const appeared = messages.some((message, index) => {
          if (message.role !== "user" || (item.text && textContent(message.content).trim() !== item.text)) return false;
          // A reconnect can replace the timeline with a bounded snapshot, making
          // the old array index larger than the new message list. Prefer Pi's
          // timestamp so accepted queue items still settle after resync.
          return message.timestamp !== undefined
            ? message.timestamp >= item.submittedAt - 2_000
            : index >= item.baselineMessages;
        });
        if (!appeared) return item;
        changed = true;
        return { ...item, status: "delivered" as const };
      });
      return changed ? next : items;
    });
    const stored = readDraft(session.sessionId);
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (stored && latestUserMessage?.timestamp &&
      textContent(latestUserMessage.content).trim() === stored.text.trim() &&
      latestUserMessage.timestamp >= stored.updatedAt - 2_000) {
      writeDraft(session.sessionId, "", delivery);
      setText((current) => current.trim() === stored.text.trim() ? "" : current);
    }
  }, [messages, commandResults, session.sessionId, delivery]);
  useEffect(() => {
    if (isRunning) return;
    // agent_settled is emitted only after Pi has exhausted queued continuations,
    // so no accepted steer/follow-up can still be waiting at this point.
    setOutbox((items) => items.map((item) => item.status === "accepted" ? { ...item, status: "delivered" } : item));
  }, [isRunning, commandResults]);
  useEffect(() => {
    if (!outbox.some((item) => item.status === "delivered")) return;
    const timer = window.setTimeout(() => setOutbox((items) => items.filter((item) => item.status !== "delivered")), 2_500);
    return () => clearTimeout(timer);
  }, [outbox]);

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
    setOutbox((items) => [...items, { id: commandId, text: submittedText, imageCount: images.length, baselineMessages: messages.length, submittedAt: Date.now(), action, status: "sending" }]);
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
      <section ref={timelineRef} className="timeline" aria-live="polite" aria-busy={loading} onScroll={updateScrollPosition} onWheel={noteWheelIntent} onTouchStart={noteTouchStart} onTouchMove={noteTouchMove} onPointerDown={noteScrollbarIntent}>
        {messages.length === 0 && !liveMessage && !loading && <div className="timeline-empty"><span>EVENT STREAM / {session.runtimeId.slice(0, 8)}</span><p>No conversation entries in this runtime yet.</p></div>}
        {messages.map((message, index) => <TimelineMessage key={`${message.timestamp ?? index}-${index}`} message={message} />)}
        {tools.filter((tool) => tool.state === "running").map((tool) => <div className={`tool-row ${tool.error ? "error" : ""}`} key={tool.id}><i className={tool.state} /><div><b>{tool.name}</b><span>{tool.detail || "Executing…"}</span></div><small>{tool.state}</small></div>)}
        {liveMessage && <TimelineMessage message={liveMessage} live />}
        <div ref={endRef} />
      </section>
      <button className={`jump-bottom ${atBottom ? "at-bottom" : ""}`} onClick={jumpToBottom} aria-label="Jump to latest message"><span>↓</span><small>LATEST</small></button>
    </div>
    {reviewOpen && <ReviewPanel result={reviewResult?.requestId === reviewRequestId ? reviewResult : undefined} loading={reviewResult?.requestId !== reviewRequestId} onRefresh={() => { const requestId = crypto.randomUUID(); setReviewRequestId(requestId); requestReview(requestId); }} onClose={() => setReviewOpen(false)} />}
    {modelOpen && <ModelPanel
      session={session}
      result={modelResult?.requestId === modelRequestId ? modelResult : undefined}
      loading={modelResult?.requestId !== modelRequestId}
      commandResults={commandResults}
      onRefresh={() => { const requestId = crypto.randomUUID(); setModelRequestId(requestId); requestModels(requestId); }}
      onSetModel={(provider, modelId, requestId) => sendControl({ type: "browser.set_model", requestId, sessionId: session.sessionId, runtimeId: session.runtimeId, provider, modelId })}
      onSetEffort={(level, requestId) => sendControl({ type: "browser.set_thinking_level", requestId, sessionId: session.sessionId, runtimeId: session.runtimeId, level })}
      onClose={() => setModelOpen(false)}
    />}
    <section className="control-deck">
      {outbox.length > 0 && <section className="outbox-tray" aria-label="Outgoing messages" aria-live="polite"><header><span>OUTGOING</span><b>{outbox.length.toString().padStart(2, "0")}</b></header><div>{outbox.map((item) => <OutboxMessage key={item.id} item={item} onDismiss={() => setOutbox((items) => items.filter((candidate) => candidate.id !== item.id))} />)}</div></section>}
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
        <div className={`control-actions ${isRunning ? "running-actions" : ""}`}>
          {isRunning && <div className="delivery-toggle" aria-label="Message delivery timing">
            <button className={delivery === "steer" ? "active" : ""} title="Steer after the current tool finishes" aria-pressed={delivery === "steer"} onClick={() => setDelivery("steer")}><b>STEER NEXT</b></button>
            <button className={delivery === "followUp" ? "active" : ""} title="Queue a follow-up after the agent settles" aria-pressed={delivery === "followUp"} onClick={() => setDelivery("followUp")}><b>FOLLOW-UP</b></button>
          </div>}
          {isRunning && <button className="abort" title="Abort the active agent operation" disabled={!ready} onClick={() => sendCommand({ type: "browser.command", commandId: crypto.randomUUID(), sessionId: session.sessionId, runtimeId: session.runtimeId, action: "abort" })}><i>■</i><b>STOP</b></button>}
          <button className="model-trigger" title={isRunning ? "Model changes are available when the agent settles" : "Change model and effort"} disabled={!ready || isRunning} onClick={() => { const requestId = crypto.randomUUID(); setReviewOpen(false); setModelOpen(true); setModelRequestId(requestId); requestModels(requestId); }}><i>◇</i><b>MODEL</b></button>
          <button className="review-trigger" title="Open the current uncommitted code diff" disabled={!ready} onClick={() => { const requestId = crypto.randomUUID(); setModelOpen(false); setReviewOpen(true); setReviewRequestId(requestId); requestReview(requestId); }}><i>▤</i><b>REVIEW</b></button>
        </div>
        {!isRunning && <span className="desktop-hint">ENTER TO SEND · SHIFT+ENTER FOR NEW LINE</span>}
      </div>
    </section>
  </div>;
}

function ModelPanel({ session, result, loading, commandResults, onRefresh, onSetModel, onSetEffort, onClose }: {
  session: SessionInfo;
  result?: ModelResultMessage;
  loading: boolean;
  commandResults: Record<string, CommandResult>;
  onRefresh: () => void;
  onSetModel: (provider: string, modelId: string, requestId: string) => void;
  onSetEffort: (level: ThinkingLevel, requestId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string>();
  const models = result?.models ?? [];
  const currentModel = models.find((model) => `${model.provider}/${model.id}` === session.model);
  const pendingResult = pendingId ? commandResults[pendingId] : undefined;
  const filtered = models.filter((model) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (pendingResult?.ok) setPendingId(undefined);
  }, [pendingResult]);

  const setModel = (model: AvailableModel) => {
    if (`${model.provider}/${model.id}` === session.model || pendingId) return;
    const requestId = crypto.randomUUID();
    setPendingId(requestId);
    onSetModel(model.provider, model.id, requestId);
  };
  const setEffort = (level: ThinkingLevel) => {
    if (level === session.thinkingLevel || pendingId) return;
    const requestId = crypto.randomUUID();
    setPendingId(requestId);
    onSetEffort(level, requestId);
  };

  return <section className="model-panel" aria-label="Model and effort settings">
    <header className="model-header">
      <div><span>RUNTIME CONFIGURATION</span><b>Model &amp; effort</b></div>
      <nav><button onClick={onRefresh} disabled={loading || !!pendingId}>REFRESH</button><button onClick={onClose}>CLOSE</button></nav>
    </header>
    <div className="model-body">
      <aside className="effort-console">
        <span>CURRENT ROUTE</span>
        <strong>{currentModel?.name ?? session.model?.split("/").at(-1) ?? "No model"}</strong>
        <small>{session.model ?? "Model unavailable"}</small>
        <div className="effort-scale" aria-label="Effort level">
          <label>EFFORT</label>
          <div>{(currentModel?.thinkingLevels ?? THINKING_LEVELS).map((level) => <button
            key={level}
            className={session.thinkingLevel === level ? "active" : ""}
            disabled={!!pendingId || !currentModel}
            onClick={() => setEffort(level)}
            aria-pressed={session.thinkingLevel === level}
          >{level}</button>)}</div>
        </div>
        <p>Model and effort changes apply to the next agent run. Unsupported effort levels are removed automatically.</p>
        {pendingId && !pendingResult && <div className="model-pending"><i />APPLYING CONFIGURATION</div>}
        {pendingResult && !pendingResult.ok && <button className="model-error" onClick={() => setPendingId(undefined)}>{pendingResult.error ?? "Configuration rejected"}<b>×</b></button>}
      </aside>
      <div className="model-catalog">
        <label className="model-search"><span>AVAILABLE MODELS</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter provider or model…" /></label>
        {loading && <div className="model-state"><i />Reading authenticated model catalog…</div>}
        {!loading && result && !result.ok && <div className="model-state error">{result.error ?? "Unable to load models"}</div>}
        {!loading && result?.ok && filtered.length === 0 && <div className="model-state">No available models match this filter.</div>}
        {!loading && filtered.map((model) => {
          const active = `${model.provider}/${model.id}` === session.model;
          return <button className={`model-option ${active ? "active" : ""}`} key={`${model.provider}/${model.id}`} disabled={!!pendingId} onClick={() => setModel(model)}>
            <i>{active ? "●" : "○"}</i>
            <span><b>{model.name}</b><small>{model.provider} / {model.id}</small></span>
            <em>{model.reasoning ? `${model.thinkingLevels.length} EFFORT LEVELS` : "DIRECT"}</em>
          </button>;
        })}
      </div>
    </div>
  </section>;
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

function OutboxMessage({ item, onDismiss }: { item: OutboxItem; onDismiss: () => void }) {
  const label = item.action === "steer" ? "STEER" : item.action === "followUp" ? "FOLLOW-UP" : "PROMPT";
  const status = item.status === "sending"
    ? "SENDING TO PI"
    : item.status === "delivered"
      ? "SENT TO PI"
      : item.status === "rejected"
        ? item.error ?? "REJECTED BY PI"
        : item.action === "steer"
          ? "QUEUED FOR NEXT TOOL BREAK"
          : item.action === "followUp"
            ? "QUEUED UNTIL AGENT SETTLES"
            : "ACCEPTED BY PI";
  return <article className={`outbox-message ${item.status}`}>
    <i className="outbox-state" />
    <div><header><b>{label}</b><small>{status}</small></header><p>{item.text || `${item.imageCount} attached image${item.imageCount === 1 ? "" : "s"}`}</p></div>
    {item.imageCount > 0 && item.text && <em>{item.imageCount} IMG</em>}
    {item.status === "rejected" && <button onClick={onDismiss} aria-label="Dismiss rejected outgoing message">×</button>}
  </article>;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
}

