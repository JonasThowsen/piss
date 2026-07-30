import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import * as Effect from "effect/Effect";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Collapsible } from "@base-ui/react/collapsible";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { ArrowDown, ArrowRight, ArrowUp, AtSign, Bell, BellRing, Bot, Check, ChevronDown, ChevronRight, Circle, CircleCheck, Copy, ExternalLink, FileDiff, FileText, Folder, Gauge, Image, ImagePlus, LoaderCircle, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings, Square, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AvailableModel, DirectoryCandidate, FileMention, ImageInput, ImageMediaType, InteractiveRequest, OwnedSession, OwnedSessionCommandAction, OwnedSessionSummary, PiSlashCommand, ReviewFile, ReviewSnapshot, ThinkingLevel, Workspace } from "../../shared/domain.ts";
import { ATTENTION_STATE_LABELS, canAcceptPrompt, canConfigureSession, isWritableRuntime } from "../../shared/sessionState.ts";
import { acknowledgeOwnedSession, archiveOwnedSession, compactSession, createOwnedSession, createWorkspace, deleteWorkspace, loadAvailableModels, loadReview, loadSession, loadSessions, loadSessionUsage, loadSlashCommands, loadTimelinePage, loadToolOutput, loadWorkspaces, renameOwnedSession, renameWorkspace, respondToInteractiveRequest, resumeOwnedSession, searchDirectories, searchFileMentions, sendSessionCommand, setSessionAutoCompaction, setSessionModel, setSessionThinkingLevel, subscribeSession } from "./api.ts";
import { draftStorageKey, pruneDrafts, readDraft, removeDraft, writeDraft } from "./drafts.ts";
import { activeFileMention, applyFileMention, type ActiveFileMention } from "./mentions.ts";
import { reconcileOutbox, type OutboxItem } from "./outbox.ts";
import { compact, eventTimeline, valueText } from "./timeline.ts";
import { useNotifications } from "./notifications.ts";
import { GlobalPicker } from "./GlobalPicker.tsx";
import { HOTKEYS } from "./hotkeys.ts";
import { readLastOpenedSession, writeLastOpenedSession } from "./lastOpenedSession.ts";
import { readCachedSession, removeCachedSession, writeCachedSession } from "./sessionCache.ts";
import { sessionPickerItems, type SelectSessionAction } from "./sessionPicker.ts";
import { initialSessionSyncState, reduceSessionSync, sessionForSettledCache, sessionSyncRequest, shouldPollSession, type SessionSyncInput } from "./sessionSync.ts";
import { SlashCommandMenu } from "./SlashCommandMenu.tsx";
import { activeSlashCommand, applySlashCommand, filterSlashCommands, isSlashCommandInput, nativeSlashCommand, slashCommandCatalog, type ActiveSlashCommand, type NativeSlashCommandName, type SlashCommandItem } from "./slashCommands.ts";
import "./styles.css";

type LoadState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly workspaces: ReadonlyArray<Workspace>; readonly sessions: ReadonlyArray<OwnedSessionSummary> }
  | { readonly _tag: "Failed"; readonly message: string };

type ComposerImage = ImageInput & { readonly preview: string; readonly size: number };

type SessionUiState = {
  readonly commandText: string;
  readonly images: ReadonlyArray<ComposerImage>;
  readonly delivery: "steer" | "followUp";
  readonly busy: boolean;
  readonly operationError?: string;
  readonly outbox: ReadonlyArray<OutboxItem>;
};

type ReviewState = {
  readonly sessionId: string;
  readonly loading: boolean;
  readonly snapshot?: ReviewSnapshot;
  readonly error?: string;
};

type MentionMenuState = {
  readonly active: ActiveFileMention;
  readonly mentions: ReadonlyArray<FileMention>;
  readonly loading: boolean;
  readonly error?: string;
  readonly highlighted: number;
};

type SlashCommandMenuState = {
  readonly active: ActiveSlashCommand;
  readonly runtimeId: string;
  readonly commands: ReadonlyArray<SlashCommandItem>;
  readonly loading: boolean;
  readonly error?: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMELINE_WINDOW_SIZE = 180;
const TIMELINE_WINDOW_SHIFT = 120;
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const emptySessionUiState = (): SessionUiState => ({ commandText: "", images: [], delivery: "steer", busy: false, outbox: [] });

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that expose Clipboard but deny it unexpectedly.
    }
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
  if (!copied) throw new Error("Clipboard access was denied");
}

function imageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image"));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed";
}

function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

function displayStatus(status: OwnedSessionSummary["status"]): string {
  return status;
}

const modelOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function newestModelsFirst(left: AvailableModel, right: AvailableModel): number {
  return modelOrder.compare(right.id, left.id)
    || modelOrder.compare(right.name, left.name)
    || modelOrder.compare(left.provider, right.provider);
}

function reviewLabels(file: ReviewFile): string[] {
  if (file.indexStatus === "?" && file.worktreeStatus === "?") return ["UNTRACKED"];
  const labels: string[] = [];
  if (file.indexStatus !== " ") labels.push(`INDEX ${file.indexStatus}`);
  if (file.worktreeStatus !== " ") labels.push(`WORKTREE ${file.worktreeStatus}`);
  return labels;
}

