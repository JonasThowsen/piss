import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { ArrowDown, ArrowRight, ArrowUp, AtSign, Bell, BellRing, Bot, Check, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, Copy, ExternalLink, FileDiff, FileText, Folder, Gauge, Image, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Plus, RefreshCw, Search, Send, Settings, Sparkles, Square, Video, Workflow, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AvailableModel, DirectoryCandidate, EngineeringWorkflow, EngineeringWorkflowMutationInput, FileMention, ImageInput, ImageMediaType, InteractiveRequest, OwnedSession, OwnedSessionCommandAction, OwnedSessionSummary, PiSlashCommand, ReviewFile, ReviewSnapshot, ThinkingLevel, Workspace } from "../../shared/domain.ts";
import { ATTENTION_STATE_LABELS, canAcceptPrompt, canConfigureSession, isWritableRuntime } from "../../shared/sessionState.ts";
import { isTerminalWorkflowPhase, workflowBadgePhaseLabel, workflowPhaseLabel } from "../../shared/engineeringWorkflow.ts";

type WorkflowMutationRequest =
  | { readonly runtimeId: string; readonly mutationId?: string; readonly action: "start"; readonly objective: string; readonly maxRepairAttempts?: number }
  | { readonly runtimeId: string; readonly mutationId?: string; readonly action: "approve" | "accept" | "cancel" }
  | { readonly runtimeId: string; readonly mutationId?: string; readonly action: "resume"; readonly feedback?: string }
  | { readonly runtimeId: string; readonly mutationId?: string; readonly action: "continueRepairs"; readonly additionalRepairAttempts: number }
  | { readonly runtimeId: string; readonly mutationId?: string; readonly action: "revise" | "intervene"; readonly feedback: string; readonly scopeChange?: boolean };
import { acknowledgeOwnedSession, archiveOwnedSession, compactSession, createOwnedSession, createWorkspace, deleteWorkspace, loadAvailableModels, loadReview, loadSession, loadSessions, loadSessionUsage, loadSlashCommands, loadTimelinePage, loadToolOutput, loadWorkspaces, mutateEngineeringWorkflow, renameOwnedSession, renameWorkspace, respondToInteractiveRequest, resumeOwnedSession, searchDirectories, searchFileMentions, sendSessionCommand, setSessionAutoCompaction, setSessionModel, setSessionThinkingLevel, subscribeSession } from "./api.ts";
import { draftStorageKey, pruneDrafts, readDraft, removeDraft, writeDraft } from "./drafts.ts";
import { activeFileMention, applyFileMention, type ActiveFileMention } from "./mentions.ts";
import { DialogSurface, AlertDialogSurface } from "./ModalSurface.tsx";
import { nextOptionIndex, optionNavigationDirection, remapOptionNavigationKey, scrollOptionIntoView } from "./optionNavigation.ts";
import { markOutboxQueued, nextDeliveredOutboxExpiration, pruneDeliveredOutbox, reconcileOutbox, type OutboxItem } from "./outbox.ts";
import { compact, eventTimeline, valueText } from "./timeline.ts";
import { useNotifications } from "./notifications.ts";
import { GlobalPicker } from "./GlobalPicker.tsx";
import { HOTKEYS } from "./hotkeys.ts";
import { keyboardScrollDirection, useSharedKeyboardScrolling } from "./keyboardScroll.ts";
import { readLastOpenedSession, readSessionOpenHistory, writeLastOpenedSession } from "./lastOpenedSession.ts";
import { readCachedSession, removeCachedSession, writeCachedSession } from "./sessionCache.ts";
import { sessionPickerItems, type SelectSessionAction } from "./sessionPicker.ts";
import { initialSessionSyncState, reduceSessionSync, sessionForFastSwitchCache, sessionForSettledCache, sessionSyncRequest, shouldPollSession, type SessionSyncInput } from "./sessionSync.ts";
import { requestUpdateActivation } from "./updateActivation.ts";
import { fileReviewKey, formatReviewComment, nextDiffSelection, parseUnifiedDiff, readReviewedFiles, selectedDiffLines, selectionLocation, writeReviewedFiles, type DiffLine, type DiffSelection } from "./review.ts";
import { SlashCommandMenu } from "./SlashCommandMenu.tsx";
import { activeSlashCommand, applySlashCommand, filterSlashCommands, isSlashCommandInput, nativeSlashCommand, slashCommandCatalog, type ActiveSlashCommand, type NativeSlashCommandName, type SlashCommandItem } from "./slashCommands.ts";
import { defaultPagePosition, readWorkbenchRoute, writeWorkbenchRoute, type PagePosition, type SessionView, type WorkbenchRoute } from "./urlState.ts";
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

function StartupScreen() {
  return <main className="startup-screen" role="status" aria-label="PISS is starting">
    <div className="startup-card">
      <span className="startup-mark" aria-hidden="true">π</span>
      <b>Pi sin sidecar</b>
      <small>Opening your workspace</small>
      <span className="startup-progress" aria-hidden="true" />
    </div>
  </main>;
}

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

function lineAccessibleLocation(line: DiffLine): string {
  if (line.oldLine !== undefined && line.newLine !== undefined) return `old and new line ${line.newLine}`;
  if (line.newLine !== undefined) return `new line ${line.newLine}`;
  if (line.oldLine !== undefined) return `old line ${line.oldLine}`;
  return "diff metadata";
}

function DiffPatch({ lines, selection, onSelect }: { readonly lines: ReadonlyArray<DiffLine>; readonly selection?: DiffSelection; readonly onSelect: (line: DiffLine) => void }) {
  const selected = selection ? new Set(selectedDiffLines(lines, selection).map((line) => line.index)) : new Set<number>();
  return <pre className="diff-patch" data-keyboard-scroll tabIndex={0}>{lines.map((line) => <button
    aria-label={`${lineAccessibleLocation(line)}: ${line.text || "blank line"}`}
    aria-pressed={line.selectable ? selected.has(line.index) : undefined}
    className={`diff-line ${line.kind} ${selected.has(line.index) ? "selected" : ""}`}
    disabled={!line.selectable}
    key={line.index}
    onClick={() => onSelect(line)}
    title={line.selectable ? "Select this line; tap another line to select a range" : undefined}
    type="button"
  ><span className="diff-old" aria-hidden="true">{line.oldLine ?? ""}</span><span className="diff-new" aria-hidden="true">{line.newLine ?? ""}</span><span className="diff-code" aria-hidden="true">{line.text || " "}</span></button>)}</pre>;
}

type ReviewFileViewProps = {
  readonly file: ReviewFile;
  readonly initiallyOpen: boolean;
  readonly reviewed: boolean;
  readonly canComment: boolean;
  readonly onReviewedChange: (reviewed: boolean) => void;
  readonly onSendComment: (message: string) => Promise<boolean>;
};

function ReviewFileView({ file, initiallyOpen, reviewed, canComment, onReviewedChange, onSendComment }: ReviewFileViewProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [selection, setSelection] = useState<DiffSelection>();
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = useMemo(() => parseUnifiedDiff(file.patch), [file.patch]);
  const selectedLines = selection ? selectedDiffLines(lines, selection) : [];
  const counts = patchCounts(file.patch);
  const slash = file.path.lastIndexOf("/");
  const status = file.indexStatus === "?" ? { mark: "U", label: "Untracked file" } : file.worktreeStatus === "D" || file.indexStatus === "D" ? { mark: "D", label: "Deleted file" } : { mark: "M", label: "Modified file" };
  const panelId = `review-file-${fileReviewKey(file).replace(/[^a-z0-9-]/gi, "-")}`;

  const clearSelection = () => {
    setSelection(undefined);
    setCommentEditorOpen(false);
    setComment("");
    commentTextareaRef.current?.blur();
  };
  const selectLine = (line: DiffLine) => {
    if (!line.selectable) return;
    setSent(false);
    const next = nextDiffSelection(selection, line.index);
    if (!next) {
      clearSelection();
      return;
    }
    setSelection(next);
  };
  const openCommentEditor = () => {
    setCommentEditorOpen(true);
    window.requestAnimationFrame(() => commentTextareaRef.current?.focus());
  };
  const closeCommentEditor = () => {
    setCommentEditorOpen(false);
    commentTextareaRef.current?.blur();
  };
  const submitComment = async () => {
    if (selectedLines.length === 0 || !comment.trim() || sending || !canComment) return;
    setSending(true);
    const accepted = await onSendComment(formatReviewComment(file.path, selectedLines, comment));
    setSending(false);
    if (!accepted) return;
    setComment("");
    setSelection(undefined);
    setCommentEditorOpen(false);
    setSent(true);
  };

  return <article className={`review-file ${open ? "open" : ""} ${reviewed ? "reviewed" : ""}`}>
    <header className="review-file-heading">
      <button className="review-file-toggle" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>
        <span className="review-file-status"><span aria-hidden="true">{status.mark}</span><span className="sr-only">{status.label}</span></span>
        <span className="review-file-path">{slash >= 0 && <small>{file.path.slice(0, slash + 1)}</small>}<b>{file.path.slice(slash + 1)}</b></span>
        <span className="review-counts"><em>+{counts.additions}</em><em>−{counts.deletions}</em></span>
        <strong aria-hidden="true"><ChevronDown /></strong>
      </button>
      <button className="review-mark" type="button" aria-label={reviewed ? `Mark ${file.path} unreviewed` : `Mark ${file.path} reviewed`} aria-pressed={reviewed} onClick={() => onReviewedChange(!reviewed)}><Check aria-hidden="true" /><span>{reviewed ? "REVIEWED" : "MARK REVIEWED"}</span></button>
    </header>
    {open && <div className="review-file-panel" id={panelId}>
      <div className="review-file-meta"><p><MessageSquare aria-hidden="true" /> Tap a line, then another to select a range</p><span>{reviewLabels(file).map((label) => <i key={label}>{label}</i>)}{file.binary && <i>BINARY</i>}{file.truncated && <i>BOUNDED</i>}</span></div>
      {file.patch ? <DiffPatch lines={lines} selection={selection} onSelect={selectLine} /> : <div className="review-empty-patch">No textual patch is available for this change.</div>}
      {selectedLines.length > 0 && !commentEditorOpen && <div className="review-comment-prompt">
        <button className="review-comment-open" type="button" onClick={openCommentEditor} aria-label={`Comment on ${selectionLocation(file.path, selectedLines)}`}><MessageSquare aria-hidden="true" /><span><b>{selectionLocation(file.path, selectedLines)}</b><small>{selectedLines.length} LINE{selectedLines.length === 1 ? "" : "S"} SELECTED · TAP TO COMMENT</small></span><ChevronRight aria-hidden="true" /></button>
        <button className="review-selection-clear" type="button" onClick={clearSelection} aria-label="Deselect selected lines"><X aria-hidden="true" /></button>
      </div>}
      {selectedLines.length > 0 && commentEditorOpen && <form className="review-comment" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
        <header><div><MessageSquare aria-hidden="true" /><span>COMMENT ON</span><b>{selectionLocation(file.path, selectedLines)}</b></div><div className="review-comment-actions"><button type="button" onClick={clearSelection}>DESELECT</button><button type="button" onClick={closeCommentEditor} aria-label="Close comment editor"><X aria-hidden="true" /></button></div></header>
        <textarea ref={commentTextareaRef} aria-label={`Comment editor for ${selectionLocation(file.path, selectedLines)}`} value={comment} disabled={sending || !canComment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeCommentEditor(); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitComment(); } }} placeholder={canComment ? "Describe what should change…" : "Reconnect to the agent to comment"} rows={3} />
        <footer><span>{selectedLines.length} LINE{selectedLines.length === 1 ? "" : "S"} SELECTED · CTRL/⌘ + ENTER</span><button type="submit" disabled={sending || !canComment || !comment.trim()}>{sending ? <LoaderCircle className="icon-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}{sending ? "SENDING…" : "SEND TO AGENT"}</button></footer>
      </form>}
      {sent && <div className="review-comment-sent" role="status"><Check aria-hidden="true" /> Comment sent to the agent</div>}
    </div>}
  </article>;
}