function patchCounts(patch: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function DiffPatch({ patch }: { readonly patch: string }) {
  return <pre className="diff-patch">{patch.split("\n").map((line, index) => {
    const className = line.startsWith("@@") ? "hunk"
      : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("# ") ? "meta"
        : line.startsWith("+") ? "added"
          : line.startsWith("-") ? "removed"
            : "context";
    return <span className={className} key={index}>{line || " "}{"\n"}</span>;
  })}</pre>;
}

function ReviewFileView({ file, initiallyOpen }: { readonly file: ReviewFile; readonly initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const counts = patchCounts(file.patch);
  const slash = file.path.lastIndexOf("/");
  const status = file.indexStatus === "?" ? { mark: "U", label: "Untracked file" } : file.worktreeStatus === "D" || file.indexStatus === "D" ? { mark: "D", label: "Deleted file" } : { mark: "M", label: "Modified file" };
  return <details className="review-file" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className="review-file-status"><span aria-hidden="true">{status.mark}</span><span className="sr-only">{status.label}</span></span><span className="review-file-path">{slash >= 0 && <small>{file.path.slice(0, slash + 1)}</small>}<b>{file.path.slice(slash + 1)}</b></span><span className="review-counts"><em>+{counts.additions}</em><em>−{counts.deletions}</em></span><strong aria-hidden="true"><ChevronDown /></strong></summary>
    <div className="review-file-meta"><span>{reviewLabels(file).map((label) => <i key={label}>{label}</i>)}{file.binary && <i>BINARY</i>}{file.truncated && <i>BOUNDED</i>}</span></div>
    {file.patch ? <DiffPatch patch={file.patch} /> : <div className="review-empty-patch">No textual patch is available for this change.</div>}
  </details>;
}

function ReviewView({ state, onRefresh }: { readonly state?: ReviewState; readonly onRefresh: () => void }) {
  const review = state?.snapshot;
  return <section className="review-view" aria-label="Uncommitted changes" aria-busy={state?.loading ?? false}>
    <span className="sr-only" aria-live="polite">{state?.loading ? "Reading repository changes" : state?.error ? `Review unavailable: ${state.error}` : review ? `${review.totalFiles} changed file${review.totalFiles === 1 ? "" : "s"} loaded` : ""}</span>
    <header className="review-overview">
      <div><span>WORKTREE REVIEW</span><h2>Changes</h2><p>{review ? `${review.totalFiles} changed file${review.totalFiles === 1 ? "" : "s"}` : "Staged, unstaged, and untracked work"}</p></div>
      <button onClick={onRefresh} disabled={state?.loading} type="button" aria-label="Refresh changes"><RefreshCw aria-hidden="true" className={state?.loading ? "icon-spin" : undefined} /><span>{state?.loading ? "READING" : "REFRESH"}</span></button>
    </header>
    {state?.loading && <div className="review-loading"><i /><div><b>Reading repository</b><span>Collecting staged, unstaged, and untracked patches…</span></div></div>}
    {!state?.loading && state?.error && <div className="review-state error"><b>Review unavailable</b><span>{state.error}</span><button type="button" onClick={onRefresh}>TRY AGAIN</button></div>}
    {!state?.loading && review?.files.length === 0 && <div className="review-state clean"><i aria-hidden="true"><Check /></i><b>Working tree is clean</b><span>There are no staged, unstaged, or untracked files.</span></div>}
    {!state?.loading && review?.truncated && <div className="review-warning">Review limits were reached. Some files or patch content are omitted.</div>}
    {!state?.loading && review && review.files.length > 0 && <div className="review-files">{review.files.map((file, index) => <ReviewFileView file={file} initiallyOpen={review.files.length === 1 || index === 0} key={file.path} />)}</div>}
  </section>;
}

const LazyMarkdown = memo(function LazyMarkdown({ text }: { readonly text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { root: element.closest(".timeline"), rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={ref} className={`message-content ${visible ? "" : "markdown-placeholder"}`}>
    {visible
      ? <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown>
      : <p>{compact(text, 280)}</p>}
  </div>;
});

export function App() {
  const routedSessionId = new URLSearchParams(window.location.search).get("session") ?? undefined;
  const [initialRequestedSessionId] = useState(() => routedSessionId ?? readLastOpenedSession());
  const [state, setState] = useState<LoadState>({ _tag: "Loading" });
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedSession, setSelectedSession] = useState<OwnedSession>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [workspaceCreatorOpen, setWorkspaceCreatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [compactionDialogOpen, setCompactionDialogOpen] = useState(false);

  const [archiveTarget, setArchiveTarget] = useState<OwnedSessionSummary>();
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const [renameSessionTarget, setRenameSessionTarget] = useState<OwnedSessionSummary>();
  const [renameWorkspaceTarget, setRenameWorkspaceTarget] = useState<Workspace>();
  const [removeWorkspaceTarget, setRemoveWorkspaceTarget] = useState<Workspace>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalPickerOpen, setGlobalPickerOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeView, setActiveView] = useState<"agent" | "changes" | "details">("agent");
  const [reviewState, setReviewState] = useState<ReviewState>();
  const [name, setName] = useState("");
  const [commandText, setCommandText] = useState(() => initialRequestedSessionId ? readDraft(initialRequestedSessionId)?.text ?? "" : "");
  const [images, setImages] = useState<ReadonlyArray<ComposerImage>>([]);
  const [imageSelectionPending, setImageSelectionPending] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [busy, setBusy] = useState(false);
  const [abortBusy, setAbortBusy] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [creatorError, setCreatorError] = useState<string>();
  const [refreshProblem, setRefreshProblem] = useState<string>();
  const [sessionSyncState, setSessionSyncState] = useState<"connecting" | "live" | "fallback">("connecting");
  const [sessionStreamGeneration, setSessionStreamGeneration] = useState(0);
  const [outbox, setOutbox] = useState<ReadonlyArray<OutboxItem>>([]);
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState>();
  const [slashCommandMenu, setSlashCommandMenu] = useState<SlashCommandMenuState>();
  const [mentionPickerQuery, setMentionPickerQuery] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<{ readonly key: string; readonly ok: boolean; readonly label: string }>();
  const [atBottom, setAtBottom] = useState(true);
  const [timelineWindowEnd, setTimelineWindowEnd] = useState<number>();
  const [timelineHistory, setTimelineHistory] = useState<{ readonly loading: boolean; readonly hasMore?: boolean; readonly error?: string }>({ loading: false });
  const [toolOutputs, setToolOutputs] = useState<Readonly<Record<string, { readonly status: "loading" | "loaded" | "failed"; readonly text?: string; readonly error?: string }>>>({});
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration>();
  const notifications = useNotifications();
  const previousMobileLayoutRef = useRef(isMobile);
  const isMobileRef = useRef(isMobile);
  const selectedSessionIdRef = useRef<string | undefined>(undefined);
  const selectedSessionRef = useRef<OwnedSession | undefined>(undefined);
  const requestedSessionIdRef = useRef(initialRequestedSessionId);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const timelineRef = useRef<HTMLElement>(null);
  const timelineScrollFrameRef = useRef(0);
  const timelineScrollTopRef = useRef(0);
  const timelinePointerScrollingRef = useRef(false);
  const timelineTouchYRef = useRef<number | undefined>(undefined);
  const timelinePrependAnchorRef = useRef<{ readonly height: number; readonly top: number } | undefined>(undefined);
  const timelineVirtualAnchorRef = useRef<{ readonly key: string; readonly top: number } | undefined>(undefined);
  const timelineWindowShiftingRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const mentionSearchInputRef = useRef<HTMLInputElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionReturnCursorRef = useRef<number | undefined>(undefined);
  const mentionSearchTimerRef = useRef(0);
  const copyFeedbackTimerRef = useRef(0);
  const mentionSearchGenerationRef = useRef(0);
  const lastMentionMenuRef = useRef<MentionMenuState | undefined>(undefined);
  const requestMentionSearchRef = useRef<(active: ActiveFileMention, query: string) => void>(() => undefined);
  const slashCommandCatalogRef = useRef(new Map<string, ReadonlyArray<PiSlashCommand>>());
  const slashCommandRequestsRef = useRef(new Map<string, Promise<ReadonlyArray<PiSlashCommand>>>());
  const dismissedSlashCommandRef = useRef<{ readonly text: string; readonly cursor: number } | undefined>(undefined);
  const completedMentionRef = useRef<{ readonly text: string; readonly cursor: number } | undefined>(undefined);
  const suppressMentionSelectionRef = useRef(false);
  const imagesRef = useRef<ReadonlyArray<ComposerImage>>([]);
  const imageSelectionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const shellRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const sessionHeadingRef = useRef<HTMLDivElement>(null);
  const globalPickerReturnFocusRef = useRef<HTMLElement | null>(null);
  const newSessionInputRef = useRef<HTMLInputElement>(null);
  const creatorReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceCreatorReturnFocusRef = useRef<HTMLElement | null>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const modelReturnFocusRef = useRef<HTMLElement | null>(null);
  const compactionReturnFocusRef = useRef<HTMLElement | null>(null);
  const archiveReturnFocusRef = useRef<HTMLElement | null>(null);
  const renameSessionReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const sessionSyncRef = useRef(initialSessionSyncState());
  const detailGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const sessionUiStatesRef = useRef(new Map<string, SessionUiState>());
  const currentSessionUiRef = useRef<SessionUiState>(emptySessionUiState());
  currentSessionUiRef.current = { commandText, images, delivery, busy, operationError, outbox };
  isMobileRef.current = isMobile;
  selectedSessionRef.current = selectedSession;
  if (mentionMenu) lastMentionMenuRef.current = mentionMenu;
  imagesRef.current = images;

  const dispatchSessionSync = useCallback((input: SessionSyncInput) => {
    const next = reduceSessionSync(sessionSyncRef.current, input);
    sessionSyncRef.current = next;
    if (next.sessionId === selectedSessionIdRef.current) {
      selectedSessionRef.current = next.session;
      setSelectedSession(next.session);
      setSessionSyncState(next.transport === "live" ? "live" : next.transport === "connecting" ? "connecting" : "fallback");
    }
    return next;
  }, []);

  const acceptAuthoritativeSession = useCallback((session: OwnedSession) => {
    const cursor = Math.max(sessionSyncRef.current.cursor, session.events.at(-1)?.sequence ?? 0);
    dispatchSessionSync({ type: "runtimeGenerationChanged", session, cursor });
  }, [dispatchSessionSync]);

  const dismissMentionMenu = useCallback(() => {
    window.clearTimeout(mentionSearchTimerRef.current);
    mentionSearchGenerationRef.current += 1;
    completedMentionRef.current = undefined;
    suppressMentionSelectionRef.current = true;
    setMentionMenu(undefined);
  }, []);

  // TODO(tracer): Compose workspace and command sources here once their first
  // picker actions have an end-to-end behavior worth exposing.
  const globalPickerItems = useMemo(() => state._tag === "Ready" ? sessionPickerItems(state.sessions, state.workspaces) : [], [state]);
  const matchingSlashCommands = useMemo(
    () => slashCommandMenu ? filterSlashCommands(slashCommandMenu.commands, slashCommandMenu.active.query).slice(0, 50) : [],
    [slashCommandMenu],
  );

  const openGlobalPicker = useCallback((returnFocus?: HTMLElement | null) => {
    globalPickerReturnFocusRef.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dismissMentionMenu();
    setSlashCommandMenu(undefined);
    setSidebarOpen(false);
    setGlobalPickerOpen(true);
  }, [dismissMentionMenu]);

  const closeGlobalPicker = useCallback(() => setGlobalPickerOpen(false), []);

  const selectSession = useCallback((sessionId: string | undefined, persistCurrent = true) => {
    const currentId = selectedSessionIdRef.current;
    if (currentId && persistCurrent) {
      sessionUiStatesRef.current.set(currentId, currentSessionUiRef.current);
      writeDraft(currentId, currentSessionUiRef.current.commandText, currentSessionUiRef.current.delivery);
    }
    const persisted = sessionId ? readDraft(sessionId) : undefined;
    const nextUi = sessionId
      ? sessionUiStatesRef.current.get(sessionId) ?? { ...emptySessionUiState(), commandText: persisted?.text ?? "", delivery: persisted?.delivery ?? "steer" }
      : emptySessionUiState();
    detailGeneration.current += 1;
    dismissMentionMenu();
    setSlashCommandMenu(undefined);
    selectedSessionIdRef.current = sessionId;
    sessionSyncRef.current = reduceSessionSync(sessionSyncRef.current, { type: "select", sessionId });
    followingRef.current = true;
    timelineScrollTopRef.current = 0;
    setTimelineWindowEnd(undefined);
    setAtBottom(true);
    setCommandText(nextUi.commandText);
    imagesRef.current = nextUi.images;
    setImages(nextUi.images);
    setDelivery(nextUi.delivery);
    setBusy(nextUi.busy);
    setOperationError(nextUi.operationError);
    setCopyFeedback(undefined);
    reviewGeneration.current += 1;
    setReviewState(undefined);
    setActiveView("agent");
    setModelDialogOpen(false);
    setCompactionDialogOpen(false);
    setArchiveTarget(undefined);
    setOutbox(nextUi.outbox);
    setSelectedSessionId(sessionId);
    selectedSessionRef.current = sessionSyncRef.current.session;
    setSelectedSession(sessionSyncRef.current.session);
    if (sessionId) {
      void readCachedSession(sessionId).then((cached) => {
        if (!cached || selectedSessionIdRef.current !== sessionId) return;
        dispatchSessionSync({ type: "cachedSnapshot", session: cached });
      });
    }
    writeLastOpenedSession(sessionId);
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [dismissMentionMenu, dispatchSessionSync]);

  const refresh = useCallback(async (initial = false) => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    const selectionAtStart = selectedSessionIdRef.current;
    try {
      const [{ workspaces }, { sessions }] = await Effect.runPromise(Effect.all([loadWorkspaces, loadSessions]));
      const nextWorkspaceId = workspaceIdRef.current && workspaces.some((workspace) => workspace.id === workspaceIdRef.current)
        ? workspaceIdRef.current
        : workspaces[0]?.id;
      workspaceIdRef.current = nextWorkspaceId;
      setWorkspaceId(nextWorkspaceId ?? "");
      const currentId = selectedSessionIdRef.current;
      const selectionChangedDuringRefresh = currentId !== selectionAtStart;
      const requestedId = requestedSessionIdRef.current;
      const nextId = currentId && (sessions.some((session) => session.id === currentId) || selectionChangedDuringRefresh)
        ? currentId
        : requestedId && sessions.some((session) => session.id === requestedId)
          ? requestedId
          : sessions[0]?.id;
      if (requestedId && nextId === requestedId) requestedSessionIdRef.current = undefined;
      setState({ _tag: "Ready", workspaces, sessions });
      setRefreshProblem(undefined);
      if (nextId !== currentId) selectSession(nextId);
      if (nextId && sessions.some((session) => session.id === nextId) && shouldPollSession(sessionSyncRef.current)) {
        const generation = ++detailGeneration.current;
        const request = sessionSyncRequest(sessionSyncRef.current);
        try {
          const { session } = await Effect.runPromise(loadSession(nextId, request.cursor || undefined));
          if (selectedSessionIdRef.current === nextId && detailGeneration.current === generation) {
            dispatchSessionSync({ type: "httpIncremental", session, request });
          }
        } catch (error) {
          if (selectedSessionIdRef.current === nextId && detailGeneration.current === generation) throw error;
        }
      }
    } catch (error) {
      if (initial) setState({ _tag: "Failed", message: errorMessage(error) });
      else setRefreshProblem(errorMessage(error));
    } finally {
      refreshInFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh(false);
      }
    }
  }, [dispatchSessionSync, selectSession]);

  useEffect(() => {
    const ready = (event: Event) => setUpdateRegistration((event as CustomEvent<ServiceWorkerRegistration>).detail);
    window.addEventListener("piss-update-ready", ready);
    return () => window.removeEventListener("piss-update-ready", ready);
  }, []);

  const globalPickerHotkeyEnabled = !globalPickerOpen
    && !creatorOpen && !workspaceCreatorOpen && !settingsOpen && !modelDialogOpen && !compactionDialogOpen
    && !selectedSession?.interactiveRequests[0] && !(isMobile && mentionMenu)
    && !archiveTarget && !renameSessionTarget && !renameWorkspaceTarget && !removeWorkspaceTarget;

  useHotkey(HOTKEYS.openGlobalPicker, () => openGlobalPicker(), {
    enabled: Boolean(globalPickerHotkeyEnabled),
    ignoreInputs: false,
    meta: { name: "Search sessions", description: "Open the global picker" },
  });

  useLayoutEffect(() => {
    const cursor = mentionReturnCursorRef.current;
    if (mentionMenu || cursor === undefined) return;
    mentionReturnCursorRef.current = undefined;
    composerTextareaRef.current?.focus();
    composerTextareaRef.current?.setSelectionRange(cursor, cursor);
  }, [mentionMenu]);

  useEffect(() => {
    pruneDrafts();
    const onStorage = (event: StorageEvent) => {
      const sessionId = selectedSessionIdRef.current;
      if (!sessionId || event.storageArea !== localStorage || event.key !== draftStorageKey(sessionId)) return;
      const draft = readDraft(sessionId);
      const nextText = draft?.text ?? "";
      const nextDelivery = draft?.delivery ?? currentSessionUiRef.current.delivery;
      currentSessionUiRef.current = { ...currentSessionUiRef.current, commandText: nextText, delivery: nextDelivery };
      setCommandText(nextText);
      setDelivery(nextDelivery);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    void refresh(true);
    const refreshTimer = window.setInterval(() => void refresh(false), 1_500);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 15_000);
    const media = window.matchMedia("(max-width: 760px)");
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        dispatchSessionSync({ type: "visibilityRestored" });
        setSessionStreamGeneration((current) => current + 1);
        void refresh(false);
      } else dispatchSessionSync({ type: "visibilityHidden" });
    };
    const networkDisconnected = () => dispatchSessionSync({ type: "networkDisconnected" });
    const networkReconnected = () => {
      dispatchSessionSync({ type: "networkReconnected" });
      setSessionStreamGeneration((current) => current + 1);
      void refresh(false);
    };
    const updateLayout = () => {
      setIsMobile(media.matches);
      if (!media.matches) {
        setSidebarOpen(false);
        const mention = lastMentionMenuRef.current;
        if (mention) window.setTimeout(() => requestMentionSearchRef.current(mention.active, mention.active.query), 50);
      }
    };
    media.addEventListener("change", updateLayout);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    window.addEventListener("offline", networkDisconnected);
    window.addEventListener("online", networkReconnected);
    if (!navigator.onLine) networkDisconnected();
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
      media.removeEventListener("change", updateLayout);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
      window.removeEventListener("offline", networkDisconnected);
      window.removeEventListener("online", networkReconnected);
    };
  }, [dispatchSessionSync, refresh]);

  useEffect(() => {
    const cacheable = sessionForSettledCache(sessionSyncRef.current);
    if (!cacheable || cacheable !== selectedSession) return;
    void writeCachedSession(cacheable).catch(() => undefined);
  }, [selectedSession]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionSyncState("connecting");
      return;
    }
    setSessionSyncState("connecting");
    return subscribeSession(
      selectedSessionId,
      sessionSyncRef.current.cursor || undefined,
      ({ session, reset }, sequence) => {
        if (selectedSessionIdRef.current !== selectedSessionId) return;
        dispatchSessionSync({ type: reset ? "snapshotReset" : "sseDelta", session, cursor: sequence, ...(reset ? { receivedAt: Date.now() } : {}) } as SessionSyncInput);
      },
      (connected) => dispatchSessionSync({ type: connected ? "streamValidated" : "streamFailed" }),
    );
  }, [dispatchSessionSync, selectedSessionId, sessionStreamGeneration]);

  useEffect(() => {
    if (!isMobile) {
      setMobileKeyboardOpen(false);
      return;
    }
    const viewport = window.visualViewport;
    let restingHeight = viewport?.height ?? window.innerHeight;
    const composerHasFocus = () => Boolean(composerRef.current?.contains(document.activeElement));
    const updateKeyboardState = () => {
      const height = viewport?.height ?? window.innerHeight;
      if (!composerHasFocus()) {
        restingHeight = Math.max(restingHeight, height);
        setMobileKeyboardOpen(false);
        return;
      }
      setMobileKeyboardOpen(restingHeight - height > 100);
    };
    const scheduleUpdate = () => window.requestAnimationFrame(updateKeyboardState);
    viewport?.addEventListener("resize", updateKeyboardState);
    window.addEventListener("resize", updateKeyboardState);
    document.addEventListener("focusin", scheduleUpdate);
    document.addEventListener("focusout", scheduleUpdate);
    updateKeyboardState();
    return () => {
      viewport?.removeEventListener("resize", updateKeyboardState);
      window.removeEventListener("resize", updateKeyboardState);
      document.removeEventListener("focusin", scheduleUpdate);
      document.removeEventListener("focusout", scheduleUpdate);
    };
  }, [isMobile]);

  useEffect(() => {
    if (!selectedSession || selectedSession.status !== "finished" && selectedSession.status !== "idle") return;
    const sessionId = selectedSession.id;
    const runtimeId = selectedSession.runtimeId;
    let cancelled = false;
    const request = sessionSyncRequest(sessionSyncRef.current);
    void Effect.runPromise(loadSessionUsage(sessionId, runtimeId)).then(
      ({ session }) => {
        if (cancelled || selectedSessionIdRef.current !== sessionId) return;
        dispatchSessionSync({ type: "httpIncremental", session, request });
      },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [selectedSession?.id, selectedSession?.runtimeId, selectedSession?.status]);

  useEffect(() => {
    if (activeView !== "details" || !selectedSession || selectedSession.status === "stopped" || selectedSession.status === "crashed" || selectedSession.status === "stopping") return;
    const sessionId = selectedSession.id;
    const runtimeId = selectedSession.runtimeId;
    let cancelled = false;
    const load = () => {
      const request = sessionSyncRequest(sessionSyncRef.current);
      void Effect.runPromise(loadSessionUsage(sessionId, runtimeId)).then(
        ({ session }) => {
          if (!cancelled && selectedSessionIdRef.current === sessionId) dispatchSessionSync({ type: "httpIncremental", session, request });
        },
        (cause) => {
          if (!cancelled && selectedSessionIdRef.current === sessionId) setOperationError(errorMessage(cause));
        },
      );
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeView, selectedSession?.id, selectedSession?.runtimeId, selectedSession?.status]);

  useEffect(() => {
    if (modelDialogOpen && selectedSession && !canConfigureSession(selectedSession.status)) setModelDialogOpen(false);
    if (selectedSession && !isWritableRuntime(selectedSession.status)) dismissMentionMenu();
  }, [dismissMentionMenu, modelDialogOpen, selectedSession?.status]);

  useEffect(() => {
    setTimelineHistory({ loading: false });
    setToolOutputs({});
  }, [selectedSession?.id]);

  const timeline = useMemo(() => eventTimeline(selectedSession?.events ?? []), [selectedSession]);
  const effectiveTimelineWindowEnd = timelineWindowEnd === undefined ? timeline.length : Math.min(timelineWindowEnd, timeline.length);
  const timelineWindowStart = Math.max(0, effectiveTimelineWindowEnd - TIMELINE_WINDOW_SIZE);
  const visibleTimeline = useMemo(
    () => timeline.slice(timelineWindowStart, effectiveTimelineWindowEnd),
    [effectiveTimelineWindowEnd, timeline, timelineWindowStart],
  );
  const oldestSequence = selectedSession?.events.at(0)?.sequence;
  const hasOlderTimeline = timelineHistory.hasMore ?? (oldestSequence !== undefined && oldestSequence > 1);

  const loadOlderTimeline = () => {
    if (!selectedSession || oldestSequence === undefined || timelineHistory.loading || !hasOlderTimeline) return;
    const element = timelineRef.current;
    if (element) timelinePrependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    followingRef.current = false;
    setAtBottom(false);
    setTimelineHistory((current) => ({ ...current, loading: true, error: undefined }));
    const sessionId = selectedSession.id;
    void Effect.runPromise(loadTimelinePage(sessionId, oldestSequence)).then(
      (page) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        setTimelineWindowEnd((current) => current === undefined ? undefined : current + page.events.length);
        dispatchSessionSync({ type: "historicalPage", events: page.events });
        setTimelineHistory({ loading: false, hasMore: page.hasMore });
      },
      (cause) => {
        timelinePrependAnchorRef.current = undefined;
        setTimelineHistory({ loading: false, hasMore: true, error: errorMessage(cause) });
      },
    );
  };

  const requestToolOutput = (sessionId: string, ref: string, force = false) => {
    if (!force && toolOutputs[ref]) return;
    setToolOutputs((current) => ({ ...current, [ref]: { status: "loading" } }));
    void Effect.runPromise(loadToolOutput(sessionId, ref)).then(
      (output) => {
        if (selectedSessionIdRef.current !== sessionId) return;
        setToolOutputs((current) => ({ ...current, [ref]: { status: "loaded", text: valueText(output.value) } }));
      },
      (cause) => setToolOutputs((current) => ({ ...current, [ref]: { status: "failed", error: errorMessage(cause) } })),
    );
  };

  const shiftTimelineWindow = (direction: "earlier" | "later", element: HTMLElement) => {
    if (timelineWindowShiftingRef.current) return;
    const currentEnd = effectiveTimelineWindowEnd;
    if (direction === "earlier" && timelineWindowStart === 0 || direction === "later" && currentEnd >= timeline.length) return;
    const rows = element.querySelectorAll<HTMLElement>("[data-timeline-key]");
    const anchor = direction === "earlier" ? rows[0] : rows[rows.length - 1];
    if (!anchor?.dataset.timelineKey) return;
    timelineVirtualAnchorRef.current = { key: anchor.dataset.timelineKey, top: anchor.getBoundingClientRect().top };
    timelineWindowShiftingRef.current = true;
    const nextEnd = direction === "earlier"
      ? Math.max(TIMELINE_WINDOW_SIZE, currentEnd - TIMELINE_WINDOW_SHIFT)
      : Math.min(timeline.length, currentEnd + TIMELINE_WINDOW_SHIFT);
    setTimelineWindowEnd(nextEnd >= timeline.length ? undefined : nextEnd);
  };

  useLayoutEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    const virtualAnchor = timelineVirtualAnchorRef.current;
    if (virtualAnchor) {
      const escapedKey = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(virtualAnchor.key) : virtualAnchor.key.replace(/["\\]/gu, "\\$&");
      const row = element.querySelector<HTMLElement>(`[data-timeline-key="${escapedKey}"]`);
      if (row) element.scrollTop += row.getBoundingClientRect().top - virtualAnchor.top;
      timelineVirtualAnchorRef.current = undefined;
      timelineWindowShiftingRef.current = false;
      timelineScrollTopRef.current = element.scrollTop;
    }
    const anchor = timelinePrependAnchorRef.current;
    if (anchor) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      timelineScrollTopRef.current = element.scrollTop;
      timelinePrependAnchorRef.current = undefined;
    }
    const pinToBottom = () => {
      if (!followingRef.current) return;
      window.cancelAnimationFrame(timelineScrollFrameRef.current);
      timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
        timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
          if (!followingRef.current) return;
          element.scrollTop = element.scrollHeight;
          timelineScrollTopRef.current = element.scrollTop;
          setAtBottom(true);
        });
      });
    };
    pinToBottom();
    const resizeObserver = new ResizeObserver(pinToBottom);
    for (const child of element.children) resizeObserver.observe(child);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(timelineScrollFrameRef.current);
    };
  }, [activeView, selectedSession?.runtimeId, timeline, timelineWindowEnd]);

  useEffect(() => {
    if (!selectedSession) return;
    setOutbox((items) => reconcileOutbox(items, selectedSession, timeline));
  }, [selectedSession?.id, selectedSession?.status, selectedSession?.events, timeline]);

  useEffect(() => {
    if (!selectedSession) return;
    const draft = readDraft(selectedSession.id);
    const latestUser = [...timeline].reverse().find((item) => item._tag === "message" && item.role === "user");
    if (!draft || !latestUser || latestUser._tag !== "message" || latestUser.text.trim() !== draft.text.trim()) return;
    const event = selectedSession.events.find((candidate) => candidate.sequence === latestUser.sequence);
    if (!event || Date.parse(event.timestamp) < draft.updatedAt - 2_000) return;
    removeDraft(selectedSession.id);
    if (currentSessionUiRef.current.commandText.trim() === draft.text.trim()) {
      currentSessionUiRef.current = { ...currentSessionUiRef.current, commandText: "" };
      setCommandText("");
    }
  }, [selectedSession?.id, selectedSession?.events, timeline]);

  useEffect(() => {
    const expirations = outbox.flatMap((item) => item.settledAt === undefined
      ? []
      : item.status === "delivered" ? [item.settledAt + 2_500]
      : item.status === "accepted" ? [item.settledAt + 5_000]
      : []);
    if (expirations.length === 0) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setOutbox((items) => items.filter((item) => item.settledAt === undefined
        || (item.status !== "accepted" && item.status !== "delivered")
        || item.settledAt + (item.status === "accepted" ? 5_000 : 2_500) > now));
    }, Math.max(0, Math.min(...expirations) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [outbox]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const timer = window.setTimeout(() => writeDraft(selectedSessionId, commandText, delivery), 200);
    return () => window.clearTimeout(timer);
  }, [selectedSessionId, commandText, delivery]);

  useEffect(() => {
    if (state._tag !== "Failed" || !routedSessionId) return;
    const timer = window.setTimeout(() => writeDraft(routedSessionId, commandText, delivery), 200);
    return () => window.clearTimeout(timer);
  }, [state._tag, routedSessionId, commandText, delivery]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const saveDraft = () => writeDraft(selectedSessionId, commandText, delivery);
    window.addEventListener("pagehide", saveDraft);
    return () => window.removeEventListener("pagehide", saveDraft);
  }, [selectedSessionId, commandText, delivery]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [commandText, selectedSessionId]);

  useEffect(() => {
    if (!mentionMenu || mentionMenu.mentions.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`file-mention-${mentionMenu.highlighted}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mentionMenu?.highlighted, mentionMenu?.mentions]);

  useEffect(() => {
    const wasMobile = previousMobileLayoutRef.current;
    previousMobileLayoutRef.current = isMobile;
    const rotatingMention = mentionMenu ?? lastMentionMenuRef.current;
    if (wasMobile && !isMobile && rotatingMention) {
      const active = rotatingMention.active;
      const cursor = active.end;
      window.setTimeout(() => requestMentionSearchRef.current(active, active.query), 50);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
        composerTextareaRef.current?.setSelectionRange(cursor, cursor);
      }));
    }
  }, [isMobile, mentionMenu?.active.end]);

  useEffect(() => () => {
    window.clearTimeout(mentionSearchTimerRef.current);
    window.clearTimeout(copyFeedbackTimerRef.current);
    mentionSearchGenerationRef.current += 1;
  }, []);

  const requestMentionSearch = useCallback((active: ActiveFileMention, query: string) => {
    const session = selectedSession;
    window.clearTimeout(mentionSearchTimerRef.current);
    const generation = ++mentionSearchGenerationRef.current;
    if (!session || !isWritableRuntime(session.status) || session.status === "blocked" || query.length > 200) {
      setMentionMenu(undefined);
      return;
    }

    setMentionMenu({ active, mentions: [], loading: true, highlighted: 0 });
    mentionSearchTimerRef.current = window.setTimeout(() => {
      void Effect.runPromise(searchFileMentions(session.id, session.runtimeId, query)).then(
        ({ mentions }) => {
          if (mentionSearchGenerationRef.current !== generation || selectedSessionIdRef.current !== session.id) return;
          setMentionMenu({ active, mentions, loading: false, highlighted: 0 });
        },
        (cause) => {
          if (mentionSearchGenerationRef.current !== generation || selectedSessionIdRef.current !== session.id) return;
          setMentionMenu({ active, mentions: [], loading: false, error: errorMessage(cause), highlighted: 0 });
        },
      );
    }, 100);
  }, [selectedSession?.id, selectedSession?.runtimeId, selectedSession?.status]);

  requestMentionSearchRef.current = requestMentionSearch;

  const scheduleMentionSearch = useCallback((text: string, cursor: number) => {
    const completed = completedMentionRef.current;
    if (completed?.text === text && completed.cursor === cursor) {
      setMentionMenu(undefined);
      return;
    }
    completedMentionRef.current = undefined;
    const active = activeFileMention(text, cursor);
    if (!active) {
      window.clearTimeout(mentionSearchTimerRef.current);
      mentionSearchGenerationRef.current += 1;
      setMentionMenu(undefined);
      return;
    }
    if (isMobile) setMentionPickerQuery(active.query);
    requestMentionSearch(active, active.query);
  }, [isMobile, requestMentionSearch]);

  const scheduleSlashCommandSearch = useCallback((text: string, cursor: number) => {
    const dismissed = dismissedSlashCommandRef.current;
    if (dismissed?.text === text && dismissed.cursor === cursor) {
      setSlashCommandMenu(undefined);
      return;
    }
    dismissedSlashCommandRef.current = undefined;
    const active = activeSlashCommand(text, cursor);
    const session = selectedSession;
    if (!active || !session || !isWritableRuntime(session.status) || session.status === "blocked") {
      setSlashCommandMenu(undefined);
      return;
    }

    dismissMentionMenu();
    const runtimeId = session.runtimeId;
    const cached = slashCommandCatalogRef.current.get(runtimeId);
    setSlashCommandMenu((current) => ({
      active,
      runtimeId,
      commands: cached ? slashCommandCatalog(cached) : (current?.runtimeId === runtimeId ? current.commands : slashCommandCatalog([])),
      loading: !cached,
    }));
    if (cached) return;

    let pending = slashCommandRequestsRef.current.get(runtimeId);
    if (!pending) {
      pending = Effect.runPromise(loadSlashCommands(session.id, runtimeId)).then(({ commands }) => commands);
      slashCommandRequestsRef.current.set(runtimeId, pending);
    }
    void pending.then(
      (commands) => {
        slashCommandRequestsRef.current.delete(runtimeId);
        slashCommandCatalogRef.current.set(runtimeId, commands);
        setSlashCommandMenu((current) => current?.runtimeId === runtimeId
          ? { ...current, commands: slashCommandCatalog(commands), loading: false }
          : current);
      },
      (cause) => {
        slashCommandRequestsRef.current.delete(runtimeId);
        setSlashCommandMenu((current) => current?.runtimeId === runtimeId
          ? { ...current, commands: slashCommandCatalog([]), loading: false, error: errorMessage(cause) }
          : current);
      },
    );
  }, [dismissMentionMenu, selectedSession?.id, selectedSession?.runtimeId, selectedSession?.status]);

  const dismissSlashCommandMenu = () => {
    const cursor = slashCommandMenu?.active.end ?? commandText.length;
    dismissedSlashCommandRef.current = { text: commandText, cursor };
    setSlashCommandMenu(undefined);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const removeSlashCommandTrigger = () => {
    if (!slashCommandMenu) return;
    const text = commandText.slice(slashCommandMenu.active.end);
    dismissedSlashCommandRef.current = undefined;
    setCommandText(text);
    setSlashCommandMenu(undefined);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(0, 0);
    });
  };

  const updateSlashCommandQuery = (query: string) => {
    if (!slashCommandMenu || query.length > 200 || /\s/u.test(query)) return;
    const text = `/${query}${commandText.slice(slashCommandMenu.active.end)}`;
    const cursor = query.length + 1;
    setCommandText(text);
    scheduleSlashCommandSearch(text, cursor);
  };

  const chooseSlashCommand = (item: SlashCommandItem) => {
    if (!slashCommandMenu) return;
    const applied = applySlashCommand(commandText, slashCommandMenu.active, item.name);
    setCommandText(applied.text);
    setSlashCommandMenu(undefined);
    window.requestAnimationFrame(() => {
      setCommandText((current) => current === `/${item.name}` ? `${current} ` : current);
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
        composerTextareaRef.current?.setSelectionRange(applied.cursor, applied.cursor);
      });
    });
  };

  const updateMentionQuery = (query: string) => {
    if (!mentionMenu || query.length > 200) return;
    setMentionPickerQuery(query);
    requestMentionSearch(mentionMenu.active, query);
  };

  const copyTimelineText = async (key: string, label: string, text: string) => {
    window.clearTimeout(copyFeedbackTimerRef.current);
    try {
      await copyToClipboard(text);
      setCopyFeedback({ key, ok: true, label });
    } catch {
      setCopyFeedback({ key, ok: false, label });
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => setCopyFeedback(undefined), 1_800);
  };

  const requestReview = async (session: OwnedSession) => {
    const generation = ++reviewGeneration.current;
    setReviewState((current) => ({ sessionId: session.id, loading: true, snapshot: current?.sessionId === session.id ? current.snapshot : undefined }));
    try {
      const { review } = await Effect.runPromise(loadReview(session.id, session.runtimeId));
      if (generation !== reviewGeneration.current || selectedSessionIdRef.current !== session.id) return;
      setReviewState({ sessionId: session.id, loading: false, snapshot: review });
    } catch (cause) {
      if (generation !== reviewGeneration.current || selectedSessionIdRef.current !== session.id) return;
      setReviewState({ sessionId: session.id, loading: false, error: errorMessage(cause) });
    }
  };

  const removeActiveMention = () => {
    if (!mentionMenu) return;
    const { start, end } = mentionMenu.active;
    const next = `${commandText.slice(0, start)}${commandText.slice(end)}`;
    setCommandText(next);
    mentionReturnCursorRef.current = start;
    dismissMentionMenu();
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(start, start);
    }));
  };

  const closeMentionPicker = () => {
    mentionReturnCursorRef.current = mentionMenu?.active.end ?? commandText.length;
    dismissMentionMenu();
  };

  const chooseMention = (item: FileMention) => {
    if (!mentionMenu) return;
    const applied = applyFileMention(commandText, mentionMenu.active, item.path);
    setCommandText(applied.text);
    setMentionMenu(undefined);
    completedMentionRef.current = applied;
    suppressMentionSelectionRef.current = true;
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(applied.cursor, applied.cursor);
    });
  };

  const insertMentionTrigger = () => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const separator = start > 0 && !/[ \t\n]/.test(commandText[start - 1] ?? "") ? " " : "";
    const next = `${commandText.slice(0, start)}${separator}@${commandText.slice(end)}`;
    const cursor = start + separator.length + 1;
    setCommandText(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      scheduleMentionSearch(next, cursor);
    });
  };

  const insertComposerNewline = (selectionStart?: number, selectionEnd?: number) => {
    const textarea = composerTextareaRef.current;
    const start = Math.max(0, Math.min(commandText.length, selectionStart ?? textarea?.selectionStart ?? commandText.length));
    const end = Math.max(start, Math.min(commandText.length, selectionEnd ?? textarea?.selectionEnd ?? start));
    const next = `${commandText.slice(0, start)}\n${commandText.slice(end)}`;
    const cursor = start + 1;
    dismissedSlashCommandRef.current = { text: next, cursor };
    setSlashCommandMenu(undefined);
    dismissMentionMenu();
    setCommandText(next);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  const createSession = async (event: FormEvent) => {
    event.preventDefault();
    if (state._tag !== "Ready") return;
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const sessionName = name.trim() || "New session";
    setBusy(true);
    setOperationError(undefined);
    try {
      const { session } = await Effect.runPromise(createOwnedSession({
        workspaceId: workspace.id,
        name: sessionName,
      }));
      setBusy(false);
      currentSessionUiRef.current = { ...currentSessionUiRef.current, busy: false };
      selectSession(session.id);
      acceptAuthoritativeSession(session);
      creatorReturnFocusRef.current = null;
      setCreatorOpen(false);
      setSidebarOpen(false);
      setCollapsedWorkspaceIds((current) => {
        if (!current.has(workspace.id)) return current;
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
      setName("");
      setCreatorError(undefined);
      window.requestAnimationFrame(() => sessionHeadingRef.current?.focus());
      void refresh(false);
    } catch (error) {
      setCreatorError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openWorkspaceCreator = () => {
    workspaceCreatorReturnFocusRef.current = isMobile && sidebarOpen
      ? mobileMenuRef.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setWorkspaceCreatorOpen(true);
    setSidebarOpen(false);
  };

  const openCreator = (nextWorkspaceId: string) => {
    creatorReturnFocusRef.current = isMobile && sidebarOpen
      ? mobileMenuRef.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    workspaceIdRef.current = nextWorkspaceId;
    setWorkspaceId(nextWorkspaceId);
    setCollapsedWorkspaceIds((current) => {
      if (!current.has(nextWorkspaceId)) return current;
      const next = new Set(current);
      next.delete(nextWorkspaceId);
      return next;
    });
    setName("");
    setCreatorError(undefined);
    setCreatorOpen(true);
    setSidebarOpen(false);
  };

  const closeCreator = () => {
    if (!busy) setCreatorOpen(false);
  };

  const openSession = async (sessionId: string) => {
    selectSession(sessionId);
    const generation = detailGeneration.current;
    setSidebarOpen(false);
    try {
      const loaded = (await Effect.runPromise(loadSession(sessionId))).session;
      const session = loaded.status === "finished"
        ? (await Effect.runPromise(acknowledgeOwnedSession(loaded.id, loaded.runtimeId))).session
        : loaded;
      if (selectedSessionIdRef.current === sessionId && detailGeneration.current === generation) acceptAuthoritativeSession(session);
    } catch (error) {
      if (selectedSessionIdRef.current === sessionId && detailGeneration.current === generation) setOperationError(errorMessage(error));
    }
  };

  const chooseGlobalPickerAction = (action: SelectSessionAction) => {
    setGlobalPickerOpen(false);
    globalPickerReturnFocusRef.current = sessionHeadingRef.current;
    if (action._tag === "SelectSession") void openSession(action.sessionId);
  };

  const selectImages = (files: FileList | ReadonlyArray<File>): Promise<void> => {
    const selected = Array.from(files);
    const targetSessionId = selectedSessionIdRef.current;
    if (selected.length === 0 || !targetSessionId) return Promise.resolve();

    const queued = imageSelectionQueueRef.current.then(async () => {
      const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
      const current = selectedSessionIdRef.current === targetSessionId ? imagesRef.current : stored.images;
      if (current.length + selected.length > 4) throw new Error("At most four images may be attached");
      const unsupported = selected.find((file) => !IMAGE_MEDIA_TYPES.has(file.type));
      if (unsupported) throw new Error(`Unsupported image type: ${unsupported.type || unsupported.name}`);
      if (current.reduce((total, image) => total + image.size, 0) + selected.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_BYTES) {
        throw new Error("Image attachments exceed the 10 MiB limit");
      }
      const additions = await Promise.all(selected.map(async (file): Promise<ComposerImage> => {
        const preview = await imageDataUrl(file);
        return {
          mediaType: file.type as ImageMediaType,
          data: preview.slice(preview.indexOf(",") + 1),
          name: file.name,
          preview,
          size: file.size,
        };
      }));
      const latestStored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
      const latest = selectedSessionIdRef.current === targetSessionId ? imagesRef.current : latestStored.images;
      if (latest.length + additions.length > 4) throw new Error("At most four images may be attached");
      if (latest.reduce((total, image) => total + image.size, 0) + additions.reduce((total, image) => total + image.size, 0) > MAX_IMAGE_BYTES) {
        throw new Error("Image attachments exceed the 10 MiB limit");
      }
      const next = [...latest, ...additions];
      if (selectedSessionIdRef.current === targetSessionId) {
        imagesRef.current = next;
        setImages(next);
        setOperationError(undefined);
      } else {
        sessionUiStatesRef.current.set(targetSessionId, { ...latestStored, images: next, operationError: undefined });
      }
    });
    imageSelectionQueueRef.current = queued.catch((error) => {
      const message = errorMessage(error);
      if (selectedSessionIdRef.current === targetSessionId) setOperationError(message);
      else {
        const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
        sessionUiStatesRef.current.set(targetSessionId, { ...stored, operationError: message });
      }
    });
    const currentQueue = imageSelectionQueueRef.current;
    setImageSelectionPending(true);
    void currentQueue.then(() => {
      if (imageSelectionQueueRef.current === currentQueue) setImageSelectionPending(false);
    });
    return currentQueue;
  };

  const command = async (action: OwnedSessionCommandAction) => {
    if (!selectedSession) return;
    const needsContent = action === "prompt" || action === "steer" || action === "followUp";
    if (needsContent && (imageSelectionPending || !commandText.trim() && images.length === 0)) return;
    const text = commandText.trim();
    const targetImages = needsContent ? images : [];
    const targetSessionId = selectedSession.id;
    const targetRuntimeId = selectedSession.runtimeId;
    const outgoing: OutboxItem | undefined = needsContent ? {
      id: crypto.randomUUID(),
      sessionId: selectedSession.id,
      text,
      imageCount: targetImages.length,
      action,
      submittedAfterSequence: selectedSession.events.at(-1)?.sequence ?? 0,
      status: "sending",
    } : undefined;
    if (outgoing) {
      setOutbox((items) => [...items, outgoing]);
      dismissMentionMenu();
      setSlashCommandMenu(undefined);
    }
    setBusy(true);
    setOperationError(undefined);
    try {
      await Effect.runPromise(sendSessionCommand({
        sessionId: targetSessionId,
        runtimeId: targetRuntimeId,
        commandId: outgoing?.id ?? crypto.randomUUID(),
        action,
        text: needsContent && text ? text : undefined,
        images: needsContent ? targetImages.map(({ preview: _preview, size: _size, ...image }) => image) : undefined,
      }));
      if (outgoing) {
        removeDraft(targetSessionId);
        if (selectedSessionIdRef.current === targetSessionId) {
          setCommandText("");
          imagesRef.current = [];
          setImages([]);
          setMentionMenu(undefined);
          setOutbox((items) => items.map((item) => item.id === outgoing.id ? { ...item, status: "accepted", settledAt: Date.now() } : item));
        } else {
          const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
          sessionUiStatesRef.current.set(targetSessionId, {
            ...stored,
            commandText: "",
            images: [],
            outbox: stored.outbox.map((item) => item.id === outgoing.id ? { ...item, status: "accepted", settledAt: Date.now() } : item),
          });
        }
      }
      await refresh(false);
    } catch (error) {
      const message = errorMessage(error);
      if (selectedSessionIdRef.current === targetSessionId) {
        if (outgoing) setOutbox((items) => items.map((item) => item.id === outgoing.id ? { ...item, status: "rejected", error: message } : item));
        setOperationError(message);
      } else {
        const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
        sessionUiStatesRef.current.set(targetSessionId, {
          ...stored,
          operationError: message,
          outbox: outgoing ? stored.outbox.map((item) => item.id === outgoing.id ? { ...item, status: "rejected", error: message } : item) : stored.outbox,
        });
      }
      await refresh(false);
    } finally {
      if (selectedSessionIdRef.current === targetSessionId) setBusy(false);
      else {
        const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
        sessionUiStatesRef.current.set(targetSessionId, { ...stored, busy: false });
      }
    }
  };

  const abortRun = async () => {
    const session = selectedSessionRef.current;
    if (!session || abortBusy) return;
    const targetId = session.id;
    setAbortBusy(true);
    setOperationError(undefined);
    try {
      await Effect.runPromise(sendSessionCommand({
        sessionId: session.id,
        runtimeId: session.runtimeId,
        commandId: crypto.randomUUID(),
        action: "abort",
      }));
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      setAbortBusy(false);
    }
  };

  const changeAutoCompaction = async (enabled: boolean) => {
    if (!selectedSession || busy) return;
    const targetId = selectedSession.id;
    setBusy(true);
    setOperationError(undefined);
    try {
      const { session } = await Effect.runPromise(setSessionAutoCompaction(selectedSession.id, selectedSession.runtimeId, enabled));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(session);
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
    } finally {
      if (selectedSessionIdRef.current === targetId) setBusy(false);
    }
  };

  const compactNow = async () => {
    if (!selectedSession || busy) return;
    const targetId = selectedSession.id;
    setCompactionDialogOpen(false);
    setBusy(true);
    setOperationError(undefined);
    try {
      const { session } = await Effect.runPromise(compactSession(selectedSession.id, selectedSession.runtimeId));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(session);
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      if (selectedSessionIdRef.current === targetId) setBusy(false);
    }
  };

  const answerInteractive = async (request: InteractiveRequest, response: { readonly cancelled?: boolean; readonly value?: string; readonly confirmed?: boolean }) => {
    if (!selectedSession || busy || selectedSession.runtimeId === "") return;
    const targetId = selectedSession.id;
    setBusy(true);
    setOperationError(undefined);
    try {
      const { session } = await Effect.runPromise(respondToInteractiveRequest({
        sessionId: selectedSession.id,
        runtimeId: selectedSession.runtimeId,
        requestId: request.id,
        ...response,
      }));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(session);
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      if (selectedSessionIdRef.current === targetId) setBusy(false);
    }
  };

  const resumeSession = async () => {
    if (!selectedSession || busy || (selectedSession.status !== "stopped" && selectedSession.status !== "crashed")) return;
    const targetId = selectedSession.id;
    setBusy(true);
    setOperationError(undefined);
    try {
      const { session } = await Effect.runPromise(resumeOwnedSession(selectedSession.id, selectedSession.runtimeId));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(session);
      await refresh(false);
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      if (selectedSessionIdRef.current === targetId) setBusy(false);
    }
  };

  const runNativeSlashCommand = (nativeCommand: NativeSlashCommandName) => {
    if (!selectedSession) return;
    setCommandText("");
    setSlashCommandMenu(undefined);
    switch (nativeCommand) {
      case "resume":
        openGlobalPicker(composerTextareaRef.current);
        return;
      case "new":
        openCreator(selectedSession.workspaceId);
        return;
      case "model":
        modelReturnFocusRef.current = composerTextareaRef.current;
        setModelDialogOpen(true);
        return;
      case "compact":
        compactionReturnFocusRef.current = composerTextareaRef.current;
        setCompactionDialogOpen(true);
        return;
      case "name": {
        const summary = state._tag === "Ready" ? state.sessions.find(({ id }) => id === selectedSession.id) : undefined;
        if (summary) {
          renameSessionReturnFocusRef.current = composerTextareaRef.current;
          setRenameSessionTarget(summary);
        }
        return;
      }
      case "session":
        setActiveView("details");
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".details-tab")?.focus());
        return;
    }
  };

  const submitCommand = () => {
    if (!selectedSession || imageSelectionPending || (!commandText.trim() && images.length === 0)) return;
    const nativeCommand = nativeSlashCommand(commandText);
    if (nativeCommand) {
      runNativeSlashCommand(nativeCommand);
      return;
    }
    if (isSlashCommandInput(commandText)) void command("prompt");
    else if (selectedSession.status === "working") void command(delivery);
    else if (canAcceptPrompt(selectedSession.status)) void command("prompt");
  };

  const archiveSession = async () => {
    if (!archiveTarget || archivePending) return;
    setArchivePending(true);
    setArchiveError(undefined);
    try {
      await Effect.runPromise(archiveOwnedSession(archiveTarget.id, archiveTarget.runtimeId));
      await removeCachedSession(archiveTarget.id).catch(() => undefined);
      if (selectedSessionIdRef.current === archiveTarget.id) dispatchSessionSync({ type: "sessionDeleted" });
      sessionUiStatesRef.current.delete(archiveTarget.id);
      removeDraft(archiveTarget.id);
      if (state._tag === "Ready") {
        const remaining = state.sessions.filter((session) => session.id !== archiveTarget.id);
        const nextInWorkspace = remaining.find((session) => session.workspaceId === archiveTarget.workspaceId);
        setState({ ...state, sessions: remaining });
        if (selectedSessionIdRef.current === archiveTarget.id) selectSession(nextInWorkspace?.id ?? remaining[0]?.id, false);
      }
      setArchiveTarget(undefined);
      window.requestAnimationFrame(() => {
        if (!archiveReturnFocusRef.current?.isConnected) sessionHeadingRef.current?.focus();
      });
      void refresh(false);
    } catch (cause) {
      setArchiveError(errorMessage(cause));
    } finally {
      setArchivePending(false);
    }
  };

  const selectedSessionSummary = state._tag === "Ready" && selectedSessionId
    ? state.sessions.find((session) => session.id === selectedSessionId)
    : undefined;
  const selectedWorkspace = state._tag === "Ready" && selectedSession
    ? state.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId)
    : undefined;
  const interactiveRequest = selectedSession?.interactiveRequests[0];
  const runtimeIsCurrent = Boolean(selectedSession && sessionSyncRef.current.runtimeGenerationConfirmed && selectedSessionSummary?.runtimeId === selectedSession.runtimeId && sessionSyncState !== "connecting");
  const canWrite = selectedSession ? runtimeIsCurrent && isWritableRuntime(selectedSession.status) && selectedSession.status !== "blocked" : false;
  const canConfigure = selectedSession ? runtimeIsCurrent && canConfigureSession(selectedSession.status) : false;
  const slashCommandMode = isSlashCommandInput(commandText);
  const chosenWorkspace = state._tag === "Ready" ? state.workspaces.find((workspace) => workspace.id === workspaceId) : undefined;
  const networkState = state._tag === "Failed" || refreshProblem
    ? "offline"
    : state._tag === "Loading" || Boolean(selectedSessionId && sessionSyncState !== "live")
      ? "syncing"
      : "live";
  const networkLabel = networkState === "offline"
    ? "OFFLINE"
    : selectedSessionId && sessionSyncState === "fallback" && state._tag === "Ready"
      ? "POLLING"
      : networkState === "syncing"
        ? "SYNCING"
        : "LIVE";
  const contextPercent = selectedSession?.usage?.contextUsage?.percent ?? null;
  const contextTone = contextPercent === null ? "unknown" : contextPercent >= 85 ? "danger" : contextPercent >= 70 ? "warning" : "healthy";
  const pickerShortcutLabel = formatForDisplay(HOTKEYS.openGlobalPicker);

  return (
    <Drawer.Root open={isMobile ? sidebarOpen : true} modal={isMobile} swipeDirection="left" onOpenChange={(open, details) => {
      if (!isMobile) { details.cancel(); return; }
      setSidebarOpen(open);
    }}>
    <div className={`shell ${mobileKeyboardOpen ? "mobile-keyboard-open" : ""}`} ref={shellRef}>
      <header className="masthead">
        <Drawer.Trigger className="mobile-menu" ref={mobileMenuRef} aria-label="Open workspaces and sessions"><Menu aria-hidden="true" /></Drawer.Trigger>
        <div className={`brand ${selectedSession ? "session-brand" : ""}`} title={selectedWorkspace?.root} ref={sessionHeadingRef} tabIndex={-1}>
          {selectedSession && <>
            <span className="brand-mark">π</span>
            <div>
              <b>{selectedSession.name}</b>
              <small><span>{selectedWorkspace?.name ?? "Workspace"}{selectedSession.branch ? ` · ${selectedSession.branch}` : ""}</span><span className="session-runtime"> · {selectedSession.model?.name ?? "No model"} · {selectedSession.thinkingLevel ?? "off"}</span></small>
            </div>
          </>}
        </div>
        <button className="global-picker-trigger" type="button" onClick={(event) => openGlobalPicker(event.currentTarget)} aria-label="Search sessions" title={`Search sessions (${pickerShortcutLabel})`}><Search aria-hidden="true" /><span>SEARCH SESSIONS</span><kbd>{pickerShortcutLabel}</kbd></button>
        {updateRegistration?.waiting && <button className="update-ready" type="button" disabled={busy} onClick={() => updateRegistration.waiting?.postMessage({ type: "SKIP_WAITING" })}>{busy ? "UPDATE WAITING" : "APPLY UPDATE"}</button>}
        <div className={`network ${networkState}`} role="status"><i />{networkLabel}</div>
      </header>

      <Drawer.Portal container={isMobile ? undefined : shellRef}>
      <Drawer.Backdrop className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`} />
      <Drawer.Popup className={`rail ${sidebarOpen ? "mobile-open" : ""}`} role={isMobile ? "dialog" : "complementary"} initialFocus={true} finalFocus={mobileMenuRef} render={<aside aria-label="Workspaces and sessions" />}>
        <Drawer.Close className="sr-only">Close navigation</Drawer.Close>
        <div className="rail-label">
          <span>WORKSPACES</span>
          <div className="rail-actions">
            <button className="open-settings" onClick={(event) => {
              settingsReturnFocusRef.current = event.currentTarget;
              if (isMobile) setSidebarOpen(false);
              setSettingsOpen(true);
            }} type="button" aria-label="Open settings" title="Settings"><Settings aria-hidden="true" /></button>
            <button className="add-workspace" onClick={openWorkspaceCreator} type="button" aria-label="Create workspace" title="Create workspace"><Plus aria-hidden="true" /></button>
          </div>
        </div>
        <div className="workspace-list">
          {state._tag === "Loading" && <div className="rail-state">Loading…</div>}
          {state._tag === "Failed" && <div className="rail-state error">{state.message}</div>}
          {state._tag === "Ready" && state.workspaces.length === 0 && <div className="rail-state">No workspaces</div>}
          {state._tag === "Ready" && state.workspaces.map((workspace) => {
            const sessions = state.sessions.filter((session) => session.workspaceId === workspace.id);
            const collapsed = collapsedWorkspaceIds.has(workspace.id);
            return <section className={`workspace-group ${collapsed ? "collapsed" : ""}`} key={workspace.id}>
              <Collapsible.Root open={!collapsed} onOpenChange={(open) => setCollapsedWorkspaceIds((current) => {
                const next = new Set(current);
                if (open) next.delete(workspace.id);
                else next.add(workspace.id);
                return next;
              })}>
              <header className="workspace-heading">
                <Collapsible.Trigger className="workspace-toggle">
                  <i aria-hidden="true"><ChevronRight /></i><span><b>{workspace.name}</b><small className="workspace-path" title={workspace.root}><span>{workspace.root}</span></small></span>
                </Collapsible.Trigger>
                <ActionMenu
                  className="workspace-actions"
                  triggerClassName="workspace-menu-trigger"
                  triggerLabel={`Workspace settings for ${workspace.name}`}
                  menuLabel={`${workspace.name} workspace settings`}
                  actions={[
                    { label: "RENAME", onSelect: (returnFocus) => {
                      workspaceActionReturnFocusRef.current = returnFocus;
                      setRenameWorkspaceTarget(workspace);
                    } },
                    { label: "REMOVE", danger: true, onSelect: (returnFocus) => {
                      workspaceActionReturnFocusRef.current = returnFocus;
                      setRemoveWorkspaceTarget(workspace);
                    } },
                  ]}
                />
                <button className="add-session" onClick={() => openCreator(workspace.id)} title={`New session in ${workspace.name}`} aria-label={`New session in ${workspace.name}`} type="button"><Plus aria-hidden="true" /></button>
              </header>
              <Collapsible.Panel className="session-list">
                {sessions.length === 0 && <div className="empty-workspace">No sessions</div>}
                {sessions.map((session) => {
                  const status = displayStatus(session.status);
                  return <div className="session-row" key={session.id}>
                    <button className={`session-card ${session.id === selectedSessionId ? "selected" : ""}`} onClick={() => void openSession(session.id)} type="button" aria-current={session.id === selectedSessionId ? "page" : undefined}>
                      <i className={`state-dot ${status}`} />
                      <span className="session-copy"><strong>{session.name}</strong><small>{ATTENTION_STATE_LABELS[session.status]} · {session.eventCount} events · {relativeTime(session.lastActivityAt, now)}</small></span>
                    </button>
                    <ActionMenu
                      className="session-actions"
                      triggerClassName="session-menu-trigger"
                      triggerLabel={`Session settings for ${session.name}`}
                      menuLabel={`${session.name} session settings`}
                      actions={[
                        { label: "RENAME", onSelect: (returnFocus) => {
                          renameSessionReturnFocusRef.current = returnFocus;
                          setRenameSessionTarget(session);
                        } },
                        { label: "ARCHIVE", danger: true, onSelect: (returnFocus) => {
                          archiveReturnFocusRef.current = returnFocus;
                          setArchiveError(undefined);
                          setArchiveTarget(session);
                        } },
                      ]}
                    />
                  </div>;
                })}
              </Collapsible.Panel>
              </Collapsible.Root>
            </section>;
          })}
        </div>
      </Drawer.Popup>
      </Drawer.Portal>

      <main className="workspace">
        {(operationError || refreshProblem) && <button className="operation-error" onClick={() => { setOperationError(undefined); setRefreshProblem(undefined); }} type="button" aria-live="assertive">{operationError ?? `Refresh failed: ${refreshProblem}`}<span aria-hidden="true"><X /></span></button>}
        {selectedSession ? <Tabs.Root className="session-view" value={activeView} onValueChange={(value) => {
          const next = value as "agent" | "changes" | "details";
          setActiveView(next);
          if (next === "changes") void requestReview(selectedSession);
        }}>
          <Tabs.List className="capability-tabs" aria-label="Session views">
            <Tabs.Tab className={activeView === "agent" ? "active" : ""} value="agent"><Bot aria-hidden="true" /> Agent</Tabs.Tab>
            <Tabs.Tab className={activeView === "changes" ? "active" : ""} value="changes"><FileDiff aria-hidden="true" /> Changes{reviewState?.sessionId === selectedSession.id && reviewState.snapshot && reviewState.snapshot.totalFiles > 0 && <em>{reviewState.snapshot.totalFiles}</em>}</Tabs.Tab>
            <Tabs.Tab className={`details-tab ${activeView === "details" ? "active" : ""}`} value="details"><Gauge aria-hidden="true" /> Details</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel className="timeline-wrap" value={activeView}>
            <section
              className={`timeline ${activeView === "changes" ? "review-stream" : activeView === "details" ? "details-stream" : ""}`}
              id="session-view-panel"
              role="tabpanel"
              ref={timelineRef}
              aria-live={activeView === "agent" ? "polite" : "off"}
              onWheel={(event) => {
                if (event.deltaY < 0) {
                  followingRef.current = false;
                  setAtBottom(false);
                }
              }}
              onPointerDown={() => { timelinePointerScrollingRef.current = true; }}
              onPointerUp={() => { timelinePointerScrollingRef.current = false; }}
              onPointerCancel={() => { timelinePointerScrollingRef.current = false; }}
              onTouchStart={(event) => { timelineTouchYRef.current = event.touches[0]?.clientY; }}
              onTouchMove={(event) => {
                const nextY = event.touches[0]?.clientY;
                if (nextY !== undefined && timelineTouchYRef.current !== undefined && nextY > timelineTouchYRef.current + 1) {
                  followingRef.current = false;
                  setAtBottom(false);
                }
                timelineTouchYRef.current = nextY;
              }}
              onTouchEnd={() => { timelineTouchYRef.current = undefined; }}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                if (element.scrollTop < 24) shiftTimelineWindow("earlier", element);
                else if (distanceFromBottom < 24 && effectiveTimelineWindowEnd < timeline.length) shiftTimelineWindow("later", element);
                const nextAtBottom = effectiveTimelineWindowEnd >= timeline.length && distanceFromBottom < 4;
                const draggedUp = timelinePointerScrollingRef.current && element.scrollTop < timelineScrollTopRef.current - 1;
                timelineScrollTopRef.current = element.scrollTop;
                if (draggedUp) followingRef.current = false;
                else if (nextAtBottom) followingRef.current = true;
                setAtBottom(nextAtBottom);
              }}
            >
              <span className="sr-only" aria-live="polite">{copyFeedback ? `${copyFeedback.ok ? "Copied" : "Could not copy"} ${copyFeedback.label}` : ""}</span>
              {activeView === "agent" && (hasOlderTimeline || timelineHistory.error) && <div className="timeline-history-control">
                <button type="button" disabled={timelineHistory.loading} onClick={loadOlderTimeline}><ArrowUp aria-hidden="true" />{timelineHistory.loading ? "LOADING EARLIER ACTIVITY…" : timelineHistory.error ? "RETRY EARLIER ACTIVITY" : "LOAD EARLIER ACTIVITY"}</button>
                {timelineHistory.error && <small role="alert">{timelineHistory.error}</small>}
              </div>}
              {activeView === "agent" && selectedSession.compaction.status === "running" && <div className="active-operation compaction" role="status">
                <span className="operation-glyph"><RefreshCw aria-hidden="true" /></span>
                <div><b>{selectedSession.compaction.reason === "overflow" ? "RECOVERING CONTEXT" : "COMPACTING CONTEXT"}</b><span>{selectedSession.compaction.reason === "overflow" ? "Pi is compressing history, then it will retry automatically." : "Recent work stays verbatim while older history becomes a durable summary."}</span></div>
                <small>IN PROGRESS</small>
              </div>}
              {selectedSession.error && <div className="runtime-error"><b>RUNTIME ERROR</b>{selectedSession.error}</div>}
              {activeView === "agent" && timeline.length === 0 && selectedSession.status === "starting" && <div className="timeline-empty"><p>Starting…</p></div>}
              {activeView === "agent" && visibleTimeline.map((item) => item._tag === "message"
                ? <article className={`message ${item.role} ${item.live ? "live" : ""}`} key={item.key} data-timeline-key={item.key}>
                    <header><span>{item.role === "assistant" ? "PI" : "REMOTE"}</span>{item.live && <i>STREAMING</i>}<button className={`timeline-copy ${copyFeedback?.key === item.key ? copyFeedback.ok ? "copied" : "failed" : ""}`} onClick={() => void copyTimelineText(item.key, `${item.role === "assistant" ? "PI" : "REMOTE"} message`, item.text || `${item.imageCount} image${item.imageCount === 1 ? "" : "s"} attached`)} type="button" aria-label={`${copyFeedback?.key === item.key ? copyFeedback.ok ? "Copied" : "Copy failed" : "Copy"} ${item.role === "assistant" ? "PI" : "REMOTE"} message`}><Copy aria-hidden="true" /><b>{copyFeedback?.key === item.key ? copyFeedback.ok ? "COPIED" : "FAILED" : "COPY"}</b></button></header>
                    {item.text && <LazyMarkdown text={item.text} />}
                    {item.imageCount > 0 && <div className="message-images"><Image aria-hidden="true" /> {item.imageCount} IMAGE{item.imageCount === 1 ? "" : "S"} ATTACHED</div>}
                  </article>
                : item._tag === "status"
                  ? <div className={`timeline-status ${item.tone}`} key={item.key} data-timeline-key={item.key} role="status">
                      <span>{item.tone === "running" ? <RefreshCw aria-hidden="true" /> : item.tone === "success" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</span>
                      <div><b>{item.label}</b><small>{item.detail}</small></div>
                    </div>
                : item._tag === "notice"
                  ? <article className={`extension-notice ${item.tone}`} key={item.key} data-timeline-key={item.key} role={item.tone === "error" ? "alert" : "status"}>
                      <header><Bell aria-hidden="true" /><b>{item.tone === "error" ? "EXTENSION ERROR" : item.tone === "warning" ? "EXTENSION WARNING" : "PI NOTICE"}</b></header>
                      <pre>{item.text}</pre>
                    </article>
                : item.state === "running"
                  ? <div className={`tool-row ${item.error ? "error" : ""}`} key={item.key} data-timeline-key={item.key}>
                      <i className="running" /><div><b>{item.name}</b><span>{compact(item.detail)}</span></div><small>running</small>
                    </div>
                  : (() => {
                      const output = item.outputRef ? toolOutputs[item.outputRef] : undefined;
                      const text = output?.status === "loaded" ? output.text ?? "" : item.detail;
                      return <details className={`tool-result ${item.error ? "error" : ""}`} key={item.key} data-timeline-key={item.key} onToggle={(event) => {
                        if (event.currentTarget.open && item.outputRef) requestToolOutput(selectedSession.id, item.outputRef);
                      }}>
                        <summary><i /><b>{item.name}</b><span>{compact(item.detail)}</span><small>{item.error ? "error" : "done"}</small><strong aria-hidden="true"><Plus /></strong></summary>
                        {item.outputRef && <div className={`tool-output-state ${output?.status ?? "preview"}`}><span>{output?.status === "loading" ? "Loading full output…" : output?.status === "failed" ? "Full output unavailable" : output?.status === "loaded" ? "Full output loaded" : "Preview · full output loads when expanded"}</span><small>{item.outputBytes?.toLocaleString() ?? "?"} bytes</small>{output?.status === "failed" && <button type="button" onClick={() => requestToolOutput(selectedSession.id, item.outputRef!, true)}>RETRY</button>}</div>}
                        <div className="tool-result-actions"><button className={`timeline-copy ${copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "copied" : "failed" : ""}`} onClick={() => void copyTimelineText(`tool:${item.key}`, `${item.name} tool output`, text)} type="button" aria-label={`${copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "Copied" : "Copy failed" : "Copy"} ${item.name} tool output`}><Copy aria-hidden="true" /><b>{copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "COPIED" : "FAILED" : "COPY"}</b></button></div>
                        <pre>{output?.status === "loading" ? "Loading full output…" : output?.status === "failed" ? `${item.detail}\n\n[${output.error ?? "Full output could not be loaded"}]` : text}</pre>
                      </details>;
                    })())}
              {activeView === "changes" && <ReviewView state={reviewState?.sessionId === selectedSession.id ? reviewState : undefined} onRefresh={() => void requestReview(selectedSession)} />}
              {activeView === "details" && <div className="details-view">
                <header className="details-heading"><div><span>SESSION</span><h2>Details</h2></div><b>{selectedSession.usage?.contextUsage?.percent !== null && selectedSession.usage?.contextUsage?.percent !== undefined ? `${selectedSession.usage.contextUsage.percent.toFixed(1)}% CONTEXT` : selectedSession.usage ? "CONTEXT RECALCULATING" : "USAGE NOT LOADED"}</b></header>
                <section className="session-details" role="region" aria-label="Session usage and compaction" aria-busy={selectedSession.compaction.status === "running"}>
                  <div className="usage-metrics">
                    <span><small>CONTEXT</small><b>{selectedSession.usage?.contextUsage?.tokens === null ? "Recalculating" : selectedSession.usage?.contextUsage ? `${selectedSession.usage.contextUsage.tokens.toLocaleString()} / ${selectedSession.usage.contextUsage.contextWindow.toLocaleString()}` : "Not reported"}</b></span>
                    <span><small>TOKENS IN / OUT</small><b>{selectedSession.usage ? `${selectedSession.usage.tokens.input.toLocaleString()} / ${selectedSession.usage.tokens.output.toLocaleString()}` : "Not reported"}</b></span>
                    <span><small>CACHE READ / WRITE</small><b>{selectedSession.usage ? `${selectedSession.usage.tokens.cacheRead.toLocaleString()} / ${selectedSession.usage.tokens.cacheWrite.toLocaleString()}` : "Not reported"}</b></span>
                    <span><small>SESSION COST</small><b>{selectedSession.usage?.cost === null || selectedSession.usage?.cost === undefined ? "Not reported" : `$${selectedSession.usage.cost.toFixed(4)}`}</b></span>
                    <span><small>PENDING</small><b>{selectedSession.pendingMessageCount} message{selectedSession.pendingMessageCount === 1 ? "" : "s"}</b></span>
                    <span><small>COMPACTION</small><b>{selectedSession.compaction.status}{selectedSession.compaction.tokensBefore !== null ? ` · ${selectedSession.compaction.tokensBefore.toLocaleString()} → ${selectedSession.compaction.estimatedTokensAfter?.toLocaleString() ?? "?"}` : ""}</b></span>
                  </div>
                  {selectedSession.compaction.error && <p className="compaction-error" role="alert">{selectedSession.compaction.error}</p>}
                  <div className="compaction-actions">
                    <button type="button" aria-pressed={selectedSession.autoCompactionEnabled === true} disabled={busy || !canConfigure || selectedSession.autoCompactionEnabled === null} onClick={() => void changeAutoCompaction(selectedSession.autoCompactionEnabled !== true)}>AUTO COMPACT: {selectedSession.autoCompactionEnabled === null ? "UNKNOWN" : selectedSession.autoCompactionEnabled ? "ON" : "OFF"}</button>
                    <button type="button" disabled={busy || !canConfigure || selectedSession.compaction.status === "running"} onClick={(event) => { compactionReturnFocusRef.current = event.currentTarget; setCompactionDialogOpen(true); }}>{selectedSession.compaction.status === "running" ? "COMPACTING…" : "COMPACT NOW"}</button>
                  </div>
                </section>
              </div>}
            </section>
            {activeView === "agent" && <button className={`jump-bottom ${atBottom ? "at-bottom" : ""}`} onClick={() => { followingRef.current = true; setTimelineWindowEnd(undefined); setAtBottom(true); window.requestAnimationFrame(() => { if (timelineRef.current) { timelineRef.current.scrollTop = timelineRef.current.scrollHeight; timelineScrollTopRef.current = timelineRef.current.scrollTop; } }); }} aria-label="Jump to latest message" type="button"><ArrowDown aria-hidden="true" /><small>LATEST</small></button>}
          </Tabs.Panel>

          <section className="control-deck">
            {outbox.length > 0 && <section className="outbox-tray" aria-label="Outgoing messages" aria-live="polite">
              <header><span>OUTGOING</span><b>{outbox.length.toString().padStart(2, "0")}</b></header>
              {outbox.map((item) => <article className={`outbox-message ${item.status}`} key={item.id}>
                <i /><div><header><b>{item.action === "followUp" ? "FOLLOW-UP" : item.action.toUpperCase()}</b><small>{item.status === "sending" ? "SENDING TO PI" : item.status === "accepted" ? "ACCEPTED BY PI" : item.status === "delivered" ? "SENT TO PI" : item.error ?? "REJECTED"}</small></header><p>{item.text || `${item.imageCount ?? 0} attached image${item.imageCount === 1 ? "" : "s"}`}</p></div>
                {item.status === "rejected" && <button onClick={() => setOutbox((items) => items.filter((candidate) => candidate.id !== item.id))} type="button" aria-label="Dismiss rejected message"><X aria-hidden="true" /></button>}
              </article>)}
            </section>}
            <div className="composer" ref={composerRef}>
              <span className="sr-only" id="composer-picker-status" aria-live="polite">
                {slashCommandMenu?.loading
                  ? "Reading Pi commands"
                  : slashCommandMenu
                    ? matchingSlashCommands.length
                      ? `${matchingSlashCommands.length} Pi command options. Use the up and down arrows, then Enter to insert.`
                      : slashCommandMenu.error ?? "No matching Pi commands"
                    : mentionMenu?.loading
                      ? "Searching workspace files"
                      : mentionMenu?.mentions.length
                        ? `${mentionMenu.mentions.length} workspace file options. ${mentionMenu.mentions[mentionMenu.highlighted]?.name ?? "First option"} selected. Use the up and down arrows, then Enter to select.`
                        : mentionMenu?.error ?? (mentionMenu ? "No matching workspace files" : "Type slash for Pi commands or at to mention a workspace file")}
              </span>
              {slashCommandMenu && <SlashCommandMenu
                commands={matchingSlashCommands}
                query={slashCommandMenu.active.query}
                loading={slashCommandMenu.loading}
                error={slashCommandMenu.error}
                onQueryChange={updateSlashCommandQuery}
                onChoose={chooseSlashCommand}
                onDismiss={dismissSlashCommandMenu}
                onRemoveTrigger={removeSlashCommandTrigger}
                onInsertNewline={() => insertComposerNewline(slashCommandMenu.active.end)}
              />}
              {mentionMenu && !isMobile && <Popover.Root open modal={false} onOpenChange={(open) => { if (!open) dismissMentionMenu(); }}>
                <Popover.Portal>
                  <Popover.Positioner className="mention-menu-positioner" anchor={composerTextareaRef} side="top" align="start" sideOffset={7} collisionPadding={8} positionMethod="fixed">
                    <Popover.Popup className="mention-menu" id="file-mention-options" role={mentionMenu.mentions.length > 0 ? "listbox" : "status"} aria-label={mentionMenu.mentions.length > 0 ? "Workspace files" : undefined} aria-live={mentionMenu.mentions.length > 0 ? undefined : "polite"} initialFocus={false} finalFocus={false}>
                      {mentionMenu.loading && <div className="mention-state">Searching files…</div>}
                      {!mentionMenu.loading && mentionMenu.error && <div className="mention-state error">{mentionMenu.error}</div>}
                      {!mentionMenu.loading && !mentionMenu.error && mentionMenu.mentions.length === 0 && <div className="mention-state">No matching files</div>}
                      {!mentionMenu.loading && mentionMenu.mentions.map((item, index) => <button className={index === mentionMenu.highlighted ? "active" : ""} id={`file-mention-${index}`} key={`${item.kind}:${item.path}`} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(item)} onMouseEnter={() => setMentionMenu((current) => current ? { ...current, highlighted: index } : current)} role="option" aria-selected={index === mentionMenu.highlighted} tabIndex={-1} type="button"><i aria-hidden="true">{item.kind === "directory" ? <Folder /> : <FileText />}</i><span><b>{item.name}</b><small>{item.path}</small></span></button>)}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>}
              <textarea
                ref={composerTextareaRef}
                value={commandText}
                aria-label="Message Pi"
                aria-describedby="composer-picker-status"
                disabled={busy || !canWrite}
                onChange={(event) => {
                  suppressMentionSelectionRef.current = false;
                  dismissedSlashCommandRef.current = undefined;
                  const text = event.target.value;
                  setCommandText(text);
                  scheduleSlashCommandSearch(text, event.target.selectionStart);
                  scheduleMentionSearch(text, event.target.selectionStart);
                }}
                onPaste={(event) => {
                  const pastedImages = Array.from(event.clipboardData.items)
                    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => file !== null);
                  if (pastedImages.length > 0) void selectImages(pastedImages);
                }}
                onSelect={(event) => {
                  if (suppressMentionSelectionRef.current) {
                    suppressMentionSelectionRef.current = false;
                    return;
                  }
                  scheduleSlashCommandSearch(event.currentTarget.value, event.currentTarget.selectionStart);
                  scheduleMentionSearch(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && event.shiftKey) {
                    event.preventDefault();
                    insertComposerNewline(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
                    return;
                  }
                  const highlightedMention = mentionMenu?.mentions[mentionMenu.highlighted];
                  if (mentionMenu && mentionMenu.mentions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                    event.preventDefault();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    setMentionMenu((current) => current ? { ...current, highlighted: (current.highlighted + direction + current.mentions.length) % current.mentions.length } : current);
                    return;
                  }
                  if (mentionMenu && highlightedMention && (event.key === "Enter" || event.key === "Tab" && !event.shiftKey)) { event.preventDefault(); chooseMention(highlightedMention); return; }
                  if (!window.matchMedia("(max-width: 760px)").matches && event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitCommand();
                  }
                }}
                placeholder={canWrite ? "Message Pi · / for commands · @ for files" : selectedSession && isWritableRuntime(selectedSession.status) && selectedSession.status !== "blocked" ? "Reconnecting to runtime…" : "This runtime is no longer writable"}
                rows={2}
              />
              <div className="composer-footer">
                <div className="composer-insertions">
                  <label className={`attachment-trigger ${busy || !canWrite ? "disabled" : ""}`} title="Attach images">
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={busy || !canWrite} onChange={(event) => { void selectImages(event.target.files ?? []); event.target.value = ""; }} aria-label="Attach images" />
                    <span aria-hidden="true">{imageSelectionPending ? <LoaderCircle className="icon-spin" /> : <ImagePlus />}</span>
                  </label>
                  <button className="mention-trigger" disabled={busy || !canWrite} onClick={insertMentionTrigger} type="button" aria-label="Mention a file" title="Mention a file"><AtSign aria-hidden="true" /></button>
                  {slashCommandMode && <span className="command-mode"><i aria-hidden="true">/</i> COMMAND · IMMEDIATE</span>}
                  {images.length > 0 && <div className="composer-images" aria-label="Attached images">
                    {images.map((image, index) => <button
                      key={`${image.name ?? image.mediaType}:${index}`}
                      onClick={() => setImages((current) => {
                        const next = current.filter((_, candidate) => candidate !== index);
                        imagesRef.current = next;
                        return next;
                      })}
                      type="button"
                      aria-label={`Remove ${image.name || `image ${index + 1}`}`}
                    ><img src={image.preview} alt="" /><span aria-hidden="true"><X /></span></button>)}
                  </div>}
                </div>
                <button
                  className={`context-glance ${contextTone}`}
                  onClick={() => setActiveView("details")}
                  type="button"
                  aria-label={contextPercent === null ? "Context usage unavailable; open session details" : `Context is ${contextPercent.toFixed(1)} percent used; open session details`}
                  title="Open context and compaction details"
                >
                  <span><small>CONTEXT</small><b>{contextPercent === null ? "—" : `${Math.round(contextPercent)}%`}</b></span>
                  <i aria-hidden="true"><em style={{ width: `${Math.min(100, Math.max(0, contextPercent ?? 0))}%` }} /></i>
                </button>
                <button className={`send-button ${slashCommandMode ? "command" : ""}`} disabled={busy || imageSelectionPending || !canWrite || (!commandText.trim() && images.length === 0)} onClick={submitCommand} type="button" aria-label={slashCommandMode ? "Run Pi command" : selectedSession.status === "working" ? delivery === "steer" ? "Steer Pi" : "Queue follow-up" : "Send message"}><span>{busy ? <LoaderCircle aria-hidden="true" className="icon-spin" /> : slashCommandMode ? "/" : <ArrowUp aria-hidden="true" />}</span></button>
              </div>
            </div>
            <div className="control-meta">
              <div className="control-actions">
                {selectedSession.status === "working" && !slashCommandMode && <div className="delivery-toggle">
                  <button className={delivery === "steer" ? "active" : ""} onClick={() => setDelivery("steer")} type="button" aria-pressed={delivery === "steer"} title="Deliver after the current tool call, before Pi continues">STEER NEXT</button>
                  <button className={delivery === "followUp" ? "active" : ""} onClick={() => setDelivery("followUp")} type="button" aria-pressed={delivery === "followUp"} title="Wait until the current agent run fully settles">FOLLOW-UP</button>
                </div>}
                {(selectedSession.status === "working" || busy) && <button className="abort" disabled={abortBusy} onClick={() => void abortRun()} type="button"><Square aria-hidden="true" /> {abortBusy ? "ABORTING…" : "ABORT RUN"}</button>}
                <button className="model-trigger" disabled={busy || !canConfigure} onClick={(event) => { modelReturnFocusRef.current = event.currentTarget; setModelDialogOpen(true); }} title={canConfigure ? "Change model and thinking level" : "Model changes are available when Pi is idle"} type="button">MODEL</button>
                {(selectedSession.status === "stopped" || selectedSession.status === "crashed") && selectedSession.sessionFile && <button className="end-runtime" disabled={busy} onClick={() => void resumeSession()} type="button">{busy ? "RESUMING…" : "RESUME SESSION"}</button>}
              </div>
              <span className={`runtime-state ${displayStatus(selectedSession.status)}`}><i />{ATTENTION_STATE_LABELS[selectedSession.status]}</span>
              <span className="sr-only" aria-live="polite">{selectedSession.name} is {ATTENTION_STATE_LABELS[selectedSession.status]}</span>
            </div>
          </section>
        </Tabs.Root> : selectedSessionId ? <div className="blank-state session-loading" role="status" aria-live="polite">
          <span aria-hidden="true"><i /></span>
          <h1>Loading session</h1>
          <p>Opening {selectedSessionSummary?.name ?? "session"}…</p>
        </div> : state._tag === "Failed" ? <div className="blank-state offline-shell" role="status">
          <h1>Control plane unavailable</h1>
          <p>The app shell is offline. Commands cannot be sent.</p>
          {routedSessionId && <label><span>OFFLINE DRAFT</span><textarea aria-label="Offline draft" value={commandText} onChange={(event) => setCommandText(event.target.value)} rows={7} /><small>Saved only in this browser. Reconnect before sending.</small></label>}
          <button type="button" disabled>OFFLINE · NOT SENT</button>
        </div> : <div className="blank-state">
          <h1>{state._tag === "Loading" ? "Loading" : state._tag === "Ready" && state.workspaces.length === 0 ? "No workspaces" : "No session selected"}</h1>
          {state._tag === "Ready" && state.workspaces.length === 0 && <button type="button" onClick={openWorkspaceCreator}>CREATE WORKSPACE</button>}
        </div>}
      </main>

      {globalPickerOpen && <GlobalPicker
        title="Sessions"
        items={globalPickerItems}
        placeholder="Search sessions, workspaces, branches…"
        searchLabel="Search sessions"
        emptyLabel="No matching sessions"
        noItemsLabel="No sessions yet"
        noItemsHint="Create a session from a workspace to make it searchable here."
        emptyHint="Try a session, workspace, branch, or status."
        onChoose={chooseGlobalPickerAction}
        onClose={closeGlobalPicker}
        finalFocus={() => globalPickerReturnFocusRef.current}
      />}

      {settingsOpen && <DialogSurface
        className="session-dialog settings-dialog"
        returnFocus={isMobile ? mobileMenuRef.current : settingsReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setSettingsOpen(false)}
      >
        <header>
          <div><span>APPLICATION</span><Dialog.Title render={<b />}>Settings</Dialog.Title></div>
          <Dialog.Close aria-label="Close settings"><X aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="settings-dialog-body">
          <section className="settings-section" aria-labelledby="notification-settings-title">
            <header><span>DEVICE</span><h2 id="notification-settings-title">Notifications</h2><p>Choose whether this browser alerts you when a session finishes, needs input, or crashes.</p></header>
            <div className={`notification-control ${notifications.status}`}>
              <button
                className={`notification-toggle ${notifications.status}`}
                type="button"
                disabled={notifications.status === "loading" || notifications.status === "enabling" || notifications.status === "enabled" || notifications.status === "unavailable" || notifications.status === "denied"}
                title={notifications.error ?? "Notify this device when a session finishes, needs input, or crashes"}
                onClick={() => void notifications.enable()}
              ><i aria-hidden="true">{notifications.status === "enabled" ? <BellRing /> : <Bell />}</i><span><b>ATTENTION ALERTS</b><small>{notifications.status === "enabled" ? "ON FOR THIS DEVICE" : notifications.status === "denied" ? "BLOCKED BY BROWSER" : notifications.status === "unavailable" ? "UNAVAILABLE" : notifications.status === "enabling" ? "ENABLING…" : notifications.status === "error" ? "SETUP FAILED · TAP TO RETRY" : notifications.status === "loading" ? "CHECKING…" : notifications.status === "permitted" ? "TAP TO FINISH SETUP" : notifications.status === "prompt" ? "TAP CROSSED-OUT BELL ABOVE" : "OFF FOR THIS DEVICE"}</small>{notifications.status === "error" && notifications.error && <em>{notifications.error}</em>}</span></button>
              {notifications.status === "enabled" && <button className="notification-disable" type="button" onClick={() => void notifications.disable()}>DISABLE</button>}
            </div>
            <p className="settings-note">Alerts include the session name and open that session directly. Prompts, paths, and tool output stay out of the notification.</p>
          </section>
        </div>
      </DialogSurface>}

      {interactiveRequest && selectedSession && <InteractiveRequestDialog
        key={interactiveRequest.id}
        request={interactiveRequest}
        queuedCount={selectedSession.interactiveRequests.length - 1}
        pending={busy}
        returnFocus={composerTextareaRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onRespond={(response) => void answerInteractive(interactiveRequest, response)}
      />}

      {isMobile && mentionMenu && <Dialog.Root key={`${mentionMenu.active.start}:${mentionMenu.active.end}`} open onOpenChange={(open) => { if (!open && isMobileRef.current) closeMentionPicker(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="mention-picker-backdrop" />
          <Dialog.Viewport className="mention-picker-layer">
            <Dialog.Popup className="mention-picker" initialFocus={mentionSearchInputRef} finalFocus={composerTextareaRef}>
              <header><div><span>WORKSPACE FILES</span><Dialog.Title render={<b />}>Mention a file</Dialog.Title></div><Dialog.Close aria-label="Close file mentions"><X aria-hidden="true" /></Dialog.Close></header>
              <Combobox.Root
                items={mentionMenu.mentions}
                filteredItems={mentionMenu.mentions}
                inputValue={mentionPickerQuery}
                inline
                open
                autoHighlight
                itemToStringLabel={(item: FileMention) => item.path}
                onInputValueChange={(value, details) => { if (details.event instanceof InputEvent && details.event.inputType) updateMentionQuery(value); }}
                onItemHighlighted={(item) => setMentionMenu((current) => current ? { ...current, highlighted: Math.max(0, current.mentions.indexOf(item!)) } : current)}
                onValueChange={(item) => { if (item) chooseMention(item); }}
              >
                <label className="mention-search"><span className="sr-only">Search workspace files</span><Search aria-hidden="true" /><Combobox.Input
                  ref={mentionSearchInputRef}
                  aria-label="Search workspace files"
                  placeholder="Search files"
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Backspace" && mentionPickerQuery.length === 0) {
                      event.preventDefault();
                      removeActiveMention();
                    } else if (event.key === "Enter" && mentionMenu.mentions.length > 0) {
                      event.preventDefault();
                      chooseMention(mentionMenu.mentions[mentionMenu.highlighted] ?? mentionMenu.mentions[0]!);
                    }
                  }}
                /></label>
                <Combobox.List className="mention-picker-results" aria-label="Workspace files">
                  <Combobox.Status className="mention-status">
                    {mentionMenu.loading && <div className="mention-state">Searching files…</div>}
                    {!mentionMenu.loading && mentionMenu.error && <div className="mention-state error">{mentionMenu.error}</div>}
                    {!mentionMenu.loading && !mentionMenu.error && mentionMenu.mentions.length === 0 && <div className="mention-state">No matching files</div>}
                  </Combobox.Status>
                  {!mentionMenu.loading && mentionMenu.mentions.map((item, index) => <Combobox.Item className="mention-option" index={index} key={`${item.kind}:${item.path}`} value={item} nativeButton render={<button type="button" />}><i aria-hidden="true">{item.kind === "directory" ? <Folder /> : <FileText />}</i><span><b>{item.name}</b><small>{item.path}</small></span></Combobox.Item>)}
                </Combobox.List>
              </Combobox.Root>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>}

      {workspaceCreatorOpen && <WorkspaceDialog
        returnFocus={workspaceCreatorReturnFocusRef.current}
        onClose={() => setWorkspaceCreatorOpen(false)}
        onCreated={(workspace) => {
          workspaceIdRef.current = workspace.id;
          setWorkspaceId(workspace.id);
          setState((current) => current._tag === "Ready" && !current.workspaces.some((candidate) => candidate.id === workspace.id)
            ? { ...current, workspaces: [...current.workspaces, workspace] }
            : current);
          setWorkspaceCreatorOpen(false);
          if (isMobile) setSidebarOpen(true);
          void refresh(false);
        }}
      />}

      {renameSessionTarget && <RenameSessionDialog
        session={renameSessionTarget}
        returnFocus={renameSessionReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setRenameSessionTarget(undefined)}
        onRenamed={(session) => {
          setState((current) => current._tag === "Ready"
            ? { ...current, sessions: current.sessions.map((candidate) => candidate.id === session.id ? { ...candidate, name: session.name } : candidate) }
            : current);
          if (selectedSessionIdRef.current === session.id) acceptAuthoritativeSession(session);
          setRenameSessionTarget(undefined);
          void refresh(false);
        }}
      />}

      {renameWorkspaceTarget && <RenameWorkspaceDialog
        workspace={renameWorkspaceTarget}
        returnFocus={workspaceActionReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setRenameWorkspaceTarget(undefined)}
        onRenamed={(workspace) => {
          setState((current) => current._tag === "Ready"
            ? { ...current, workspaces: current.workspaces.map((candidate) => candidate.id === workspace.id ? workspace : candidate) }
            : current);
          setRenameWorkspaceTarget(undefined);
          void refresh(false);
        }}
      />}

      {removeWorkspaceTarget && <RemoveWorkspaceDialog
        workspace={removeWorkspaceTarget}
        returnFocus={workspaceActionReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setRemoveWorkspaceTarget(undefined)}
        onRemoved={() => {
          setState((current) => {
            if (current._tag !== "Ready") return current;
            const workspaces = current.workspaces.filter((candidate) => candidate.id !== removeWorkspaceTarget.id);
            if (workspaceIdRef.current === removeWorkspaceTarget.id) {
              workspaceIdRef.current = workspaces[0]?.id;
              setWorkspaceId(workspaces[0]?.id ?? "");
            }
            return { ...current, workspaces };
          });
          setRemoveWorkspaceTarget(undefined);
          void refresh(false);
        }}
      />}

      {archiveTarget && <ArchiveSessionDialog
        sessionName={archiveTarget.name}
        active={archiveTarget.status !== "stopped" && archiveTarget.status !== "crashed"}
        pending={archivePending}
        error={archiveError}
        returnFocus={archiveReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => { if (!archivePending) setArchiveTarget(undefined); }}
        onConfirm={() => void archiveSession()}
      />}

      {compactionDialogOpen && selectedSession && <CompactionDialog
        returnFocus={compactionReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setCompactionDialogOpen(false)}
        onConfirm={() => void compactNow()}
      />}

      {modelDialogOpen && selectedSession && <ModelDialog
        session={selectedSession}
        returnFocus={modelReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setModelDialogOpen(false)}
        onApplied={(session) => {
          acceptAuthoritativeSession(session);
          void refresh(false);
        }}
      />}

      {creatorOpen && state._tag === "Ready" && <DialogSurface className="session-dialog" pending={busy} returnFocus={creatorReturnFocusRef.current} fallbackFocus={sessionHeadingRef.current} initialFocus={newSessionInputRef} onClose={closeCreator} render={<form onSubmit={createSession} />}>
        <header><div><Dialog.Title render={<b />}>New session</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close"><X aria-hidden="true" /></Dialog.Close></header>
        <div className="dialog-body">
          {chosenWorkspace && <div className="session-workspace">
            <span>WORKSPACE</span><b>{chosenWorkspace.name}</b><small>{chosenWorkspace.root}</small>
            {chosenWorkspace.activeSessionCount > 0 && <em className="workspace-activity" role="note"><i />{chosenWorkspace.activeSessionCount} other writable {chosenWorkspace.activeSessionCount === 1 ? "session is" : "sessions are"} already using this checkout. Concurrent edits may conflict.</em>}
          </div>}
          <label>Session name<input ref={newSessionInputRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="New session" /></label>
          {creatorError && <div className="dialog-error" role="alert">{creatorError}</div>}
        </div>
        <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch" disabled={busy || !workspaceId} type="submit">{busy ? "STARTING…" : <>START SESSION <ExternalLink aria-hidden="true" /></>}</button></footer>
      </DialogSurface>}
    </div>
    </Drawer.Root>
  );
}

type ActionMenuItem = {
  readonly label: string;
  readonly danger?: boolean;
  readonly onSelect: (returnFocus: HTMLElement) => void;
};

function ActionMenu({ className, triggerClassName, triggerLabel, menuLabel, actions }: {
  readonly className: string;
  readonly triggerClassName: string;
  readonly triggerLabel: string;
  readonly menuLabel: string;
  readonly actions: ReadonlyArray<ActionMenuItem>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);

  return <BaseMenu.Root>
    <div className={className}>
      <BaseMenu.Trigger className={triggerClassName} ref={trigger} aria-label={triggerLabel}>
        <MoreHorizontal aria-hidden="true" />
      </BaseMenu.Trigger>
    </div>
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className="workspace-menu-positioner"
        side="bottom"
        align="end"
        sideOffset={3}
        collisionPadding={4}
        positionMethod="fixed"
      >
        <BaseMenu.Popup className="workspace-menu" aria-label={menuLabel} aria-labelledby="">
          {actions.map((action) => <BaseMenu.Item
            className={action.danger ? "danger" : undefined}
            key={action.label}
            nativeButton
            render={<button type="button" />}
            onClick={() => {
              if (trigger.current) action.onSelect(trigger.current);
            }}
          >{action.label}</BaseMenu.Item>)}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}