function ReviewView({ state, canComment, onRefresh, onSendComment }: { readonly state?: ReviewState; readonly canComment: boolean; readonly onRefresh: () => void; readonly onSendComment: (message: string) => Promise<boolean> }) {
  const review = state?.snapshot;
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const currentKeys = useMemo(() => review?.files.map(fileReviewKey) ?? [], [review]);
  const reviewedCount = currentKeys.filter((key) => reviewed.has(key)).length;
  const allReviewed = currentKeys.length > 0 && reviewedCount === currentKeys.length;

  useEffect(() => {
    if (!state?.sessionId || !review) return;
    setReviewed(readReviewedFiles(state.sessionId));
  }, [state?.sessionId, review?.generatedAt]);

  const updateReviewed = (key: string, value: boolean) => {
    if (!state?.sessionId) return;
    setReviewed((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      writeReviewedFiles(state.sessionId, next);
      return next;
    });
  };
  const toggleAllReviewed = () => {
    if (!state?.sessionId) return;
    setReviewed((current) => {
      const next = new Set(current);
      for (const key of currentKeys) {
        if (allReviewed) next.delete(key);
        else next.add(key);
      }
      writeReviewedFiles(state.sessionId, next);
      return next;
    });
  };

  return <section className="review-view" aria-label="Uncommitted changes" aria-busy={state?.loading ?? false}>
    <span className="sr-only" aria-live="polite">{state?.loading ? "Reading repository changes" : state?.error ? `Review unavailable: ${state.error}` : review ? `${review.totalFiles} changed file${review.totalFiles === 1 ? "" : "s"} loaded; ${reviewedCount} reviewed` : ""}</span>
    <header className="review-overview">
      <div className="review-title"><span>CODE REVIEW</span><h2>Review changes</h2><p>{review ? `${reviewedCount} of ${review.files.length} file${review.files.length === 1 ? "" : "s"} reviewed` : "Select diff lines and send precise feedback"}</p>{review && review.files.length > 0 && <div className="review-progress" aria-label={`${reviewedCount} of ${review.files.length} files reviewed`}><i style={{ width: `${review.files.length === 0 ? 0 : reviewedCount / review.files.length * 100}%` }} /></div>}</div>
      <div className="review-overview-actions">{review && review.files.length > 0 && <button className={`review-all ${allReviewed ? "complete" : ""}`} aria-label={allReviewed ? "Reset reviewed files" : "Mark all files reviewed"} onClick={toggleAllReviewed} type="button"><CheckCheck aria-hidden="true" /><span>{allReviewed ? "RESET REVIEW" : "MARK ALL"}</span></button>}<button onClick={onRefresh} disabled={state?.loading} type="button" aria-label="Refresh changes"><RefreshCw aria-hidden="true" className={state?.loading ? "icon-spin" : undefined} /><span>{state?.loading ? "READING" : "REFRESH"}</span></button></div>
    </header>
    {state?.loading && <div className="review-loading"><i /><div><b>Reading repository</b><span>Collecting staged, unstaged, and untracked patches…</span></div></div>}
    {!state?.loading && state?.error && <div className="review-state error"><b>Review unavailable</b><span>{state.error}</span><button type="button" onClick={onRefresh}>TRY AGAIN</button></div>}
    {!state?.loading && review?.files.length === 0 && <div className="review-state clean"><i aria-hidden="true"><Check /></i><b>Working tree is clean</b><span>There are no staged, unstaged, or untracked files.</span></div>}
    {!state?.loading && review?.truncated && <div className="review-warning">Review limits were reached. Some files or patch content are omitted.</div>}
    {!state?.loading && review && review.files.length > 0 && <div className="review-files">{review.files.map((file, index) => {
      const key = fileReviewKey(file);
      return <ReviewFileView file={file} initiallyOpen={review.files.length === 1 || index === 0} reviewed={reviewed.has(key)} canComment={canComment} onReviewedChange={(value) => updateReviewed(key, value)} onSendComment={onSendComment} key={file.path} />;
    })}</div>}
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
  const [initialRoute] = useState(readWorkbenchRoute);
  const routedSessionId = initialRoute.sessionId;
  const [initialRequestedSessionId] = useState(() => routedSessionId ?? readLastOpenedSession());
  const [state, setState] = useState<LoadState>({ _tag: "Loading" });
  const [sessionOpenHistory, setSessionOpenHistory] = useState(readSessionOpenHistory);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedSession, setSelectedSession] = useState<OwnedSession>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [workspaceCreatorOpen, setWorkspaceCreatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactionDialogOpen, setCompactionDialogOpen] = useState(false);
  const [workflowDialog, setWorkflowDialog] = useState<"start" | "revise" | "resume" | "intervene" | "continueRepairs">();
  const [workflowObjective, setWorkflowObjective] = useState("");
  const [workflowFeedback, setWorkflowFeedback] = useState("");
  const [workflowScopeChange, setWorkflowScopeChange] = useState(false);
  const [workflowRepairLimit, setWorkflowRepairLimit] = useState("3");
  const [workflowAdditionalRepairs, setWorkflowAdditionalRepairs] = useState("2");
  const [workflowMutationPending, setWorkflowMutationPending] = useState<{ readonly token: number; readonly sessionId: string; readonly phase: EngineeringWorkflow["phase"] | null }>();

  const [archiveTarget, setArchiveTarget] = useState<OwnedSessionSummary>();
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const [restartTarget, setRestartTarget] = useState<OwnedSessionSummary>();
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const [renameSessionTarget, setRenameSessionTarget] = useState<OwnedSessionSummary>();
  const [renameWorkspaceTarget, setRenameWorkspaceTarget] = useState<Workspace>();
  const [removeWorkspaceTarget, setRemoveWorkspaceTarget] = useState<Workspace>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalPickerOpen, setGlobalPickerOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeView, setActiveView] = useState<SessionView>(() => routedSessionId ? initialRoute.view : "agent");
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
  const requestedRouteRef = useRef<WorkbenchRoute | undefined>(routedSessionId ? initialRoute : undefined);
  const pendingPagePositionRef = useRef<PagePosition | undefined>(routedSessionId ? initialRoute.position : undefined);
  const restoringPagePositionRef = useRef(Boolean(routedSessionId));
  const locationSyncFrameRef = useRef(0);
  const routeRestoreTimerRef = useRef(0);
  const historicalRouteLoadRef = useRef(0);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const workflowMutationSequenceRef = useRef(0);
  const workflowMutationTokensRef = useRef(new Map<string, number>());
  const timelineRef = useRef<HTMLElement>(null);
  const timelineScrollFrameRef = useRef(0);
  const timelineScrollTopRef = useRef(0);
  const timelinePointerScrollingRef = useRef(false);
  const timelineTouchYRef = useRef<number | undefined>(undefined);
  const timelinePrependAnchorRef = useRef<{ readonly key: string; readonly top: number } | undefined>(undefined);
  const timelinePrependFrameRef = useRef(0);
  const timelineVirtualAnchorRef = useRef<{ readonly key: string; readonly top: number } | undefined>(undefined);
  const timelineWindowShiftingRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const mentionSearchInputRef = useRef<HTMLInputElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionReturnCursorRef = useRef<number | undefined>(undefined);
  const slashReturnCursorRef = useRef<number | undefined>(undefined);
  const mentionSearchTimerRef = useRef(0);
  const copyFeedbackTimerRef = useRef(0);
  const mentionSearchGenerationRef = useRef(0);
  const mentionMenuRef = useRef<MentionMenuState | undefined>(undefined);
  const lastMentionMenuRef = useRef<MentionMenuState | undefined>(undefined);
  const mentionOptionsRef = useRef<MentionMenuState | undefined>(undefined);
  const requestMentionSearchRef = useRef<(active: ActiveFileMention, query: string) => void>(() => undefined);
  const slashCommandCatalogRef = useRef(new Map<string, ReadonlyArray<PiSlashCommand>>());
  const slashCommandRequestsRef = useRef(new Map<string, Promise<ReadonlyArray<PiSlashCommand>>>());
  const dismissedSlashCommandRef = useRef<{ readonly text: string; readonly cursor: number } | undefined>(undefined);
  const completedMentionRef = useRef<{ readonly text: string; readonly cursor: number } | undefined>(undefined);
  const suppressMentionSelectionRef = useRef(false);
  const optionNavigationModifierRef = useRef(false);
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
  const compactionReturnFocusRef = useRef<HTMLElement | null>(null);
  const workflowReturnFocusRef = useRef<HTMLElement | null>(null);
  const workflowObjectiveRef = useRef<HTMLTextAreaElement>(null);
  const workflowRepairInputRef = useRef<HTMLInputElement>(null);
  const archiveReturnFocusRef = useRef<HTMLElement | null>(null);
  const restartReturnFocusRef = useRef<HTMLElement | null>(null);
  const renameSessionReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const sessionSyncRef = useRef(initialSessionSyncState());
  const detailGeneration = useRef(0);
  const sessionOpenRequest = useRef(0);
  const sessionOpenInFlightRef = useRef<string | undefined>(undefined);
  const reviewGeneration = useRef(0);
  const fastSessionCacheRef = useRef(new Map<string, OwnedSession>());
  const sessionUiStatesRef = useRef(new Map<string, SessionUiState>());
  const currentSessionUiRef = useRef<SessionUiState>(emptySessionUiState());
  currentSessionUiRef.current = { commandText, images, delivery, busy, operationError, outbox };
  isMobileRef.current = isMobile;
  selectedSessionRef.current = selectedSession;
  mentionMenuRef.current = mentionMenu;
  if (mentionMenu) lastMentionMenuRef.current = mentionMenu;
  if (mentionMenu?.mentions.length) mentionOptionsRef.current = mentionMenu;
  imagesRef.current = images;

  useSharedKeyboardScrolling(timelineRef, (element, direction) => {
    if (element === timelineRef.current && direction < 0) {
      followingRef.current = false;
      setAtBottom(false);
    }
  });

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
  const globalPickerItems = useMemo(
    () => state._tag === "Ready" ? sessionPickerItems(state.sessions, state.workspaces, sessionOpenHistory) : [],
    [sessionOpenHistory, state],
  );
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

  const selectSession = useCallback((
    sessionId: string | undefined,
    persistCurrent = true,
    route: WorkbenchRoute = { sessionId, view: "agent", position: defaultPagePosition("agent") },
    historyMode: "push" | "replace" | "none" = "replace",
  ) => {
    const currentId = selectedSessionIdRef.current;
    const currentSnapshot = sessionForFastSwitchCache(sessionSyncRef.current);
    if (currentId && currentSnapshot?.id === currentId) {
      fastSessionCacheRef.current.delete(currentId);
      fastSessionCacheRef.current.set(currentId, currentSnapshot);
      while (fastSessionCacheRef.current.size > 20) {
        const oldestId = fastSessionCacheRef.current.keys().next().value as string | undefined;
        if (!oldestId) break;
        fastSessionCacheRef.current.delete(oldestId);
      }
      void writeCachedSession(currentSnapshot).catch(() => undefined);
    }
    if (currentId && persistCurrent) {
      sessionUiStatesRef.current.set(currentId, currentSessionUiRef.current);
      writeDraft(currentId, currentSessionUiRef.current.commandText, currentSessionUiRef.current.delivery);
    }
    const persisted = sessionId ? readDraft(sessionId) : undefined;
    const nextUi = sessionId
      ? sessionUiStatesRef.current.get(sessionId) ?? { ...emptySessionUiState(), commandText: persisted?.text ?? "", delivery: persisted?.delivery ?? "steer" }
      : emptySessionUiState();
    detailGeneration.current += 1;
    sessionOpenRequest.current += 1;
    sessionOpenInFlightRef.current = undefined;
    dismissMentionMenu();
    setSlashCommandMenu(undefined);
    selectedSessionIdRef.current = sessionId;
    sessionSyncRef.current = reduceSessionSync(sessionSyncRef.current, { type: "select", sessionId });
    const fastSnapshot = sessionId ? fastSessionCacheRef.current.get(sessionId) : undefined;
    if (fastSnapshot) sessionSyncRef.current = reduceSessionSync(sessionSyncRef.current, { type: "cachedSnapshot", session: fastSnapshot });
    window.clearTimeout(routeRestoreTimerRef.current);
    routeRestoreTimerRef.current = 0;
    pendingPagePositionRef.current = route.position;
    restoringPagePositionRef.current = true;
    followingRef.current = route.view === "agent" && route.position._tag === "latest";
    timelinePrependAnchorRef.current = undefined;
    window.cancelAnimationFrame(timelinePrependFrameRef.current);
    timelineScrollTopRef.current = 0;
    setTimelineWindowEnd(undefined);
    setAtBottom(followingRef.current);
    setCommandText(nextUi.commandText);
    imagesRef.current = nextUi.images;
    setImages(nextUi.images);
    setDelivery(nextUi.delivery);
    setBusy(nextUi.busy);
    setOperationError(nextUi.operationError);
    setCopyFeedback(undefined);
    reviewGeneration.current += 1;
    setReviewState(undefined);
    setActiveView(route.view);
    setCompactionDialogOpen(false);
    setArchiveTarget(undefined);
    setOutbox(nextUi.outbox);
    setSelectedSessionId(sessionId);
    selectedSessionRef.current = sessionSyncRef.current.session;
    setSelectedSession(sessionSyncRef.current.session);
    if (sessionId && !fastSnapshot) {
      void readCachedSession(sessionId).then((cached) => {
        if (!cached || selectedSessionIdRef.current !== sessionId) return;
        dispatchSessionSync({ type: "cachedSnapshot", session: cached });
      });
    }
    setSessionOpenHistory(writeLastOpenedSession(sessionId));
    if (historyMode !== "none") writeWorkbenchRoute(route, historyMode);
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
      const requestedRoute = requestedRouteRef.current;
      const nextId = currentId && (sessions.some((session) => session.id === currentId) || selectionChangedDuringRefresh)
        ? currentId
        : requestedId && sessions.some((session) => session.id === requestedId)
          ? requestedId
          : sessions[0]?.id;
      if (requestedId && nextId === requestedId) {
        requestedSessionIdRef.current = undefined;
        requestedRouteRef.current = undefined;
      }
      setState({ _tag: "Ready", workspaces, sessions });
      setRefreshProblem(undefined);
      if (nextId !== currentId) {
        const route = requestedRoute?.sessionId === nextId
          ? requestedRoute
          : { sessionId: nextId, view: "agent" as const, position: defaultPagePosition("agent") };
        selectSession(nextId, true, route, "replace");
      }
      if (nextId && sessions.some((session) => session.id === nextId) && sessionOpenInFlightRef.current !== nextId && shouldPollSession(sessionSyncRef.current)) {
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
    && !creatorOpen && !workspaceCreatorOpen && !settingsOpen && !compactionDialogOpen
    && !(sessionSyncRef.current.runtimeGenerationConfirmed && selectedSession?.interactiveRequests[0]) && !(isMobile && mentionMenu)
    && !archiveTarget && !restartTarget && !renameSessionTarget && !renameWorkspaceTarget && !removeWorkspaceTarget;

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

  useLayoutEffect(() => {
    const cursor = slashReturnCursorRef.current;
    if (slashCommandMenu || cursor === undefined) return;
    slashReturnCursorRef.current = undefined;
    composerTextareaRef.current?.focus();
    composerTextareaRef.current?.setSelectionRange(cursor, cursor);
  }, [slashCommandMenu]);

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
    if (selectedSession && !isWritableRuntime(selectedSession.status)) dismissMentionMenu();
  }, [dismissMentionMenu, selectedSession?.status]);

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

  useEffect(() => {
    const requested = pendingPagePositionRef.current;
    if (activeView !== "agent" || requested?._tag !== "timeline" || !selectedSession || oldestSequence === undefined || oldestSequence <= requested.sequence) return;
    const generation = ++historicalRouteLoadRef.current;
    const sessionId = selectedSession.id;
    setTimelineHistory((current) => ({ ...current, loading: true, error: undefined }));
    void (async () => {
      let before = oldestSequence;
      let hasMore = true;
      try {
        while (generation === historicalRouteLoadRef.current && before > requested.sequence && hasMore) {
          const page = await Effect.runPromise(loadTimelinePage(sessionId, before));
          if (generation !== historicalRouteLoadRef.current || selectedSessionIdRef.current !== sessionId) return;
          if (page.events.length === 0) { hasMore = false; break; }
          dispatchSessionSync({ type: "historicalPage", events: page.events });
          before = page.events[0]!.sequence;
          hasMore = page.hasMore;
        }
        if (generation === historicalRouteLoadRef.current) setTimelineHistory({ loading: false, hasMore });
      } catch (cause) {
        if (generation === historicalRouteLoadRef.current) setTimelineHistory({ loading: false, hasMore: true, error: errorMessage(cause) });
      }
    })();
    return () => { if (historicalRouteLoadRef.current === generation) historicalRouteLoadRef.current += 1; };
  }, [activeView, dispatchSessionSync, oldestSequence, selectedSession?.id]);

  useEffect(() => {
    const requested = pendingPagePositionRef.current;
    if (activeView !== "agent" || requested?._tag !== "timeline") return;
    const anchorIndex = timeline.findIndex((item) => item.key === requested.anchor || item.sequence === requested.sequence);
    if (anchorIndex < 0 || anchorIndex >= timelineWindowStart && anchorIndex < effectiveTimelineWindowEnd) return;
    const nextEnd = Math.min(timeline.length, Math.max(TIMELINE_WINDOW_SIZE, anchorIndex + Math.floor(TIMELINE_WINDOW_SIZE / 2)));
    setTimelineWindowEnd(nextEnd >= timeline.length ? undefined : nextEnd);
  }, [activeView, effectiveTimelineWindowEnd, timeline, timelineWindowStart]);

  const syncRoutePosition = (element: HTMLElement, nextAtBottom: boolean) => {
    if (restoringPagePositionRef.current) return;
    window.cancelAnimationFrame(locationSyncFrameRef.current);
    locationSyncFrameRef.current = window.requestAnimationFrame(() => {
      const sessionId = selectedSessionIdRef.current;
      const currentRoute = readWorkbenchRoute();
      if (!sessionId || currentRoute.sessionId !== sessionId || currentRoute.view !== activeView) return;
      let position: PagePosition;
      if (activeView !== "agent") {
        position = { _tag: "scroll", top: Math.round(element.scrollTop) };
      } else if (nextAtBottom && effectiveTimelineWindowEnd >= timeline.length) {
        position = { _tag: "latest" };
      } else {
        const viewportTop = element.getBoundingClientRect().top;
        const rows = [...element.querySelectorAll<HTMLElement>("[data-timeline-key][data-timeline-sequence]")];
        const anchor = rows.find((row) => row.getBoundingClientRect().bottom > viewportTop + 1) ?? rows.at(-1);
        const sequence = anchor ? Number(anchor.dataset.timelineSequence) : Number.NaN;
        position = anchor?.dataset.timelineKey && Number.isSafeInteger(sequence)
          ? { _tag: "timeline", anchor: anchor.dataset.timelineKey, sequence, offset: Math.round(anchor.getBoundingClientRect().top - viewportTop) }
          : { _tag: "latest" };
      }
      writeWorkbenchRoute({ sessionId, view: activeView, position }, "replace");
    });
  };

  useEffect(() => () => {
    window.cancelAnimationFrame(locationSyncFrameRef.current);
    window.clearTimeout(routeRestoreTimerRef.current);
  }, []);

  const loadOlderTimeline = () => {
    if (!selectedSession || oldestSequence === undefined || timelineHistory.loading || !hasOlderTimeline) return;
    const element = timelineRef.current;
    const anchor = element?.querySelector<HTMLElement>("[data-timeline-key]");
    timelinePrependAnchorRef.current = anchor?.dataset.timelineKey
      ? { key: anchor.dataset.timelineKey, top: anchor.getBoundingClientRect().top }
      : undefined;
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
        window.cancelAnimationFrame(timelinePrependFrameRef.current);
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
    const stabilizePrependAnchor = () => {
      const anchor = timelinePrependAnchorRef.current;
      if (!anchor) return;
      const escapedKey = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(anchor.key) : anchor.key.replace(/["\\]/gu, "\\$&");
      const row = element.querySelector<HTMLElement>(`[data-timeline-key="${escapedKey}"]`);
      if (row) element.scrollTop += row.getBoundingClientRect().top - anchor.top;
      timelineScrollTopRef.current = element.scrollTop;
    };
    if (timelinePrependAnchorRef.current) {
      stabilizePrependAnchor();
      window.cancelAnimationFrame(timelinePrependFrameRef.current);
      timelinePrependFrameRef.current = window.requestAnimationFrame(() => {
        stabilizePrependAnchor();
        timelinePrependFrameRef.current = window.requestAnimationFrame(() => {
          stabilizePrependAnchor();
          timelinePrependAnchorRef.current = undefined;
        });
      });
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
    const requested = pendingPagePositionRef.current;
    const restoreRequestedPosition = () => {
      if (!requested || pendingPagePositionRef.current !== requested) return false;
      if (activeView !== "agent" && requested._tag === "scroll") {
        element.scrollTop = requested.top;
        timelineScrollTopRef.current = element.scrollTop;
        return true;
      }
      if (activeView === "agent" && requested._tag === "timeline") {
        const escapedKey = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(requested.anchor) : requested.anchor.replace(/["\\]/gu, "\\$&");
        const row = element.querySelector<HTMLElement>(`[data-timeline-key="${escapedKey}"]`)
          ?? element.querySelector<HTMLElement>(`[data-timeline-sequence="${requested.sequence}"]`);
        if (!row) return false;
        element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - requested.offset;
        timelineScrollTopRef.current = element.scrollTop;
        setAtBottom(false);
        return true;
      }
      if (activeView === "agent" && requested._tag === "latest") {
        pinToBottom();
        return true;
      }
      return false;
    };
    const maintainPosition = () => {
      if (!restoreRequestedPosition()) pinToBottom();
    };
    maintainPosition();
    // Reassert app-owned position after native nested-scroll restoration and
    // after lazy markdown, images, or review data change the scroller's size.
    const restorationTimer = window.setTimeout(maintainPosition, 150);
    const resizeObserver = new ResizeObserver(maintainPosition);
    for (const child of element.children) resizeObserver.observe(child);
    if (requested && routeRestoreTimerRef.current === 0 && restoreRequestedPosition()) {
      routeRestoreTimerRef.current = window.setTimeout(() => {
        if (pendingPagePositionRef.current === requested) {
          pendingPagePositionRef.current = undefined;
          restoringPagePositionRef.current = false;
        }
        routeRestoreTimerRef.current = 0;
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        syncRoutePosition(element, activeView === "agent" && distanceFromBottom < 4);
      }, 300);
    }
    return () => {
      window.clearTimeout(restorationTimer);
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
    const expiration = nextDeliveredOutboxExpiration(outbox);
    if (expiration === undefined) return;
    const timer = window.setTimeout(() => {
      setOutbox((items) => pruneDeliveredOutbox(items, Date.now()));
    }, Math.max(0, expiration - Date.now()));
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

    const isSameSearch = (current: MentionMenuState | undefined): current is MentionMenuState => current?.active.start === active.start
      && current.active.end === active.end
      && current.active.query === query;
    setMentionMenu((current) => isSameSearch(current)
      ? { ...current, loading: true, error: undefined }
      : { active, mentions: [], loading: true, highlighted: 0 });
    mentionSearchTimerRef.current = window.setTimeout(() => {
      void Effect.runPromise(searchFileMentions(session.id, session.runtimeId, query)).then(
        ({ mentions }) => {
          if (mentionSearchGenerationRef.current !== generation || selectedSessionIdRef.current !== session.id) return;
          setMentionMenu((current) => isSameSearch(current)
            ? { ...current, mentions, loading: false, error: undefined, highlighted: Math.min(current.highlighted, Math.max(0, mentions.length - 1)) }
            : { active, mentions, loading: false, highlighted: 0 });
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
    slashReturnCursorRef.current = cursor;
    setSlashCommandMenu(undefined);
  };

  const removeSlashCommandTrigger = () => {
    if (!slashCommandMenu) return;
    const text = commandText.slice(slashCommandMenu.active.end);
    dismissedSlashCommandRef.current = undefined;
    setCommandText(text);
    slashReturnCursorRef.current = 0;
    setSlashCommandMenu(undefined);
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
    const textarea = composerTextareaRef.current;
    const liveText = textarea?.value ?? commandText;
    const liveActive = activeSlashCommand(liveText, textarea?.selectionStart ?? slashCommandMenu.active.end);
    if (!liveActive) return;
    const applied = applySlashCommand(liveText, liveActive, item.name);
    setCommandText(applied.text);
    slashReturnCursorRef.current = applied.cursor;
    setSlashCommandMenu(undefined);
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

  useEffect(() => {
    if (activeView === "changes" && selectedSession && reviewState?.sessionId !== selectedSession.id) void requestReview(selectedSession);
  }, [activeView, selectedSession?.id, selectedSession?.runtimeId]);

  const removeActiveMention = () => {
    if (!mentionMenu) return;
    const { start, end } = mentionMenu.active;
    const liveText = composerTextareaRef.current?.value ?? commandText;
    if (!liveText.slice(start, end).startsWith("@")) {
      dismissMentionMenu();
      return;
    }
    const next = `${liveText.slice(0, start)}${liveText.slice(end)}`;
    setCommandText(next);
    mentionReturnCursorRef.current = start;
    dismissMentionMenu();
  };

  const closeMentionPicker = () => {
    mentionReturnCursorRef.current = mentionMenu?.active.end ?? commandText.length;
    dismissMentionMenu();
  };

  const chooseMention = (item: FileMention) => {
    const currentMentionMenu = mentionMenuRef.current?.mentions.length ? mentionMenuRef.current : mentionOptionsRef.current ?? lastMentionMenuRef.current;
    if (!currentMentionMenu) return;
    const liveText = composerTextareaRef.current?.value ?? commandText;
    if (!liveText.slice(currentMentionMenu.active.start, currentMentionMenu.active.end).startsWith("@")) return;
    const applied = applyFileMention(liveText, currentMentionMenu.active, item.path);
    setCommandText(applied.text);
    mentionReturnCursorRef.current = applied.cursor;
    setMentionMenu(undefined);
    completedMentionRef.current = applied;
    suppressMentionSelectionRef.current = true;
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
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      if (cursor === next.length) textarea.scrollTop = textarea.scrollHeight;
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
      selectSession(session.id, true, { sessionId: session.id, view: "agent", position: defaultPagePosition("agent") }, "push");
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

  const openSession = async (
    sessionId: string,
    route: WorkbenchRoute = { sessionId, view: "agent", position: defaultPagePosition("agent") },
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    selectSession(sessionId, true, route, historyMode);
    const requestId = ++sessionOpenRequest.current;
    sessionOpenInFlightRef.current = sessionId;
    setSidebarOpen(false);
    const applySnapshot = (session: OwnedSession) => {
      if (selectedSessionIdRef.current !== sessionId || sessionOpenRequest.current !== requestId) return false;
      dispatchSessionSync({
        type: "snapshotReset",
        session,
        cursor: session.events.at(-1)?.sequence ?? 0,
        receivedAt: Date.now(),
      });
      return true;
    };
    try {
      const request = sessionSyncRequest(sessionSyncRef.current);
      let loaded = (await Effect.runPromise(loadSession(sessionId, request.cursor || undefined))).session;
      if (selectedSessionIdRef.current !== sessionId || sessionOpenRequest.current !== requestId) return;

      // Reuse a same-generation cached tail and transfer only newer events.
      // A runtime replacement invalidates that cursor and requires a complete
      // snapshot before anything from the new generation can be shown.
      if (request.runtimeId && loaded.runtimeId !== request.runtimeId) {
        loaded = (await Effect.runPromise(loadSession(sessionId))).session;
        if (!applySnapshot(loaded)) return;
      } else {
        dispatchSessionSync({ type: "httpIncremental", session: loaded, request });
      }

      // Acknowledgement updates attention state, but the current timeline
      // should not wait for this second round trip before becoming visible.
      if (loaded.status === "finished") {
        const acknowledged = (await Effect.runPromise(acknowledgeOwnedSession(loaded.id, loaded.runtimeId))).session;
        applySnapshot(acknowledged);
      }
    } catch (error) {
      if (selectedSessionIdRef.current === sessionId && sessionOpenRequest.current === requestId) {
        setOperationError(errorMessage(error));
      }
    } finally {
      if (sessionOpenRequest.current === requestId) sessionOpenInFlightRef.current = undefined;
    }
  };

  const changeView = (view: SessionView, historyMode: "push" | "replace" = "push") => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || view === activeView) return;
    const position = defaultPagePosition(view);
    window.clearTimeout(routeRestoreTimerRef.current);
    routeRestoreTimerRef.current = 0;
    pendingPagePositionRef.current = position;
    restoringPagePositionRef.current = true;
    followingRef.current = view === "agent";
    setAtBottom(view === "agent");
    setTimelineWindowEnd(undefined);
    setActiveView(view);
    writeWorkbenchRoute({ sessionId, view, position }, historyMode);
    if (view === "changes" && selectedSessionRef.current) void requestReview(selectedSessionRef.current);
  };

  const chooseGlobalPickerAction = (action: SelectSessionAction) => {
    setGlobalPickerOpen(false);
    globalPickerReturnFocusRef.current = sessionHeadingRef.current;
    if (action._tag === "SelectSession") void openSession(action.sessionId);
  };

  useEffect(() => {
    const restoreHistoryEntry = () => {
      const route = readWorkbenchRoute();
      if (!route.sessionId) return;
      if (route.sessionId !== selectedSessionIdRef.current) {
        void openSession(route.sessionId, route, "none");
        return;
      }
      window.clearTimeout(routeRestoreTimerRef.current);
      routeRestoreTimerRef.current = 0;
      pendingPagePositionRef.current = route.position;
      restoringPagePositionRef.current = true;
      followingRef.current = route.view === "agent" && route.position._tag === "latest";
      setAtBottom(followingRef.current);
      setTimelineWindowEnd(undefined);
      setActiveView(route.view);
      if (route.view === "changes" && selectedSessionRef.current) void requestReview(selectedSessionRef.current);
    };
    window.addEventListener("popstate", restoreHistoryEntry);
    return () => window.removeEventListener("popstate", restoreHistoryEntry);
  });

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

  const command = async (action: OwnedSessionCommandAction, reviewText?: string): Promise<boolean> => {
    if (!selectedSession) return false;
    const needsContent = action === "prompt" || action === "steer" || action === "followUp";
    const text = (reviewText ?? commandText).trim();
    const targetImages = needsContent && reviewText === undefined ? images : [];
    if (needsContent && (imageSelectionPending || !text && targetImages.length === 0)) return false;
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
        if (reviewText === undefined) removeDraft(targetSessionId);
        if (selectedSessionIdRef.current === targetSessionId) {
          if (reviewText === undefined) {
            setCommandText("");
            imagesRef.current = [];
            setImages([]);
            setMentionMenu(undefined);
          }
          setOutbox((items) => markOutboxQueued(items, outgoing.id));
        } else {
          const stored = sessionUiStatesRef.current.get(targetSessionId) ?? emptySessionUiState();
          sessionUiStatesRef.current.set(targetSessionId, {
            ...stored,
            commandText: reviewText === undefined ? "" : stored.commandText,
            images: reviewText === undefined ? [] : stored.images,
            outbox: markOutboxQueued(stored.outbox, outgoing.id),
          });
        }
      }
      await refresh(false);
      return true;
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
      return false;
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

  const runWorkflowMutation = async (input: WorkflowMutationRequest) => {
    const session = selectedSessionRef.current;
    if (!session) return;
    const phase = session.workflow?.phase ?? null;
    if (workflowMutationPending?.sessionId === session.id && workflowMutationPending.phase === phase) return;
    const targetId = session.id;
    const mutationId = input.mutationId ?? crypto.randomUUID();
    const guardedInput = session.workflow && input.action !== "start"
      ? {
        ...input,
        workflowId: session.workflow.id,
        mutationId,
        expectedRevision: session.workflow.revision ?? 0,
        expectedPhase: session.workflow.phase,
        ...(session.workflow.phaseRun ? { expectedPhaseRunId: session.workflow.phaseRun.id } : {}),
      } as EngineeringWorkflowMutationInput
      : { ...input, mutationId } as EngineeringWorkflowMutationInput;
    const token = ++workflowMutationSequenceRef.current;
    workflowMutationTokensRef.current.set(targetId, token);
    setWorkflowMutationPending({ token, sessionId: targetId, phase });
    setBusy(true);
    setOperationError(undefined);
    try {
      const result = await Effect.runPromise(mutateEngineeringWorkflow(session.id, guardedInput));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(result.session);
      setWorkflowDialog(undefined);
      setWorkflowFeedback("");
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      setWorkflowMutationPending((current) => current?.token === token ? undefined : current);
      if (workflowMutationTokensRef.current.get(targetId) === token) {
        workflowMutationTokensRef.current.delete(targetId);
        if (selectedSessionIdRef.current === targetId) setBusy(false);
        else {
          const stored = sessionUiStatesRef.current.get(targetId) ?? emptySessionUiState();
          sessionUiStatesRef.current.set(targetId, { ...stored, busy: false });
        }
      }
    }
  };

  const openWorkflowStarter = (returnFocus: HTMLElement) => {
    workflowReturnFocusRef.current = returnFocus;
    setWorkflowObjective(commandText.trim());
    setWorkflowRepairLimit("3");
    setWorkflowDialog("start");
  };

  const submitWorkflow = (event: FormEvent) => {
    event.preventDefault();
    const session = selectedSessionRef.current;
    const objective = workflowObjective.trim();
    if (!session || !objective || busy) return;
    if (objective === commandText.trim()) {
      setCommandText("");
      removeDraft(session.id);
    }
    void runWorkflowMutation({
      runtimeId: session.runtimeId,
      action: "start",
      objective,
      maxRepairAttempts: Math.max(1, Math.min(10, Number.parseInt(workflowRepairLimit, 10) || 1)),
    });
  };

  const submitWorkflowRevision = (event: FormEvent) => {
    event.preventDefault();
    const session = selectedSessionRef.current;
    const feedback = workflowFeedback.trim();
    if (!session || !feedback || busy) return;
    void runWorkflowMutation({ runtimeId: session.runtimeId, action: "revise", feedback });
  };

  const submitWorkflowResume = (event: FormEvent) => {
    event.preventDefault();
    const session = selectedSessionRef.current;
    const feedback = workflowFeedback.trim();
    if (!session || session.workflow?.phase !== "blocked" || !feedback || busy) return;
    void runWorkflowMutation(workflowScopeChange
      ? { runtimeId: session.runtimeId, action: "intervene", feedback, scopeChange: true }
      : { runtimeId: session.runtimeId, action: "resume", feedback });
  };

  const continueWorkflow = () => {
    const session = selectedSessionRef.current;
    const workflow = session?.workflow;
    const interrupted = workflow?.phase === "cancelled" && workflow.error?.includes("runtime stopped");
    if (!session || !workflow || (workflow.phase !== "blocked" && !interrupted) || busy) return;
    void runWorkflowMutation({
      runtimeId: session.runtimeId,
      action: "resume",
      feedback: interrupted
        ? "Resume the interrupted workflow using its preserved approved specification and delivery plan. Reconcile any work completed before the runtime interruption, then continue from the first incomplete criterion."
        : "The operator chose to continue. Proceed only within the approved specification and delivery plan. Do not infer credentials, facts, evidence, or permission beyond this decision; if another concrete input is required, explain it plainly and block again.",
    });
  };

  const submitWorkflowIntervention = (event: FormEvent) => {
    event.preventDefault();
    const session = selectedSessionRef.current;
    const feedback = workflowFeedback.trim();
    if (!session || !feedback || busy) return;
    void runWorkflowMutation({ runtimeId: session.runtimeId, action: "intervene", feedback, ...(workflowScopeChange ? { scopeChange: true } : {}) });
  };

  const continueFailedWorkflow = async (additionalRepairAttempts: number) => {
    const session = selectedSessionRef.current;
    if (!session || busy) return;
    const targetId = session.id;
    setBusy(true);
    setOperationError(undefined);
    try {
      const activeSession = session.status === "stopped" || session.status === "crashed"
        ? (await Effect.runPromise(resumeOwnedSession(session.id, session.runtimeId))).session
        : session;
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(activeSession);
      const workflow = activeSession.workflow;
      if (!workflow) throw new Error("The session has no engineering workflow");
      const result = await Effect.runPromise(mutateEngineeringWorkflow(activeSession.id, {
        runtimeId: activeSession.runtimeId,
        action: "continueRepairs",
        additionalRepairAttempts,
        workflowId: workflow.id,
        mutationId: crypto.randomUUID(),
        expectedRevision: workflow.revision ?? 0,
        expectedPhase: workflow.phase,
        ...(workflow.phaseRun ? { expectedPhaseRunId: workflow.phaseRun.id } : {}),
      }));
      if (selectedSessionIdRef.current === targetId) acceptAuthoritativeSession(result.session);
      setWorkflowDialog(undefined);
      await refresh(false);
    } catch (cause) {
      if (selectedSessionIdRef.current === targetId) setOperationError(errorMessage(cause));
      await refresh(false);
    } finally {
      if (selectedSessionIdRef.current === targetId) setBusy(false);
    }
  };

  const submitWorkflowContinuation = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    void continueFailedWorkflow(Math.max(1, Math.min(10, Number.parseInt(workflowAdditionalRepairs, 10) || 1)));
  };

  const mutateCurrentWorkflow = (action: "approve" | "accept" | "cancel") => {
    const session = selectedSessionRef.current;
    if (!session) return;
    void runWorkflowMutation({ runtimeId: session.runtimeId, action });
  };

  const openWorkflowRevision = (returnFocus: HTMLElement) => {
    workflowReturnFocusRef.current = returnFocus;
    setWorkflowFeedback("");
    setWorkflowDialog("revise");
  };

  const openWorkflowResume = (returnFocus: HTMLElement) => {
    workflowReturnFocusRef.current = returnFocus;
    setWorkflowFeedback("");
    setWorkflowScopeChange(false);
    setWorkflowDialog("resume");
  };

  const openWorkflowIntervention = (returnFocus: HTMLElement) => {
    workflowReturnFocusRef.current = returnFocus;
    setWorkflowFeedback("");
    setWorkflowScopeChange(false);
    setWorkflowDialog("intervene");
  };

  const openWorkflowContinuation = (returnFocus: HTMLElement) => {
    workflowReturnFocusRef.current = returnFocus;
    setWorkflowAdditionalRepairs("2");
    setWorkflowDialog("continueRepairs");
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
        window.requestAnimationFrame(() => composerRef.current?.querySelector<HTMLButtonElement>(".composer-config-trigger.model")?.click());
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
        changeView("details");
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

  const restartSessionRuntime = async () => {
    if (!restartTarget || restartPending) return;
    const target = restartTarget;
    setRestartPending(true);
    setRestartError(undefined);
    try {
      await Effect.runPromise(sendSessionCommand({ sessionId: target.id, runtimeId: target.runtimeId, action: "stop" }));
      const { session } = await Effect.runPromise(resumeOwnedSession(target.id, target.runtimeId));
      if (selectedSessionIdRef.current === target.id) acceptAuthoritativeSession(session);
      setRestartTarget(undefined);
      await refresh(false);
    } catch (cause) {
      setRestartError(errorMessage(cause));
      await refresh(false);
    } finally {
      setRestartPending(false);
    }
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
  const workflowActive = Boolean(selectedSession?.workflow && !isTerminalWorkflowPhase(selectedSession.workflow.phase));
  const canStartWorkflow = Boolean(selectedSession && runtimeIsCurrent && canAcceptPrompt(selectedSession.status) && !workflowActive);
  const sendReviewComment = (message: string): Promise<boolean> => {
    if (!selectedSession || !canWrite || busy) return Promise.resolve(false);
    const action: OwnedSessionCommandAction = selectedSession.status === "working"
      ? delivery
      : canAcceptPrompt(selectedSession.status)
        ? "prompt"
        : "followUp";
    return command(action, message);
  };
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
  // Cached snapshots seed incremental synchronization, but stay hidden until
  // the server has confirmed them so stale chat never becomes a visible frame.
  const sessionIsLoading = Boolean(selectedSessionId && !sessionSyncRef.current.serverConfirmed);
  const pickerShortcutLabel = formatForDisplay(HOTKEYS.openGlobalPicker);

  return (
    <>
      {state._tag === "Loading" && <StartupScreen />}
      <Drawer.Root open={isMobile ? sidebarOpen : true} modal={isMobile} swipeDirection="left" onOpenChange={(open, details) => {
      if (!isMobile) { details.cancel(); return; }
      setSidebarOpen(open);
    }}>
    <div className={`shell ${mobileKeyboardOpen ? "mobile-keyboard-open" : ""}`} ref={shellRef}>
      <header className="masthead">
        <Drawer.Trigger className="mobile-menu" ref={mobileMenuRef} aria-label="Open workspaces and sessions"><Menu aria-hidden="true" /></Drawer.Trigger>
        <div className={`brand ${selectedSession && !sessionIsLoading ? "session-brand" : ""}`} title={selectedWorkspace?.root} ref={sessionHeadingRef} tabIndex={-1}>
          {selectedSession && !sessionIsLoading && <>
            <span className="brand-mark">π</span>
            <div>
              <b>{selectedSession.name}</b>
              <small><span>{selectedWorkspace?.name ?? "Workspace"}{selectedSession.branch ? ` · ${selectedSession.branch}` : ""}</span><span className="session-runtime"> · {selectedSession.model?.name ?? "No model"} · {selectedSession.thinkingLevel ?? "off"}</span></small>
            </div>
          </>}
        </div>
        <button className="global-picker-trigger" type="button" onClick={(event) => openGlobalPicker(event.currentTarget)} aria-label="Search sessions" title={`Search sessions (${pickerShortcutLabel})`}><Search aria-hidden="true" /><span>SEARCH SESSIONS</span><kbd>{pickerShortcutLabel}</kbd></button>
        {updateRegistration?.waiting && <button className="update-ready" type="button" disabled={busy} onClick={() => {
          requestUpdateActivation();
          updateRegistration.waiting?.postMessage({ type: "SKIP_WAITING" });
        }}>{busy ? "UPDATE WAITING" : "APPLY UPDATE"}</button>}
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
                  const workflowBadge = session.workflow ? workflowBadgePhaseLabel(session.workflow.phase) : undefined;
                  return <div className="session-row" key={session.id}>
                    <button className={`session-card ${session.id === selectedSessionId ? "selected" : ""}`} onClick={() => void openSession(session.id)} type="button" aria-current={session.id === selectedSessionId ? "page" : undefined}>
                      <i className={`state-dot ${status}`} />
                      <span className="session-copy">
                        <span className="session-title"><strong>{session.name}</strong>{workflowBadge && <span className="workflow-phase-badge">LOOP · {workflowBadge}</span>}</span>
                        <small>{ATTENTION_STATE_LABELS[session.status]} · {session.eventCount} events · {relativeTime(session.lastActivityAt, now)}</small>
                      </span>
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
                        ...(session.status !== "stopped" && session.status !== "crashed" && session.status !== "stopping" ? [{ label: "RESTART PI RUNTIME", onSelect: (returnFocus: HTMLElement) => {
                          restartReturnFocusRef.current = returnFocus;
                          setRestartError(undefined);
                          setRestartTarget(session);
                        } }] : []),
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
        {selectedSession && !sessionIsLoading ? <Tabs.Root className={`session-view${activeView === "agent" && selectedSession.workflow && workflowUsesFocusedLayout(selectedSession.workflow.phase) ? " workflow-focus-view" : ""}`} value={activeView} onValueChange={(value) => {
          changeView(value as SessionView);
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
              data-keyboard-scroll
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
                // Keep the gesture's starting point: sub-pixel moves must add up
                // after native panning cancels pointer tracking.
                if (nextY !== undefined && timelineTouchYRef.current !== undefined && nextY > timelineTouchYRef.current + 1) {
                  followingRef.current = false;
                  setAtBottom(false);
                }
              }}
              onTouchEnd={() => { timelineTouchYRef.current = undefined; }}
              onTouchCancel={() => { timelineTouchYRef.current = undefined; }}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                const nextAtBottom = effectiveTimelineWindowEnd >= timeline.length && distanceFromBottom < 4;
                const userDragging = timelinePointerScrollingRef.current || timelineTouchYRef.current !== undefined;
                const draggedUp = userDragging && element.scrollTop < timelineScrollTopRef.current;
                timelineScrollTopRef.current = element.scrollTop;
                if (draggedUp) followingRef.current = false;
                else if (nextAtBottom) followingRef.current = true;

                // Mobile browsers can restore a nested scroller well after the
                // chat has rendered. That scroll has no user gesture, so keep
                // following the latest item instead of revealing an arbitrary
                // older window. Wheel, touch, pointer, and keyboard handlers
                // disable following before intentional upward scrolling lands.
                if (followingRef.current && !nextAtBottom) {
                  window.cancelAnimationFrame(timelineScrollFrameRef.current);
                  timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
                    if (!followingRef.current) return;
                    element.scrollTop = element.scrollHeight;
                    timelineScrollTopRef.current = element.scrollTop;
                    setAtBottom(true);
                  });
                  return;
                }

                if (element.scrollTop < 24) shiftTimelineWindow("earlier", element);
                else if (distanceFromBottom < 24 && effectiveTimelineWindowEnd < timeline.length) shiftTimelineWindow("later", element);
                setAtBottom(nextAtBottom);
                syncRoutePosition(element, nextAtBottom);
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
                ? <article className={`message ${item.role} ${item.live ? "live" : ""}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence}>
                    <header><span>{item.role === "assistant" ? "PI" : "REMOTE"}</span>{item.live && <i>STREAMING</i>}<button className={`timeline-copy ${copyFeedback?.key === item.key ? copyFeedback.ok ? "copied" : "failed" : ""}`} onClick={() => void copyTimelineText(item.key, `${item.role === "assistant" ? "PI" : "REMOTE"} message`, item.text || `${item.imageCount} image${item.imageCount === 1 ? "" : "s"} attached`)} type="button" aria-label={`${copyFeedback?.key === item.key ? copyFeedback.ok ? "Copied" : "Copy failed" : "Copy"} ${item.role === "assistant" ? "PI" : "REMOTE"} message`}><Copy aria-hidden="true" /><b>{copyFeedback?.key === item.key ? copyFeedback.ok ? "COPIED" : "FAILED" : "COPY"}</b></button></header>
                    {item.text && <LazyMarkdown text={item.text} />}
                    {item.imageCount > 0 && <div className="message-images"><Image aria-hidden="true" /> {item.imageCount} IMAGE{item.imageCount === 1 ? "" : "S"} ATTACHED</div>}
                  </article>
                : item._tag === "thinking"
                  ? <details className={`thinking-trace ${item.live ? "live" : ""}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence} open={item.live ? true : undefined}>
                      <summary><span><Sparkles aria-hidden="true" />PI THINKING</span><small>{item.live ? "STREAMING" : "REASONING"}</small><strong aria-hidden="true"><ChevronRight /></strong></summary>
                      <div className="thinking-content"><LazyMarkdown text={item.text} /></div>
                    </details>
                : item._tag === "browser-image"
                  ? (() => {
                      const artifactUrl = `/api/sessions/${encodeURIComponent(selectedSession.id)}/artifacts/${encodeURIComponent(item.artifact.id)}`;
                      const label = (item.artifact.label ?? item.artifact.pageTitle) || "Browser screenshot";
                      return <figure className="browser-evidence" key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence}>
                        <header><span><Image aria-hidden="true" />BROWSER EVIDENCE</span><time dateTime={item.artifact.createdAt}>{new Date(item.artifact.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
                        <a className="browser-evidence-preview" href={artifactUrl} target="_blank" rel="noreferrer" aria-label={`Open full-resolution browser evidence: ${label}`}>
                          <img src={artifactUrl} loading="lazy" alt={label} width={item.artifact.width} height={item.artifact.height} />
                        </a>
                        <figcaption><div><b>{label}</b><span>{item.artifact.width} × {item.artifact.height} · {Math.ceil(item.artifact.byteCount / 1024).toLocaleString()} KB</span><small title={item.artifact.pageUrl}>{item.artifact.pageUrl}</small></div><a href={artifactUrl} download={`browser-evidence-${item.artifact.id}.png`}><ExternalLink aria-hidden="true" />DOWNLOAD</a></figcaption>
                      </figure>;
                    })()
                : item._tag === "browser-video"
                  ? (() => {
                      const artifactUrl = `/api/sessions/${encodeURIComponent(selectedSession.id)}/artifacts/${encodeURIComponent(item.artifact.id)}`;
                      const label = (item.artifact.label ?? item.artifact.pageTitle) || "Browser recording";
                      const seconds = Math.max(.1, item.artifact.durationMs / 1000).toLocaleString([], { maximumFractionDigits: 1 });
                      return <figure className="browser-evidence browser-video-evidence" key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence}>
                        <header><span><Video aria-hidden="true" />BROWSER RECORDING</span><time dateTime={item.artifact.createdAt}>{new Date(item.artifact.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
                        <div className="browser-video-frame">
                          <video src={artifactUrl} controls playsInline preload="metadata" aria-label={`Browser recording: ${label}`} />
                        </div>
                        <figcaption><div><b>{label}</b><span>{item.artifact.width} × {item.artifact.height} · {seconds}s · {Math.ceil(item.artifact.byteCount / 1024).toLocaleString()} KB</span><small title={item.artifact.pageUrl}>{item.artifact.pageUrl}</small></div><a href={artifactUrl} download={`browser-evidence-${item.artifact.id}.webm`}><ExternalLink aria-hidden="true" />DOWNLOAD</a></figcaption>
                      </figure>;
                    })()
                : item._tag === "status"
                  ? <div className={`timeline-status ${item.tone}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence} role="status">
                      <span>{item.tone === "running" ? <RefreshCw aria-hidden="true" /> : item.tone === "success" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</span>
                      <div><b>{item.label}</b><small>{item.detail}</small></div>
                    </div>
                : item._tag === "notice"
                  ? <article className={`extension-notice ${item.tone}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence} role={item.tone === "error" ? "alert" : "status"}>
                      <header><Bell aria-hidden="true" /><b>{item.tone === "error" ? "EXTENSION ERROR" : item.tone === "warning" ? "EXTENSION WARNING" : "PI NOTICE"}</b></header>
                      <pre>{item.text}</pre>
                    </article>
                : item.state === "running"
                  ? <div className={`tool-row ${item.error ? "error" : ""}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence}>
                      <i className="running" /><div><b>{item.name}</b><span>{compact(item.detail)}</span></div><small>running</small>
                    </div>
                  : (() => {
                      const output = item.outputRef ? toolOutputs[item.outputRef] : undefined;
                      const text = output?.status === "loaded" ? output.text ?? "" : item.detail;
                      return <details className={`tool-result ${item.error ? "error" : ""}`} key={item.key} data-timeline-key={item.key} data-timeline-sequence={item.sequence} onToggle={(event) => {
                        if (event.currentTarget.open && item.outputRef) requestToolOutput(selectedSession.id, item.outputRef);
                      }}>
                        <summary><i /><b>{item.name}</b><span>{compact(item.detail)}</span><small>{item.error ? "error" : "done"}</small><strong aria-hidden="true"><Plus /></strong></summary>
                        {item.outputRef && <div className={`tool-output-state ${output?.status ?? "preview"}`}><span>{output?.status === "loading" ? "Loading full output…" : output?.status === "failed" ? "Full output unavailable" : output?.status === "loaded" ? "Full output loaded" : "Preview · full output loads when expanded"}</span><small>{item.outputBytes?.toLocaleString() ?? "?"} bytes</small>{output?.status === "failed" && <button type="button" onClick={() => requestToolOutput(selectedSession.id, item.outputRef!, true)}>RETRY</button>}</div>}
                        <div className="tool-result-actions"><button className={`timeline-copy ${copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "copied" : "failed" : ""}`} onClick={() => void copyTimelineText(`tool:${item.key}`, `${item.name} tool output`, text)} type="button" aria-label={`${copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "Copied" : "Copy failed" : "Copy"} ${item.name} tool output`}><Copy aria-hidden="true" /><b>{copyFeedback?.key === `tool:${item.key}` ? copyFeedback.ok ? "COPIED" : "FAILED" : "COPY"}</b></button></div>
                        <pre data-keyboard-scroll tabIndex={0}>{output?.status === "loading" ? "Loading full output…" : output?.status === "failed" ? `${item.detail}\n\n[${output.error ?? "Full output could not be loaded"}]` : text}</pre>
                      </details>;
                    })())}
              {activeView === "changes" && <ReviewView state={reviewState?.sessionId === selectedSession.id ? reviewState : undefined} canComment={canWrite && !busy} onRefresh={() => void requestReview(selectedSession)} onSendComment={sendReviewComment} />}
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

          {activeView !== "changes" && <section className={`control-deck${selectedSession.workflow && workflowUsesFocusedLayout(selectedSession.workflow.phase) ? " workflow-focus-mode" : selectedSession.workflow && (workflowRunsAutonomously(selectedSession.workflow.phase) || selectedSession.workflow.phase === "failed") ? " workflow-monitor-mode" : ""}`}>
            {outbox.length > 0 && <section className="outbox-tray" data-keyboard-scroll tabIndex={0} aria-label="Outgoing messages" aria-live="polite">
              <header><span>OUTGOING QUEUE</span><b>{outbox.length.toString().padStart(2, "0")}</b></header>
              {outbox.map((item) => <article className={`outbox-message ${item.status}`} key={item.id}>
                <i /><div><header><b>{item.action === "followUp" ? "FOLLOW-UP" : item.action.toUpperCase()}</b><small>{item.status === "sending" ? "SENDING TO PI" : item.status === "queued" ? "QUEUED IN PI" : item.status === "delivered" ? "SENT TO PI" : item.error ?? "REJECTED"}</small></header><p>{item.text || `${item.imageCount ?? 0} attached image${item.imageCount === 1 ? "" : "s"}`}</p></div>
                {item.status === "rejected" && <button onClick={() => setOutbox((items) => items.filter((candidate) => candidate.id !== item.id))} type="button" aria-label="Dismiss rejected message"><X aria-hidden="true" /></button>}
              </article>)}
            </section>}
            {selectedSession.workflow && selectedSession.workflow.phase !== "accepted" && <EngineeringWorkflowPanel
              workflow={selectedSession.workflow}
              pending={workflowMutationPending?.sessionId === selectedSession.id && workflowMutationPending.phase === selectedSession.workflow.phase}
              onApprove={() => mutateCurrentWorkflow("approve")}
              onAccept={() => mutateCurrentWorkflow("accept")}
              onCancel={() => mutateCurrentWorkflow("cancel")}
              onContinue={continueWorkflow}
              onResume={openWorkflowResume}
              onRevise={openWorkflowRevision}
              onIntervene={openWorkflowIntervention}
              onContinueRepairs={openWorkflowContinuation}
              onReviewChanges={() => changeView("changes")}
            />}
            {!(selectedSession.workflow && workflowOwnsComposer(selectedSession.workflow.phase)) && <>
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
                  if (optionNavigationModifierRef.current) return;
                  if (suppressMentionSelectionRef.current) {
                    suppressMentionSelectionRef.current = false;
                    return;
                  }
                  scheduleSlashCommandSearch(event.currentTarget.value, event.currentTarget.selectionStart);
                  scheduleMentionSearch(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Control") {
                    optionNavigationModifierRef.current = true;
                    return;
                  }
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && event.shiftKey) {
                    event.preventDefault();
                    insertComposerNewline(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
                    return;
                  }
                  const currentMentionMenu = mentionMenuRef.current?.mentions.length
                    ? mentionMenuRef.current
                    : document.getElementById("file-mention-options") ? mentionOptionsRef.current : undefined;
                  const highlightedMention = currentMentionMenu?.mentions[currentMentionMenu.highlighted];
                  const navigationDirection = optionNavigationDirection(event);
                  if (currentMentionMenu && currentMentionMenu.mentions.length > 0 && navigationDirection !== undefined) {
                    event.preventDefault();
                    const highlighted = nextOptionIndex(currentMentionMenu.highlighted, currentMentionMenu.mentions.length, navigationDirection);
                    const nextMentionMenu = { ...currentMentionMenu, highlighted };
                    mentionMenuRef.current = nextMentionMenu;
                    setMentionMenu(nextMentionMenu);
                    scrollOptionIntoView(`file-mention-${highlighted}`);
                    return;
                  }
                  if (currentMentionMenu && highlightedMention && (event.key === "Enter" || event.key === "Tab" && !event.shiftKey)) { event.preventDefault(); chooseMention(highlightedMention); return; }
                  if (!window.matchMedia("(max-width: 760px)").matches && event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitCommand();
                  }
                }}
                onKeyUp={(event) => { if (event.key === "Control") optionNavigationModifierRef.current = false; }}
                onBlur={() => { optionNavigationModifierRef.current = false; }}
                placeholder={canWrite ? "Message Pi · / for commands · @ for files" : selectedSession && isWritableRuntime(selectedSession.status) && selectedSession.status !== "blocked" ? "Reconnecting to runtime…" : "This runtime is no longer writable"}
                rows={2}
              />
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
              <div className="composer-footer">
                <div className="composer-insertions">
                  <label className={`attachment-trigger ${busy || !canWrite ? "disabled" : ""}`} title="Attach images">
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={busy || !canWrite} onChange={(event) => { void selectImages(event.target.files ?? []); event.target.value = ""; }} aria-label="Attach images" />
                    <span aria-hidden="true">{imageSelectionPending ? <LoaderCircle className="icon-spin" /> : <Plus />}</span>
                  </label>
                  <ComposerActionMenu
                    disabled={busy || !canStartWorkflow}
                    onStartWorkflow={openWorkflowStarter}
                  />
                  <button className="mention-trigger" disabled={busy || !canWrite} onClick={insertMentionTrigger} type="button" aria-label="Mention a file" title="Mention a file"><AtSign aria-hidden="true" /></button>
                  {slashCommandMode && <span className="command-mode"><i aria-hidden="true">/</i> COMMAND · IMMEDIATE</span>}
                </div>
                <ComposerModelControls
                  key={selectedSession.id}
                  session={selectedSession}
                  disabled={busy || !canConfigure}
                  onApplied={(session) => {
                    acceptAuthoritativeSession(session);
                    void refresh(false);
                  }}
                  onError={setOperationError}
                />
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
                {(selectedSession.status === "stopped" || selectedSession.status === "crashed") && selectedSession.sessionFile && <button className="end-runtime" disabled={busy} onClick={() => void resumeSession()} type="button">{busy ? "RESUMING…" : "RESUME SESSION"}</button>}
              </div>
              <span className={`runtime-state ${displayStatus(selectedSession.status)}`}><i />{ATTENTION_STATE_LABELS[selectedSession.status]}</span>
              <span className="sr-only" aria-live="polite">{selectedSession.name} is {ATTENTION_STATE_LABELS[selectedSession.status]}</span>
            </div>
            </>}
          </section>}
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

      {interactiveRequest && selectedSession && runtimeIsCurrent && <InteractiveRequestDialog
        key={interactiveRequest.id}
        request={interactiveRequest}
        queuedCount={selectedSession.interactiveRequests.length - 1}
        pending={busy}
        returnFocus={composerTextareaRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onRespond={(response) => void answerInteractive(interactiveRequest, response)}
      />}

      {isMobile && mentionMenu && <DialogSurface
        key={`${mentionMenu.active.start}:${mentionMenu.active.end}`}
        className="mention-picker"
        backdropClassName="mention-picker-backdrop"
        viewportClassName="mention-picker-layer"
        initialFocus={mentionSearchInputRef}
        finalFocus={() => composerTextareaRef.current}
        onClose={() => { if (isMobileRef.current) closeMentionPicker(); }}
      >
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
                    if (event.nativeEvent.isComposing || remapOptionNavigationKey(event)) return;
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
      </DialogSurface>}

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

      {restartTarget && <RestartSessionDialog
        sessionName={restartTarget.name}
        pending={restartPending}
        error={restartError}
        returnFocus={restartReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => { if (!restartPending) setRestartTarget(undefined); }}
        onConfirm={() => void restartSessionRuntime()}
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

      {workflowDialog === "start" && selectedSession && <DialogSurface
        className="session-dialog workflow-dialog"
        pending={busy}
        returnFocus={workflowReturnFocusRef.current}
        fallbackFocus={composerTextareaRef.current}
        initialFocus={workflowObjectiveRef}
        onClose={() => setWorkflowDialog(undefined)}
        render={<form onSubmit={submitWorkflow} />}
      >
        <header><div><span>ENGINEERING WORKFLOW</span><Dialog.Title render={<b />}>Define, build, prove</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close workflow"><X aria-hidden="true" /></Dialog.Close></header>
        <div className="dialog-body workflow-dialog-body">
          <div className="workflow-intro"><i aria-hidden="true"><Workflow /></i><div><b>Complete approved scope, delivered in vertical slices</b><p>PISS uses an initial tracer to prove the path, then continues through the full delivery plan before whole-specification Verify and Review. It stops before commit, push, or deployment.</p></div></div>
          <label>Objective<textarea ref={workflowObjectiveRef} value={workflowObjective} onChange={(event) => setWorkflowObjective(event.target.value)} maxLength={64 * 1024} rows={6} placeholder="Describe the outcome, user, constraints, and what success looks like…" /></label>
          <label className="workflow-repair-limit">Repair budget<input type="number" inputMode="numeric" min={1} max={10} value={workflowRepairLimit} onChange={(event) => setWorkflowRepairLimit(event.target.value)} onBlur={() => setWorkflowRepairLimit(String(Math.max(1, Math.min(10, Number.parseInt(workflowRepairLimit, 10) || 1))))} /><small>Maximum autonomous repair cycles before PISS blocks for you.</small></label>
          {operationError && <div className="dialog-error" role="alert">{operationError}</div>}
        </div>
        <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch workflow-launch" disabled={busy || !workflowObjective.trim()} type="submit">{busy ? "STARTING…" : <>START DEFINE <Sparkles aria-hidden="true" /></>}</button></footer>
      </DialogSurface>}

      {workflowDialog === "revise" && selectedSession?.workflow && <DialogSurface
        className="session-dialog workflow-dialog"
        pending={busy}
        returnFocus={workflowReturnFocusRef.current}
        fallbackFocus={composerTextareaRef.current}
        initialFocus={workflowObjectiveRef}
        onClose={() => setWorkflowDialog(undefined)}
        render={<form onSubmit={submitWorkflowRevision} />}
      >
        <header><div><span>REQUEST CHANGES</span><Dialog.Title render={<b />}>Refine the {selectedSession.workflow.phase === "awaitingSpecApproval" ? "specification" : "plan"}</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close revision"><X aria-hidden="true" /></Dialog.Close></header>
        <div className="dialog-body workflow-dialog-body">
          <label>Feedback<textarea ref={workflowObjectiveRef} value={workflowFeedback} onChange={(event) => setWorkflowFeedback(event.target.value)} maxLength={64 * 1024} rows={6} placeholder="What should Pi reconsider, add, remove, or clarify?" /></label>
          {operationError && <div className="dialog-error" role="alert">{operationError}</div>}
        </div>
        <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch workflow-launch" disabled={busy || !workflowFeedback.trim()} type="submit">{busy ? "SENDING…" : <>SEND REVISION <ArrowRight aria-hidden="true" /></>}</button></footer>
      </DialogSurface>}

      {workflowDialog === "resume" && selectedSession?.workflow?.phase === "blocked" && <DialogSurface
        className="session-dialog workflow-dialog"
        pending={busy}
        returnFocus={workflowReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        initialFocus={workflowObjectiveRef}
        onClose={() => setWorkflowDialog(undefined)}
        render={<form onSubmit={submitWorkflowResume} />}
      >
        <header><div><span>WORKFLOW BLOCKED</span><Dialog.Title render={<b />}>Unblock {selectedSession.workflow.blockedFromPhase ? workflowPhaseLabel(selectedSession.workflow.blockedFromPhase) : "phase"}</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close blocked workflow dialog"><X aria-hidden="true" /></Dialog.Close></header>
        <div className="dialog-body workflow-dialog-body">
          <p className="workflow-intervention-note">Explain what changed or provide the authorization, approved procedure, decision, or non-sensitive evidence Pi requested. Do not paste credentials or secret values.</p>
          <label>Unblock guidance<textarea ref={workflowObjectiveRef} value={workflowFeedback} onChange={(event) => setWorkflowFeedback(event.target.value)} maxLength={64 * 1024} rows={7} placeholder="Provide the missing decision or approved procedure, and identify where Pi can verify it…" /></label>
          {selectedSession.workflow.executionAuthority ? <label className="workflow-scope-change"><input type="checkbox" checked={workflowScopeChange} onChange={(event) => setWorkflowScopeChange(event.target.checked)} /> <span><b>This requires revised scope or authority</b><small>Preserve prior evidence, return to planning, and require a new Approve & Run.</small></span></label> : null}
          {operationError && <div className="dialog-error" role="alert">{operationError}</div>}
        </div>
        <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch workflow-launch" disabled={busy || !workflowFeedback.trim()} type="submit">{busy ? "SENDING…" : workflowScopeChange ? <>RETURN TO PLAN <ArrowRight aria-hidden="true" /></> : <>RESUME WITH GUIDANCE <ArrowRight aria-hidden="true" /></>}</button></footer>
      </DialogSurface>}

      {workflowDialog === "intervene" && selectedSession?.workflow && <DialogSurface
        className="session-dialog workflow-dialog"
        pending={busy}
        returnFocus={workflowReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        initialFocus={workflowObjectiveRef}
        onClose={() => setWorkflowDialog(undefined)}
        render={<form onSubmit={submitWorkflowIntervention} />}
      >
        <>
          <header><div><span>USER GUIDANCE</span><Dialog.Title render={<b />}>Guide current workflow</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close guidance"><X aria-hidden="true" /></Dialog.Close></header>
          <div className="dialog-body workflow-dialog-body">
            <p className="workflow-intervention-note">PISS stores this guidance durably and delivers it exactly once at the next safe agent boundary. Scope-changing guidance returns the workflow to planning instead of silently widening approval.</p>
            <label>Guidance<textarea ref={workflowObjectiveRef} value={workflowFeedback} onChange={(event) => setWorkflowFeedback(event.target.value)} maxLength={64 * 1024} rows={6} placeholder="What should Pi adjust or keep in mind?" /></label>
            {selectedSession.workflow.executionAuthority ? <label className="workflow-scope-change"><input type="checkbox" checked={workflowScopeChange} onChange={(event) => setWorkflowScopeChange(event.target.checked)} /> <span><b>This changes approved scope or authority</b><small>Pause execution, preserve prior evidence, and return to planning for a new Approve & Run.</small></span></label> : null}
            {operationError && <div className="dialog-error" role="alert">{operationError}</div>}
          </div>
          <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch workflow-launch" disabled={busy || !workflowFeedback.trim()} type="submit">{busy ? "SENDING…" : <>SEND GUIDANCE <ArrowRight aria-hidden="true" /></>}</button></footer>
        </>
      </DialogSurface>}

      {workflowDialog === "continueRepairs" && selectedSession?.workflow?.phase === "failed" && <DialogSurface
        className="session-dialog workflow-dialog"
        pending={busy}
        returnFocus={workflowReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        initialFocus={workflowRepairInputRef}
        onClose={() => setWorkflowDialog(undefined)}
        render={<form onSubmit={submitWorkflowContinuation} />}
      >
        <header><div><span>REPAIR BUDGET EXHAUSTED</span><Dialog.Title render={<b />}>Continue the failed workflow</Dialog.Title></div><Dialog.Close disabled={busy} aria-label="Close repair continuation"><X aria-hidden="true" /></Dialog.Close></header>
        <div className="dialog-body workflow-dialog-body">
          <div className="workflow-intro"><i aria-hidden="true"><RefreshCw /></i><div><b>Resume from the blocking findings</b><p>The approved specification and plan stay in place. Pi returns to Repair, then reruns Verify and Review.</p></div></div>
          <p className="workflow-failure-summary"><b>LATEST FINDINGS</b>{compact(selectedSession.workflow.checkpoint?.summary ?? selectedSession.workflow.error ?? "Inspect the failed workflow before continuing.", 420)}</p>
          <label className="workflow-repair-limit">Additional repair attempts<input ref={workflowRepairInputRef} type="number" inputMode="numeric" min={1} max={10} value={workflowAdditionalRepairs} onChange={(event) => setWorkflowAdditionalRepairs(event.target.value)} onBlur={() => setWorkflowAdditionalRepairs(String(Math.max(1, Math.min(10, Number.parseInt(workflowAdditionalRepairs, 10) || 1))))} /><small>Explicitly extends this workflow’s cumulative budget; you can continue again if needed.</small></label>
          {operationError && <div className="dialog-error" role="alert">{operationError}</div>}
        </div>
        <footer><Dialog.Close className="cancel" disabled={busy}>CANCEL</Dialog.Close><button className="launch workflow-launch" disabled={busy} type="submit">{busy ? "RESUMING…" : <>CONTINUE REPAIRS <ArrowRight aria-hidden="true" /></>}</button></footer>
      </DialogSurface>}

      {compactionDialogOpen && selectedSession && <CompactionDialog
        returnFocus={compactionReturnFocusRef.current}
        fallbackFocus={sessionHeadingRef.current}
        onClose={() => setCompactionDialogOpen(false)}
        onConfirm={() => void compactNow()}
      />}

      {creatorOpen && state._tag === "Ready" && <DialogSurface className="session-dialog" size="content" pending={busy} returnFocus={creatorReturnFocusRef.current} fallbackFocus={sessionHeadingRef.current} initialFocus={newSessionInputRef} onClose={closeCreator} render={<form onSubmit={createSession} />}>
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
    </>
  );
}

const WORKFLOW_STAGES = ["DEFINE", "PLAN", "BUILD", "VERIFY", "REVIEW", "READY"] as const;

function workflowUsesFocusedLayout(phase: EngineeringWorkflow["phase"]): boolean {
  return phase === "defining" || phase === "planning" || phase === "awaitingSpecApproval" || phase === "awaitingPlanApproval" || phase === "blocked";
}

function workflowRunsAutonomously(phase: EngineeringWorkflow["phase"]): boolean {
  return phase === "defining" || phase === "planning" || phase === "building" || phase === "verifying" || phase === "reviewing" || phase === "repairing";
}

function workflowOwnsComposer(phase: EngineeringWorkflow["phase"]): boolean {
  return !isTerminalWorkflowPhase(phase);
}

function workflowActivityLabel(phase: EngineeringWorkflow["phase"]): string {
  switch (phase) {
    case "planning": return "Pi is preparing the complete delivery plan";
    case "building": return "Pi is implementing the approved delivery plan";
    case "verifying": return "Pi is verifying the implementation";
    case "reviewing": return "Pi is reviewing the verified changes";
    case "repairing": return "Pi is repairing the blocking findings";
    default: return "Pi owns the current phase";
  }
}

function workflowStageIndex(workflow: EngineeringWorkflow): number {
  const phase = workflow.phase === "blocked" && workflow.blockedFromPhase ? workflow.blockedFromPhase : workflow.phase;
  if (phase === "failed" && workflow.checkpoint) {
    if (workflow.checkpoint.stage === "define") return 0;
    if (workflow.checkpoint.stage === "plan") return 1;
    if (workflow.checkpoint.stage === "build") return 2;
    if (workflow.checkpoint.stage === "verify") return 3;
    return 4;
  }
  if (phase === "defining" || phase === "awaitingSpecApproval") return 0;
  if (phase === "planning" || phase === "awaitingPlanApproval") return 1;
  if (phase === "building" || phase === "repairing") return 2;
  if (phase === "verifying") return 3;
  if (phase === "reviewing") return 4;
  if (phase === "readyToShip" || phase === "accepted") return 5;
  return -1;
}

function workflowWasInterrupted(workflow: EngineeringWorkflow): boolean {
  return workflow.phase === "cancelled" && Boolean(workflow.error?.includes("runtime stopped"));
}

function workflowBlockerProblem(workflow: EngineeringWorkflow): string {
  if (workflowWasInterrupted(workflow)) return "The Pi runtime stopped before the workflow finished. Its approved specification and plan are still preserved.";
  const advice = workflow.supervisor?.lastAdvice;
  if (advice?.problem?.trim()) return advice.problem.trim();
  if (advice?.action === "human_authority_required") return "The workflow needs your permission before it can continue.";
  if (advice?.action === "unsafe_stop") return "Continuing may break an approved safety or data-integrity rule.";
  return workflow.checkpoint?.summary ?? workflow.error ?? "The workflow needs your decision before it can continue.";
}

function EngineeringWorkflowPanel({ workflow, pending, onApprove, onAccept, onCancel, onContinue, onResume, onRevise, onIntervene, onContinueRepairs, onReviewChanges }: {
  readonly workflow: EngineeringWorkflow;
  readonly pending: boolean;
  readonly onApprove: () => void;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
  readonly onResume: (returnFocus: HTMLElement) => void;
  readonly onRevise: (returnFocus: HTMLElement) => void;
  readonly onIntervene: (returnFocus: HTMLElement) => void;
  readonly onContinueRepairs: (returnFocus: HTMLElement) => void;
  readonly onReviewChanges: () => void;
}) {
  const activeStage = workflowStageIndex(workflow);
  const approval = workflow.phase === "awaitingSpecApproval" || workflow.phase === "awaitingPlanApproval";
  const terminal = isTerminalWorkflowPhase(workflow.phase);
  const interrupted = workflowWasInterrupted(workflow);
  const blockerCanContinue = workflow.supervisor?.lastAdvice?.action !== "unsafe_stop"
    && workflow.supervisor?.lastAdvice?.action !== "human_authority_required";
  const phaseSummary = workflow.checkpoint?.summary ?? workflow.objective;
  const phaseReport = workflow.error ?? phaseSummary;
  const dossier = workflow.dossier;
  const progress = workflow.progress;
  const totalSlices = dossier?.slices.length ?? 0;
  const totalCriteria = dossier?.criteria.length ?? 0;
  const guidance = workflow.guidance ?? [];
  const dossierSliceIds = new Set(dossier?.slices.map((item) => item.id) ?? []);
  const dossierCriterionIds = new Set(dossier?.criteria.map((item) => item.id) ?? []);
  const completedSlices = progress?.completedSliceIds.filter((id) => dossierSliceIds.has(id)).length ?? 0;
  const passedCriterionIds = new Set(progress?.passedCriterionIds.filter((id) => dossierCriterionIds.has(id)) ?? []);
  const evidenceByCriterion = new Map((progress?.evidence ?? []).filter((item) => dossierCriterionIds.has(item.criterionId)).map((item) => [item.criterionId, item]));
  const passedCriteria = [...passedCriterionIds].filter((id) => evidenceByCriterion.has(id)).length;
  const remainingCriteria = dossier?.criteria.filter((item) => !passedCriterionIds.has(item.id) || !evidenceByCriterion.has(item.id)) ?? [];
  const queuedGuidance = guidance.filter((item) => item.status === "queued").length;
  const deliveredGuidance = guidance.filter((item) => item.status === "delivered").length;
  const appliedGuidance = guidance.filter((item) => item.status === "applied").length;
  const hasLongPhaseReport = (workflowRunsAutonomously(workflow.phase) || workflow.phase === "failed") && phaseReport.length > 600;
  const artifactLabel = workflow.phase === "awaitingSpecApproval"
    ? "SPECIFICATION"
    : workflow.phase === "awaitingPlanApproval"
      ? "DELIVERY PLAN"
      : workflow.checkpoint?.stage === "define"
        ? "APPROVED SPECIFICATION"
        : workflow.checkpoint?.stage === "plan"
          ? "APPROVED DELIVERY PLAN"
          : "LATEST CHECKPOINT";

  return <section className={`engineering-workflow ${workflow.phase}`} aria-label="Engineering workflow" aria-live="polite">
    <header>
      <div className="workflow-identity"><i aria-hidden="true"><Workflow /></i><span><small>ENGINEERING WORKFLOW</small><b>{workflowPhaseLabel(workflow.phase)}</b></span></div>
      <em>{workflow.repairAttempts}/{workflow.maxRepairAttempts} REPAIRS</em>
    </header>
    <ol className="workflow-stage-rail" aria-label="Workflow progress">
      {WORKFLOW_STAGES.map((stage, index) => <li className={index < activeStage ? "complete" : index === activeStage ? "active" : "pending"} key={stage}><i>{index < activeStage ? <Check aria-hidden="true" /> : index + 1}</i><span>{stage}</span></li>)}
    </ol>
    {progress && <section className="workflow-progress-summary" aria-label="Durable workflow progress">
      <div className="workflow-current-activity"><small>{progress.condition.replaceAll("_", " ").toUpperCase()}</small><b>{progress.activity}</b><span>{progress.nextAction}</span></div>
      <dl>
        <div><dt>SLICES</dt><dd>{completedSlices}/{totalSlices || "—"}</dd></div>
        <div><dt>CRITERIA</dt><dd>{passedCriteria}/{totalCriteria || "—"}</dd></div>
        <div><dt>REPAIR</dt><dd>{workflow.repairAttempts}/{workflow.maxRepairAttempts}</dd></div>
        <div><dt>GUIDANCE</dt><dd>{queuedGuidance}Q · {deliveredGuidance}D · {appliedGuidance}A</dd></div>
      </dl>
      {(progress.currentSliceId || progress.verificationStep || progress.reviewStep) && <p><b>{progress.currentSliceId ? `Slice ${progress.currentSliceId}` : workflowPhaseLabel(workflow.phase)}</b><span>{progress.verificationStep ?? progress.reviewStep ?? "In progress"}</span></p>}
      <div className="workflow-run-meta">
        <span><small>PHASE RUN</small><code title={workflow.phaseRun?.id ?? "No active phase run"}>{workflow.phaseRun?.id ?? "—"}</code></span>
        <span><small>ATTEMPT</small><b>{workflow.phaseRun?.attempt ?? 0}</b></span>
        <span><small>TRANSIENT RETRY</small><b>{progress.retryAttempt}/{progress.maxTransientRetries}</b></span>
        <span><small>REMAINING</small><b>{remainingCriteria.length} criteria · {Math.max(0, workflow.maxRepairAttempts - workflow.repairAttempts)} repairs</b></span>
      </div>
      <time dateTime={progress.lastActivityAt}>Updated {relativeTime(progress.lastActivityAt)} ago</time>
    </section>}
    {workflow.openQuestions?.length ? <section className="workflow-open-questions" aria-label="Open planning questions">
      <small>INPUT NEEDED</small>
      <ul>{workflow.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
    </section> : null}
    <div className="workflow-copy">
      {workflow.phase === "blocked" || interrupted ? <>
        <div className="workflow-blocker" role="alert">
          <small>WHAT’S STOPPING IT</small>
          <p>{workflowBlockerProblem(workflow)}</p>
          <b>{interrupted
            ? "Resume the workflow from its preserved state?"
            : blockerCanContinue
              ? "Would you like the workflow to continue?"
              : workflow.supervisor?.lastAdvice?.action === "human_authority_required"
                ? "Provide the exact non-secret input requested, or revise scope and return to planning."
                : "Give feedback if the approved scope or safety constraints should be reconsidered."}</b>
        </div>
        {workflow.supervisor?.lastAdvice && <details className="workflow-blocker-details">
          <summary><ClipboardCheck aria-hidden="true" /> TECHNICAL DETAILS<ChevronRight aria-hidden="true" /></summary>
          <div><p>{workflow.supervisor.lastAdvice.summary}</p><small>BASIS</small><p>{workflow.supervisor.lastAdvice.basis}</p></div>
        </details>}
      </> : <>
        <p>{phaseSummary}</p>
        {workflow.phase === "awaitingPlanApproval" && <p className="workflow-autonomy-note"><b>FINAL APPROVAL · PLAN REVISION {workflow.dossier?.revision ?? workflow.artifactRevision ?? 0}</b> Approving this specification and plan authorizes PISS to execute every listed operation unattended. Review the autonomy envelope now; the loop will not ask you to reconfirm approved work.</p>}
        {hasLongPhaseReport && <details className="workflow-report-details">
          <summary><ClipboardCheck aria-hidden="true" /> FULL PHASE REPORT<ChevronRight aria-hidden="true" /></summary>
          <div className="workflow-report" data-keyboard-scroll tabIndex={0}><Markdown remarkPlugins={[remarkGfm]}>{phaseReport}</Markdown></div>
        </details>}
        {workflow.error && workflow.error !== phaseSummary && !hasLongPhaseReport && <strong role="alert">{workflow.error}</strong>}
        {workflow.specification && <details><summary><ClipboardCheck aria-hidden="true" /> COMPLETE SPECIFICATION<ChevronRight aria-hidden="true" /></summary><div className="workflow-artifact"><Markdown remarkPlugins={[remarkGfm]}>{workflow.specification}</Markdown></div></details>}
        {workflow.plan && <details><summary><ClipboardCheck aria-hidden="true" /> EXECUTABLE PLAN & AUTONOMY ENVELOPE<ChevronRight aria-hidden="true" /></summary><div className="workflow-artifact"><Markdown remarkPlugins={[remarkGfm]}>{workflow.plan}</Markdown></div></details>}
        {workflow.phase !== "awaitingPlanApproval" && workflow.checkpoint?.artifact && workflow.checkpoint.artifact !== workflow.specification && workflow.checkpoint.artifact !== workflow.plan && <details key={`${workflow.id}:${workflow.phase}`}><summary><ClipboardCheck aria-hidden="true" /> {artifactLabel}<ChevronRight aria-hidden="true" /></summary><div className="workflow-artifact"><Markdown remarkPlugins={[remarkGfm]}>{workflow.checkpoint.artifact}</Markdown></div></details>}
        {dossier && <details><summary><ClipboardCheck aria-hidden="true" /> CRITERIA & EVIDENCE · {passedCriteria}/{totalCriteria}<ChevronRight aria-hidden="true" /></summary><div className="workflow-detail-list">{dossier.criteria.map((criterion) => { const evidence = evidenceByCriterion.get(criterion.id); const passed = passedCriterionIds.has(criterion.id) && Boolean(evidence); return <p key={criterion.id}><b>{passed ? "PASSED" : "REMAINING"} · {criterion.id}</b><span>{criterion.title}</span>{evidence && <small>{evidence.summary}{evidence.eventSequence !== undefined ? ` · event ${evidence.eventSequence}` : ""}</small>}</p>; })}</div></details>}
        {dossier && <details><summary><ClipboardCheck aria-hidden="true" /> STRUCTURED APPROVAL DOSSIER<ChevronRight aria-hidden="true" /></summary><div className="workflow-detail-list">
          <p><b>ORDERED DELIVERY SLICES</b><span>{dossier.slices.map((slice) => `${slice.id}: ${slice.title}${slice.dependencies.length ? ` (after ${slice.dependencies.join(", ")})` : ""}`).join(" · ")}</span></p>
          <p><b>VERIFICATION & REVIEW</b><span>{dossier.verificationRequirements.join(" · ") || "None recorded"}</span></p>
          {dossier.operations.map((operation) => <p key={operation.id}><b>{operation.kind.replaceAll("_", " ").toUpperCase()} · {operation.id}</b><span>{operation.target}{operation.constraints?.length ? ` · ${operation.constraints.join(" · ")}` : ""}</span><small>{operation.idempotencyKey ? `Receipt required · Idempotency key: ${operation.idempotencyKey} · ` : ""}Recovery: {operation.recovery} · Evidence: {operation.evidence}</small></p>)}
          <p><b>RECOVERY REQUIREMENTS</b><span>{dossier.recoveryRequirements.join(" · ") || "None recorded"}</span></p>
          <p><b>OUTSIDE THE ENVELOPE</b><span>{dossier.exclusions.join(" · ") || "None recorded"}</span></p>
          <p><b>READINESS</b><span>{dossier.readiness.map((item) => `${item.status.toUpperCase()} · ${item.label}: ${item.detail}`).join(" · ") || "No separate readiness checks recorded"}</span></p>
          <p><b>UNRESOLVED CAPABILITIES OR APPROVALS</b><span>{dossier.unresolved.join(" · ") || "None"}</span></p>
        </div></details>}
        {guidance.length > 0 && <details><summary><MessageSquare aria-hidden="true" /> GUIDANCE LOG · {guidance.length}<ChevronRight aria-hidden="true" /></summary><div className="workflow-detail-list">{guidance.map((item) => <p key={item.id}><b>{item.status.toUpperCase()} · {item.id}</b><span>{item.text}</span><small>Plan {item.planRevision} · command {item.commandId}</small></p>)}</div></details>}
        {(workflow.operationReceipts?.length ?? 0) > 0 && <details><summary><ClipboardCheck aria-hidden="true" /> OPERATION RECEIPTS · {workflow.operationReceipts?.length}<ChevronRight aria-hidden="true" /></summary><div className="workflow-detail-list">{workflow.operationReceipts?.map((receipt) => <p key={receipt.idempotencyKey}><b>{receipt.status.replaceAll("_", " ").toUpperCase()} · {receipt.operationId}</b><span>{receipt.target}</span><small>Idempotency key {receipt.idempotencyKey}{receipt.evidence ? ` · ${receipt.evidence}` : ""}</small></p>)}</div></details>}
        {workflow.authorityDecisions && workflow.authorityDecisions.length > 0 && <details><summary><ClipboardCheck aria-hidden="true" /> AUTHORITY DECISIONS · {workflow.authorityDecisions.length}<ChevronRight aria-hidden="true" /></summary><div className="workflow-authority-log">{workflow.authorityDecisions.map((decision) => <p key={decision.eventId}><b>{decision.allowed ? "ALLOWED" : "BLOCKED"} · {decision.operationId}</b><span>{decision.basis}</span>{decision.correlationId && <small>Source {decision.source ?? "workflow authority"} · correlation {decision.correlationId}{decision.runtimeId ? ` · runtime ${decision.runtimeId}` : ""}{decision.idempotencyKey ? ` · idempotency ${decision.idempotencyKey}` : ""}</small>}</p>)}</div></details>}
      </>}
    </div>
    <footer>
      {approval && <>
        <button className="workflow-revise" disabled={pending} type="button" onClick={(event) => onRevise(event.currentTarget)}>REQUEST CHANGES</button>
        <button className="workflow-approve" disabled={pending} type="button" onClick={onApprove}><Check aria-hidden="true" />{workflow.phase === "awaitingSpecApproval" ? "CONTINUE TO PLAN" : "APPROVE & RUN"}</button>
      </>}
      {workflow.phase === "blocked" && workflow.supervisor?.status === "consulting" && <>
        <span className="workflow-activity" role="status"><LoaderCircle className="icon-spin" aria-hidden="true" />Loop supervisor is reviewing this blocker</span>
        <button className="workflow-intervene" disabled={pending || !workflow.blockedFromPhase} type="button" onClick={(event) => onIntervene(event.currentTarget)}><MessageSquare aria-hidden="true" />GUIDE CURRENT WORKFLOW</button>
      </>}
      {interrupted && <button className="workflow-approve" disabled={pending} type="button" onClick={onContinue}><RefreshCw aria-hidden="true" />RESUME WORKFLOW</button>}
      {workflow.phase === "blocked" && workflow.supervisor?.status !== "consulting" && <>
        {blockerCanContinue && <button className="workflow-approve" disabled={pending || !workflow.blockedFromPhase} type="button" onClick={onContinue}><ArrowRight aria-hidden="true" />CONTINUE</button>}
        <button className="workflow-revise" disabled={pending || !workflow.blockedFromPhase} type="button" onClick={(event) => onResume(event.currentTarget)}><MessageSquare aria-hidden="true" />GIVE FEEDBACK</button>
      </>}
      {workflow.phase === "readyToShip" && <>
        <button className="workflow-revise" disabled={pending} type="button" onClick={onReviewChanges}><FileDiff aria-hidden="true" />REVIEW CHANGES</button>
        <button className="workflow-approve" disabled={pending} type="button" onClick={onAccept}><Check aria-hidden="true" />{pending ? "ACCEPTING…" : "ACCEPT RESULT"}</button>
      </>}
      {workflow.phase === "accepted" && <span className="workflow-accepted"><CheckCheck aria-hidden="true" />Result accepted · changes remain uncommitted</span>}
      {workflow.phase === "failed" && <>
        <span className="workflow-failed-next">Blocking findings remain · extend the repair budget to continue.</span>
        <button className="workflow-revise" disabled={pending} type="button" onClick={onReviewChanges}><FileDiff aria-hidden="true" />REVIEW CHANGES</button>
        <button className="workflow-continue" disabled={pending} type="button" onClick={(event) => onContinueRepairs(event.currentTarget)}><RefreshCw aria-hidden="true" />CONTINUE REPAIRS</button>
      </>}
      {!terminal && !approval && workflow.phase !== "blocked" && <span className="workflow-activity" role="status"><LoaderCircle className="icon-spin" aria-hidden="true" />{workflowActivityLabel(workflow.phase)}</span>}
      {(workflow.phase === "defining" || workflow.phase === "planning" || workflow.phase === "building" || workflow.phase === "repairing" || workflow.phase === "verifying" || workflow.phase === "reviewing") && <button className="workflow-intervene" disabled={pending} type="button" onClick={(event) => onIntervene(event.currentTarget)}><MessageSquare aria-hidden="true" />{queuedGuidance > 0 ? `${queuedGuidance} GUIDANCE QUEUED` : "GUIDE CURRENT WORKFLOW"}</button>}
      {!terminal && <button className="workflow-cancel" disabled={pending} type="button" onClick={onCancel}>CANCEL WORKFLOW</button>}
    </footer>
  </section>;
}

function ComposerActionMenu({ disabled, onStartWorkflow }: {
  readonly disabled: boolean;
  readonly onStartWorkflow: (returnFocus: HTMLElement) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <BaseMenu.Root>
    <BaseMenu.Trigger className="composer-action-trigger" ref={trigger} disabled={disabled} aria-label="Open workflow actions" title="Workflow actions"><Workflow aria-hidden="true" /></BaseMenu.Trigger>
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="composer-action-positioner" side="top" align="start" sideOffset={8} alignOffset={({ anchor }) => -(anchor.width + 8)} collisionPadding={8} positionMethod="fixed">
        <BaseMenu.Popup className="composer-action-menu" aria-label="PISS workflows" aria-labelledby="" onKeyDown={remapOptionNavigationKey}>
          <header><b>PISS workflows</b></header>
          <BaseMenu.Item nativeButton render={<button type="button" />} onClick={() => { if (trigger.current) onStartWorkflow(trigger.current); }}>
            <i aria-hidden="true"><Workflow /></i><span><b>ENGINEERING LOOP</b><small>Define together · build, verify, repair</small></span><ArrowRight aria-hidden="true" />
          </BaseMenu.Item>
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
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
        <BaseMenu.Popup className="workspace-menu" aria-label={menuLabel} aria-labelledby="" onKeyDown={remapOptionNavigationKey}>
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

function RestartSessionDialog({ sessionName, pending, error, returnFocus, fallbackFocus, onClose, onConfirm }: {
  readonly sessionName: string;
  readonly pending: boolean;
  readonly error?: string;
  readonly returnFocus: HTMLElement | null;
  readonly fallbackFocus: HTMLElement | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return <AlertDialogSurface className="session-dialog stop-session-dialog" pending={pending} returnFocus={returnFocus} fallbackFocus={fallbackFocus} initialFocus={cancelRef} onClose={onClose}>
    <header><div><AlertDialog.Title render={<b />}>Restart Pi runtime?</AlertDialog.Title></div><AlertDialog.Close disabled={pending} aria-label="Close"><X aria-hidden="true" /></AlertDialog.Close></header>
    <div className="dialog-body">
      <AlertDialog.Description render={<p />}>PISS will stop only <b>{sessionName}</b>, then start a fresh Pi process from the same saved conversation. The session, transcript, and engineering workflow remain in place.</AlertDialog.Description>
      <p>Any response or interactive request currently in progress will be interrupted. Use this to reload Pi configuration, MCP servers, extensions, or environment changes.</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </div>
    <footer><AlertDialog.Close className="cancel" ref={cancelRef} disabled={pending}>CANCEL</AlertDialog.Close><button className="launch" onClick={onConfirm} disabled={pending} type="button">{pending ? "RESTARTING…" : "RESTART PI RUNTIME"}</button></footer>
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
      {request.message && <Dialog.Description className="interactive-message" data-keyboard-scroll>{request.message}</Dialog.Description>}
      {queuedCount > 0 && <p className="interactive-queue">{queuedCount} more request{queuedCount === 1 ? " is" : "s are"} queued</p>}
      {request.timeout && <p className="interactive-timeout">This request expires automatically after {Math.ceil(request.timeout / 1000)} seconds.</p>}
      {request.method === "select" && <label>Choose one<select value={value} disabled={pending} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
          const direction = keyboardScrollDirection(event);
          const options = request.options ?? [];
          if (direction === undefined || options.length === 0) return;
          event.preventDefault();
          const current = Math.max(0, options.indexOf(value));
          setValue(options[nextOptionIndex(current, options.length, direction)] ?? options[0]!);
        }}>{request.options?.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>}
      {request.method === "input" && <label>Response<input value={value} disabled={pending} maxLength={256 * 1024} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submitValue(); } }} /></label>}
      {request.method === "editor" && <label>Response<textarea value={value} disabled={pending} maxLength={256 * 1024} placeholder={request.placeholder} rows={9} onChange={(event) => setValue(event.target.value)} /></label>}
      {request.method === "confirm" && <div className="interactive-confirm" role="group" aria-label="Confirmation response"><button disabled={pending} type="button" onClick={() => onRespond({ confirmed: false })}>NO</button><button disabled={pending} type="button" onClick={() => onRespond({ confirmed: true })}>YES</button></div>}
    </div>
    <footer><Dialog.Close className="cancel" disabled={pending}>CANCEL</Dialog.Close>{request.method !== "confirm" && <button className="launch" disabled={pending || request.method === "select" && !value} onClick={submitValue} type="button">{pending ? "ANSWERING…" : "SUBMIT"}</button>}</footer>
  </DialogSurface>;
}

function ComposerModelControls({ session, disabled, onApplied, onError }: {
  readonly session: OwnedSession;
  readonly disabled: boolean;
  readonly onApplied: (session: OwnedSession) => void;
  readonly onError: (message: string) => void;
}) {
  const [models, setModels] = useState<ReadonlyArray<AvailableModel>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState(false);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setModels([]);
    setLoadError(undefined);
    try {
      const result = await Effect.runPromise(loadAvailableModels(session.id, session.runtimeId));
      setModels(result.models.toSorted(newestModelsFirst));
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [session.id, session.runtimeId]);

  const applyModel = async (model: AvailableModel) => {
    if (pending || disabled || session.model?.provider === model.provider && session.model.id === model.id) return;
    setPending(true);
    try {
      const result = await Effect.runPromise(setSessionModel({ sessionId: session.id, runtimeId: session.runtimeId, provider: model.provider, modelId: model.id }));
      onApplied(result.session);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const applyThinkingLevel = async (level: ThinkingLevel) => {
    if (pending || disabled || session.thinkingLevel === level) return;
    setPending(true);
    try {
      const result = await Effect.runPromise(setSessionThinkingLevel({ sessionId: session.id, runtimeId: session.runtimeId, level }));
      onApplied(result.session);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const currentModelKey = session.model ? `${session.model.provider}\0${session.model.id}` : "";
  const thinkingLevels = session.model?.thinkingLevels ?? [];
  const controlsDisabled = disabled || pending;
  const unavailableTitle = "Model changes are available when Pi is idle";

  return <div className="composer-config" role="group" aria-label="Model configuration">
    <BaseMenu.Root disabled={controlsDisabled} onOpenChange={(open) => {
      if (open && models.length === 0 && !loading && !loadError) void loadModels();
    }}>
      <BaseMenu.Trigger
        className="composer-config-trigger model"
        type="button"
        disabled={controlsDisabled}
        aria-label={`Model: ${session.model?.name ?? "not selected"}`}
        title={disabled ? unavailableTitle : session.model ? `${session.model.provider} / ${session.model.id}` : "Choose a model"}
      >
        <span><small>MODEL</small><b>{session.model?.name ?? "Choose"}</b></span><ChevronDown aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="composer-model-positioner" side="top" align="end" sideOffset={6} collisionPadding={8} positionMethod="fixed">
          <BaseMenu.Popup className="composer-config-menu model-menu" aria-label="Model options" aria-labelledby="" onKeyDown={remapOptionNavigationKey}>
            <header><span>AVAILABLE MODELS</span><small>{models.length || "—"}</small></header>
            {loading && <div className="composer-config-state" role="status"><LoaderCircle className="icon-spin" aria-hidden="true" /> Loading models…</div>}
            {!loading && loadError && <button className="composer-config-state error" type="button" onClick={() => void loadModels()}>Could not load models · Retry</button>}
            {!loading && !loadError && models.length === 0 && <div className="composer-config-state">No models available.</div>}
            {!loading && models.length > 0 && <BaseMenu.RadioGroup value={currentModelKey} onValueChange={(key) => {
              const model = models.find((candidate) => `${candidate.provider}\0${candidate.id}` === key);
              if (model) void applyModel(model);
            }}>
              {models.map((model) => <BaseMenu.RadioItem
                className="composer-model-option"
                key={`${model.provider}/${model.id}`}
                value={`${model.provider}\0${model.id}`}
                disabled={pending}
                closeOnClick
                nativeButton
                render={<button type="button" />}
              >
                <BaseMenu.RadioItemIndicator className="composer-option-check" keepMounted><Check aria-hidden="true" /></BaseMenu.RadioItemIndicator>
                <span><b>{model.name}</b><small>{model.provider} / {model.id}</small></span>
                <em>{model.reasoning ? "THINKING" : "DIRECT"}</em>
              </BaseMenu.RadioItem>)}
            </BaseMenu.RadioGroup>}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>

    <BaseMenu.Root disabled={controlsDisabled || thinkingLevels.length === 0}>
      <BaseMenu.Trigger
        className="composer-config-trigger thinking"
        type="button"
        disabled={controlsDisabled || thinkingLevels.length === 0}
        aria-label={`Thinking: ${session.thinkingLevel ?? "off"}`}
        title={disabled ? unavailableTitle : "Choose a thinking level"}
      >
        <span><small>THINKING</small><b>{session.thinkingLevel ?? "off"}</b></span><ChevronDown aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="composer-thinking-positioner" side="top" align="end" sideOffset={6} collisionPadding={8} positionMethod="fixed">
          <BaseMenu.Popup className="composer-config-menu thinking-menu" aria-label="Thinking options" aria-labelledby="" onKeyDown={remapOptionNavigationKey}>
            <header><span>THINKING LEVEL</span><small>{session.model?.reasoning ? "REASONING" : "DIRECT"}</small></header>
            <BaseMenu.RadioGroup value={session.thinkingLevel ?? "off"} onValueChange={(level) => void applyThinkingLevel(level as ThinkingLevel)}>
              {thinkingLevels.map((level) => <BaseMenu.RadioItem
                className="composer-thinking-option"
                key={level}
                value={level}
                disabled={pending}
                closeOnClick
                nativeButton
                render={<button type="button" />}
              >
                <BaseMenu.RadioItemIndicator className="composer-option-check" keepMounted><Check aria-hidden="true" /></BaseMenu.RadioItemIndicator>
                <span>{level}</span>
              </BaseMenu.RadioItem>)}
            </BaseMenu.RadioGroup>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  </div>;
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
  const [highlighted, setHighlighted] = useState(0);
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
        ({ candidates: next }) => { if (!cancelled) { setCandidates(next); setHighlighted(0); setSearching(false); setError(undefined); } },
        (cause) => { if (!cancelled) { setCandidates([]); setHighlighted(0); setSearching(false); setError(errorMessage(cause)); } },
      );
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  const choose = (candidate: DirectoryCandidate) => {
    setSelected(candidate);
    setHighlighted(Math.max(0, candidates.indexOf(candidate)));
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
          <button className={mode === "existing" ? "active" : ""} onClick={() => { setMode("existing"); setSelected(undefined); setHighlighted(0); setQuery(""); }} type="button" aria-pressed={mode === "existing"}>EXISTING DIRECTORY</button>
          <button className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setSelected(undefined); setHighlighted(0); setQuery(""); }} type="button" aria-pressed={mode === "create"}>CREATE FOLDER</button>
        </div>
        <label>{mode === "create" ? "Parent directory" : "Directory"}
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(undefined); setHighlighted(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || candidates.length === 0) return;
              const direction = optionNavigationDirection(event);
              if (direction !== undefined) {
                event.preventDefault();
                const next = nextOptionIndex(highlighted, candidates.length, direction);
                setHighlighted(next);
                scrollOptionIntoView(`directory-option-${next}`);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(candidates[highlighted] ?? candidates[0]!);
              }
            }}
            aria-activedescendant={candidates.length > 0 ? `directory-option-${highlighted}` : undefined}
            placeholder="Fuzzy search approved directories…"
            autoComplete="off"
          />
        </label>
        <div className="directory-results" data-keyboard-scroll role="listbox" aria-label="Matching directories" aria-busy={searching}>
          {searching && <div className="directory-state" role="status">Searching directories…</div>}
          {!searching && candidates.length === 0 && <div className="directory-state" role="status">No matching directories inside the approved roots.</div>}
          {!searching && candidates.map((candidate, index) => <button
            className={`${selected?.path === candidate.path ? "selected" : ""} ${highlighted === index ? "highlighted" : ""}`}
            id={`directory-option-${index}`}
            key={candidate.path}
            onClick={() => choose(candidate)}
            onFocus={() => setHighlighted(index)}
            onPointerMove={() => setHighlighted(index)}
            role="option"
            aria-selected={selected?.path === candidate.path}
            type="button"
          >
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