type ModalSurfaceProps = {
  readonly className: string;
  readonly pending?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly fallbackFocus?: HTMLElement | null;
  readonly initialFocus?: RefObject<HTMLElement | null> | true;
  readonly onClose: () => void;
  readonly render?: ReactElement;
  readonly children: ReactNode;
};

function focusAfterModal(returnFocus?: HTMLElement | null, fallbackFocus?: HTMLElement | null): HTMLElement | null {
  return returnFocus?.isConnected && !returnFocus.matches(":disabled") ? returnFocus : fallbackFocus?.isConnected ? fallbackFocus : null;
}

function DialogSurface({ className, pending = false, returnFocus, fallbackFocus, initialFocus = true, onClose, render, children }: ModalSurfaceProps) {
  return <Dialog.Root
    open
    disablePointerDismissal={pending}
    onOpenChange={(open, details) => {
      if (open) return;
      if (pending) { details.cancel(); return; }
      onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Viewport className="dialog-layer">
        <Dialog.Popup
          className={className}
          initialFocus={initialFocus}
          finalFocus={() => focusAfterModal(returnFocus, fallbackFocus)}
          render={render}
        >{children}</Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}

function AlertDialogSurface({ className, pending = false, returnFocus, fallbackFocus, initialFocus = true, onClose, render, children }: ModalSurfaceProps) {
  return <AlertDialog.Root
    open
    onOpenChange={(open, details) => {
      if (open) return;
      if (pending) { details.cancel(); return; }
      onClose();
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="dialog-backdrop" />
      <AlertDialog.Viewport className="dialog-layer">
        <AlertDialog.Popup
          className={className}
          initialFocus={initialFocus}
          finalFocus={() => focusAfterModal(returnFocus, fallbackFocus)}
          render={render}
        >{children}</AlertDialog.Popup>
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

function RenameSessionDialog({ session, returnFocus, fallbackFocus, onClose, onRenamed }: {
  readonly session: OwnedSessionSummary;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onRenamed: (session: OwnedSession) => void;
}) {
  const [name, setName] = useState(session.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(renameOwnedSession(session.id, session.runtimeId, nextName));
      onRenamed(result.session);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return <DialogSurface className="session-dialog workspace-action-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={inputRef} onClose={onClose} render={<form onSubmit={submit} />}>
    <header><div><Dialog.Title render={<b />}>Rename session</Dialog.Title></div><Dialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></Dialog.Close></header>
    <div className="dialog-body">
      <label>Session name<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </div>
    <footer><Dialog.Close className="cancel" disabled={pending}>CANCEL</Dialog.Close><button className="launch" disabled={pending || !name.trim()} type="submit">{pending ? "SAVING…" : "SAVE"}</button></footer>
  </DialogSurface>;
}

function RenameWorkspaceDialog({ workspace, returnFocus, fallbackFocus, onClose, onRenamed }: {
  readonly workspace: Workspace;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onRenamed: (workspace: Workspace) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(renameWorkspace(workspace.id, nextName));
      onRenamed(result.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return <DialogSurface className="session-dialog workspace-action-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={inputRef} onClose={onClose} render={<form onSubmit={submit} />}>
    <header><div><Dialog.Title render={<b />}>Rename workspace</Dialog.Title></div><Dialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></Dialog.Close></header>
    <div className="dialog-body">
      <label>Workspace name<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
      <small className="workspace-path">{workspace.root}</small>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </div>
    <footer><Dialog.Close className="cancel" disabled={pending}>CANCEL</Dialog.Close><button className="launch" disabled={pending || !name.trim()} type="submit">{pending ? "SAVING…" : "SAVE"}</button></footer>
  </DialogSurface>;
}

function RemoveWorkspaceDialog({ workspace, returnFocus, fallbackFocus, onClose, onRemoved }: {
  readonly workspace: Workspace;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const blocked = workspace.sessionCount > 0;

  const remove = async () => {
    if (blocked || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await Effect.runPromise(deleteWorkspace(workspace.id));
      onRemoved();
      window.requestAnimationFrame(() => fallbackFocus?.focus());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return <AlertDialogSurface className="session-dialog workspace-action-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={cancelRef} onClose={onClose}>
    <header><div><AlertDialog.Title render={<b />}>Remove workspace?</AlertDialog.Title></div><AlertDialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></AlertDialog.Close></header>
    <div className="dialog-body">
      <AlertDialog.Description render={<p />}><b>{workspace.name}</b> will be removed from PISS. Its directory and files will remain untouched.</AlertDialog.Description>
      {blocked && <div className="dialog-error" role="alert">Delete {workspace.sessionCount} {workspace.sessionCount === 1 ? "session" : "sessions"} first.</div>}
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </div>
    <footer><AlertDialog.Close className="cancel" ref={cancelRef} disabled={pending}>CANCEL</AlertDialog.Close><button className="danger" onClick={() => void remove()} disabled={blocked || pending} type="button">{pending ? "REMOVING…" : "REMOVE WORKSPACE"}</button></footer>
  </AlertDialogSurface>;
}

function ArchiveSessionDialog({ sessionName, active, pending, error, returnFocus, fallbackFocus, onClose, onConfirm }: {
  readonly sessionName: string;
  readonly active: boolean;
  readonly pending: boolean;
  readonly error?: string;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return <AlertDialogSurface className="session-dialog stop-session-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={cancelRef} onClose={onClose}>
    <header><div><AlertDialog.Title render={<b />}>Archive session?</AlertDialog.Title></div><AlertDialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></AlertDialog.Close></header>
    <div className="dialog-body">
      <AlertDialog.Description render={<p />}><b>{sessionName}</b>{active ? " will stop running and" : " will"} be removed from PISS. Its Pi conversation file will remain on disk for recovery.</AlertDialog.Description>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </div>
    <footer><AlertDialog.Close className="cancel" ref={cancelRef} disabled={pending}>CANCEL</AlertDialog.Close><button className="danger" onClick={onConfirm} disabled={pending} type="button">{pending ? "ARCHIVING…" : "ARCHIVE SESSION"}</button></footer>
  </AlertDialogSurface>;
}

function CompactionDialog({ returnFocus, fallbackFocus, onClose, onConfirm }: {
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <AlertDialogSurface className="session-dialog stop-session-dialog" returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={cancelRef} onClose={onClose}>
    <header><div><AlertDialog.Title render={<b />}>Compact session context?</AlertDialog.Title></div><AlertDialog.Close aria-label="Close"><X aria-hidden="true" /></AlertDialog.Close></header>
    <div className="dialog-body"><AlertDialog.Description render={<p />}>Compaction is lossy for the active model context. The complete append-only Pi transcript remains on disk.</AlertDialog.Description></div>
    <footer><AlertDialog.Close className="cancel" ref={cancelRef}>CANCEL</AlertDialog.Close><button className="launch" onClick={onConfirm} type="button">COMPACT NOW</button></footer>
  </AlertDialogSurface>;
}

function InteractiveRequestDialog({ request, queuedCount, pending, returnFocus, fallbackFocus, onRespond }: {
  readonly request: InteractiveRequest;
  readonly queuedCount: number;
  readonly pending: boolean;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onRespond: (response: { readonly cancelled?: boolean; readonly value?: string; readonly confirmed?: boolean }) => void;
}) {
  const [value, setValue] = useState(request.method === "select" ? request.options?.[0] ?? "" : request.prefill ?? "");

  const submitValue = () => onRespond({ value });
  const cancel = () => onRespond({ cancelled: true });
  return <DialogSurface className="session-dialog interactive-request-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} onClose={cancel}>
    <header><div><span>PI REQUEST · {request.method.toUpperCase()}</span><Dialog.Title render={<b />}>{request.title || "Pi needs input"}</Dialog.Title></div></header>
    <div className="dialog-body">
      {request.message && <Dialog.Description className="interactive-message">{request.message}</Dialog.Description>}
      {queuedCount > 0 && <p className="interactive-queue">{queuedCount} more request{queuedCount === 1 ? " is" : "s are"} queued</p>}
      {request.timeout && <p className="interactive-timeout">This request expires automatically after {Math.ceil(request.timeout / 1000)} seconds.</p>}
      {request.method === "select" && <label>Choose one<select value={value} disabled={pending} onChange={(event) => setValue(event.target.value)}>{request.options?.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>}
      {request.method === "input" && <label>Response<input value={value} disabled={pending} maxLength={256 * 1024} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submitValue(); } }} /></label>}
      {request.method === "editor" && <label>Response<textarea value={value} disabled={pending} maxLength={256 * 1024} placeholder={request.placeholder} rows={9} onChange={(event) => setValue(event.target.value)} /></label>}
      {request.method === "confirm" && <div className="interactive-confirm" role="group" aria-label="Confirmation response"><button disabled={pending} type="button" onClick={() => onRespond({ confirmed: false })}>NO</button><button disabled={pending} type="button" onClick={() => onRespond({ confirmed: true })}>YES</button></div>}
    </div>
    <footer><Dialog.Close className="cancel" disabled={pending}>CANCEL</Dialog.Close>{request.method !== "confirm" && <button className="launch" disabled={pending || request.method === "select" && !value} onClick={submitValue} type="button">{pending ? "ANSWERING…" : "SUBMIT"}</button>}</footer>
  </DialogSurface>;
}

function ModelDialog({ session, returnFocus, fallbackFocus, onClose, onApplied }: {
  readonly session: OwnedSession;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onApplied: (session: OwnedSession) => void;
}) {
  const [models, setModels] = useState<ReadonlyArray<AvailableModel>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(loadAvailableModels(session.id, session.runtimeId));
      setModels(result.models);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [session.id, session.runtimeId]);

  useEffect(() => { void loadModels(); }, [loadModels]);

  const applyModel = async (model: AvailableModel) => {
    if (pending || !canConfigureSession(session.status) || session.model?.provider === model.provider && session.model.id === model.id) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(setSessionModel({ sessionId: session.id, runtimeId: session.runtimeId, provider: model.provider, modelId: model.id }));
      onApplied(result.session);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const applyThinkingLevel = async (level: ThinkingLevel) => {
    if (pending || !canConfigureSession(session.status) || session.thinkingLevel === level) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(setSessionThinkingLevel({ sessionId: session.id, runtimeId: session.runtimeId, level }));
      onApplied(result.session);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const currentModel = session.model;
  const filtered = models
    .filter((model) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    .toSorted(newestModelsFirst);

  return <DialogSurface className="model-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={searchRef} onClose={onClose}>
    <header><div><Dialog.Title render={<b />}>Model &amp; thinking</Dialog.Title></div><Dialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></Dialog.Close></header>
      <div className="model-dialog-body">
        <section className="model-current">
          <span>CURRENT MODEL</span><b>{currentModel?.name ?? "No model selected"}</b><small>{currentModel ? `${currentModel.provider} / ${currentModel.id}` : "Pi did not report a model"}</small>
          <div className="thinking-levels" aria-label="Thinking level">
            <label>THINKING</label>
            <div>{(currentModel?.thinkingLevels ?? []).map((level) => <button key={level} className={session.thinkingLevel === level ? "active" : ""} disabled={pending} onClick={() => void applyThinkingLevel(level)} type="button" aria-pressed={session.thinkingLevel === level}>{level}</button>)}</div>
          </div>
        </section>
        <Combobox.Root
          items={filtered}
          filteredItems={filtered}
          inputValue={query}
          value={filtered.find((model) => currentModel?.provider === model.provider && currentModel.id === model.id) ?? null}
          onInputValueChange={(value, details) => { if (details.event instanceof InputEvent && details.event.inputType) setQuery(value); }}
          onValueChange={(model) => { if (model) void applyModel(model); }}
          itemToStringLabel={(model: AvailableModel) => model.name}
          isItemEqualToValue={(model, value) => model.provider === value.provider && model.id === value.id}
          inline
          open
          autoHighlight
          disabled={pending}
        >
          <section className="model-catalog">
            <label className="model-search"><span>AVAILABLE MODELS</span><Combobox.Input ref={searchRef} placeholder="Filter models…" autoComplete="off" /></label>
            <Combobox.List className="model-options" aria-label="Available models">
              <Combobox.Status className="model-status">
                {loading && <div className="model-state">Loading models…</div>}
                {!loading && error && models.length === 0 && <div className="model-state error" role="alert">{error}</div>}
                {!loading && !error && filtered.length === 0 && <div className="model-state">No matching models.</div>}
              </Combobox.Status>
              {!loading && filtered.map((model, index) => {
                const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                return <Combobox.Item className={`model-option ${active ? "active" : ""}`} disabled={pending} index={index} value={model} key={`${model.provider}/${model.id}`}>
                  <i aria-hidden="true">{active ? <CircleCheck /> : <Circle />}</i><span><b>{model.name}</b><small>{model.provider} / {model.id}</small></span><em>{model.reasoning ? "THINKING" : "DIRECT"}</em>
                </Combobox.Item>;
              })}
            </Combobox.List>
          </section>
        </Combobox.Root>
        {error && models.length > 0 && <div className="dialog-error" role="alert">{error}</div>}
      </div>
    <footer><button onClick={() => void loadModels()} disabled={loading || pending} type="button">REFRESH</button><Dialog.Close className="launch" disabled={pending}>DONE</Dialog.Close></footer>
  </DialogSurface>;
}

function WorkspaceDialog({ returnFocus, onClose, onCreated }: {
  readonly returnFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onCreated: (workspace: Workspace) => void;
}) {
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ReadonlyArray<DirectoryCandidate>>([]);
  const [selected, setSelected] = useState<DirectoryCandidate>();
  const [folderName, setFolderName] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [trustProjectResources, setTrustProjectResources] = useState(true);
  const [searching, setSearching] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void Effect.runPromise(searchDirectories(query)).then(
        ({ candidates: next }) => { if (!cancelled) { setCandidates(next); setSearching(false); setError(undefined); } },
        (cause) => { if (!cancelled) { setCandidates([]); setSearching(false); setError(errorMessage(cause)); } },
      );
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  const choose = (candidate: DirectoryCandidate) => {
    setSelected(candidate);
    setQuery(candidate.path);
    if (!nameTouched && mode === "existing") setName(candidate.name);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !name.trim()) return;
    const folder = folderName.trim();
    if (mode === "create" && (!folder || folder === "." || folder === ".." || folder.includes("/") || folder.includes("\0"))) {
      setError("New folder names cannot contain slashes and must not be . or ..");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await Effect.runPromise(createWorkspace({
        name: name.trim(),
        path: selected.path,
        createDirectory: mode === "create",
        directoryName: mode === "create" ? folder : undefined,
        trustProjectResources,
      }));
      onCreated(result.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return <DialogSurface className="session-dialog workspace-dialog" pending={busy} returnFocus={returnFocus} initialFocus={searchRef} onClose={onClose} render={<form onSubmit={submit} />}>
    <header><div><Dialog.Title render={<b />}>New workspace</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close"><X aria-hidden="true" /></Dialog.Close></header>
      <div className="dialog-body workspace-dialog-body">
        <div className="workspace-mode" aria-label="Workspace directory mode">
          <button className={mode === "existing" ? "active" : ""} onClick={() => { setMode("existing"); setSelected(undefined); setQuery(""); }} type="button" aria-pressed={mode === "existing"}>EXISTING DIRECTORY</button>
          <button className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setSelected(undefined); setQuery(""); }} type="button" aria-pressed={mode === "create"}>CREATE FOLDER</button>
        </div>
        <label>{mode === "create" ? "Parent directory" : "Directory"}
          <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(undefined); }} placeholder="Fuzzy search approved directories…" autoComplete="off" />
        </label>
        <div className="directory-results" aria-label="Matching directories" aria-busy={searching}>
          {searching && <div className="directory-state" role="status">Searching directories…</div>}
          {!searching && candidates.length === 0 && <div className="directory-state" role="status">No matching directories inside the approved roots.</div>}
          {!searching && candidates.map((candidate) => <button className={selected?.path === candidate.path ? "selected" : ""} onClick={() => choose(candidate)} type="button" aria-pressed={selected?.path === candidate.path} key={candidate.path}>
            <i aria-hidden="true"><Folder /></i><span><b>{candidate.name}</b><small>{candidate.relativePath === "." ? candidate.path : candidate.relativePath}</small></span>
          </button>)}
        </div>
        <div className={`selected-directory ${selected ? "" : "empty"}`} aria-live="polite"><span>{selected ? "SELECTED" : "DIRECTORY SELECTION"}</span><code>{selected?.path ?? "Choose a directory from the results above"}</code></div>
        {mode === "create" && <label>New folder name<input value={folderName} onChange={(event) => { const value = event.target.value; setFolderName(value); if (!nameTouched) setName(value); }} placeholder="my-project" maxLength={120} /></label>}
        <label>Workspace name<input value={name} onChange={(event) => { setNameTouched(true); setName(event.target.value); }} placeholder="My project" maxLength={120} /></label>
        <label className="trust-toggle"><input checked={trustProjectResources} onChange={(event) => setTrustProjectResources(event.target.checked)} type="checkbox" /><span><b>Trust project-local Pi resources</b><small>Load settings, extensions, skills, and packages from this directory.</small></span></label>
        {error && <div className="dialog-error" role="alert">{error}</div>}
      </div>
    <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch" disabled={busy || !selected || !name.trim() || (mode === "create" && !folderName.trim())} type="submit">{busy ? "CREATING…" : <>CREATE WORKSPACE <ArrowRight aria-hidden="true" /></>}</button></footer>
  </DialogSurface>;
}
