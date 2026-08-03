import * as Schema from "effect/Schema";
import { BrowserArtifactCreatedData, type OwnedSessionEvent, type SessionArtifact } from "../../shared/domain.ts";

export type TimelineItem =
  | { readonly _tag: "message"; readonly key: string; readonly sequence: number; readonly role: "user" | "assistant"; readonly text: string; readonly imageCount: number; readonly live?: boolean }
  | { readonly _tag: "thinking"; readonly key: string; readonly sequence: number; readonly text: string; readonly live?: boolean }
  | { readonly _tag: "browser-image"; readonly key: string; readonly sequence: number; readonly artifact: Extract<SessionArtifact, { readonly kind: "browser-screenshot" }> }
  | { readonly _tag: "browser-video"; readonly key: string; readonly sequence: number; readonly artifact: Extract<SessionArtifact, { readonly kind: "browser-video" }> }
  | { readonly _tag: "tool"; readonly key: string; readonly sequence: number; readonly name: string; readonly detail: string; readonly error: boolean; readonly state: "running" | "done"; readonly outputRef?: string; readonly outputBytes?: number; readonly outputTruncated?: boolean }
  | { readonly _tag: "status"; readonly key: string; readonly sequence: number; readonly label: string; readonly detail: string; readonly tone: "running" | "success" | "error" }
  | { readonly _tag: "notice"; readonly key: string; readonly sequence: number; readonly text: string; readonly tone: "info" | "warning" | "error" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const decodeBrowserArtifactCreated = Schema.decodeUnknownSync(BrowserArtifactCreatedData);

function browserArtifact(data: Record<string, unknown> | undefined): SessionArtifact | undefined {
  try { return decodeBrowserArtifactCreated(data).artifact; }
  catch { return; }
}

function messageImages(message: unknown): number {
  const content = record(message)?.content;
  return Array.isArray(content) ? content.filter((part) => record(part)?.type === "image").length : 0;
}

function messageText(message: unknown): string {
  const value = record(message);
  const content = value?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function messageThinking(message: unknown): string {
  const content = record(message)?.content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === "thinking" && typeof item.thinking === "string" ? [item.thinking] : [];
  }).join("\n\n");
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = record(value)?.content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("\n");
    if (text) return text;
  }
  if (value !== undefined) {
    try { return JSON.stringify(value, null, 2); } catch { return "Activity update"; }
  }
  return "";
}

export function compact(value: unknown, maximum = 150): string {
  const text = valueText(value).replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

const MAX_CLIENT_EVENTS = 20_000;

function toolCallId(event: OwnedSessionEvent): string | undefined {
  const id = record(event.data)?.toolCallId;
  return typeof id === "string" ? id : undefined;
}

function toolOutput(data: Record<string, unknown> | undefined): { readonly outputRef?: string; readonly outputBytes?: number; readonly outputTruncated?: boolean } {
  return {
    ...(typeof data?.outputRef === "string" ? { outputRef: data.outputRef } : {}),
    ...(typeof data?.outputBytes === "number" ? { outputBytes: data.outputBytes } : {}),
    ...(data?.outputTruncated === true ? { outputTruncated: true } : {}),
  };
}

/** Merge an incremental session response while applying the same lifecycle
 * coalescing used by the server. This keeps mobile polling payloads small
 * without accumulating streaming updates in browser memory. */
export function mergeSessionEvents(
  current: ReadonlyArray<OwnedSessionEvent>,
  incoming: ReadonlyArray<OwnedSessionEvent>,
): ReadonlyArray<OwnedSessionEvent> {
  // Re-coalesce the complete union instead of only processing novel sequence
  // numbers. An overlapping response may contain a tool start that was already
  // removed locally plus its known completion; skipping the known completion
  // would otherwise resurrect a duplicate running tool row.
  const bySequence = new Map<number, OwnedSessionEvent>();
  for (const event of current) bySequence.set(event.sequence, event);
  for (const event of incoming) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }

  const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const discarded = new Set<number>();
  const toolStarts = new Map<string, number[]>();
  const latestToolUpdate = new Map<string, number>();
  let pendingMessageActivity: number[] = [];

  // Mark superseded lifecycle events in one pass. The former implementation
  // searched all retained events for every completed tool, which made each
  // streaming token quadratic in the size of a long-running session.
  for (const event of ordered) {
    if (event.type === "message_start" || event.type === "message_update") pendingMessageActivity.push(event.sequence);
    if (event.type === "message_end") {
      for (const sequence of pendingMessageActivity) discarded.add(sequence);
      pendingMessageActivity = [];
    }

    const id = toolCallId(event);
    if (!id) continue;
    if (event.type === "tool_execution_start") {
      const starts = toolStarts.get(id);
      if (starts) starts.push(event.sequence);
      else toolStarts.set(id, [event.sequence]);
    }
    if (event.type === "tool_execution_update") {
      const previous = latestToolUpdate.get(id);
      if (previous !== undefined) discarded.add(previous);
      latestToolUpdate.set(id, event.sequence);
    }
    if (event.type === "tool_execution_end") {
      for (const sequence of toolStarts.get(id) ?? []) discarded.add(sequence);
      const update = latestToolUpdate.get(id);
      if (update !== undefined) discarded.add(update);
      toolStarts.delete(id);
      latestToolUpdate.delete(id);
    }
  }

  let events = ordered.filter((event) => !discarded.has(event.sequence));
  let excess = events.length - MAX_CLIENT_EVENTS;
  if (excess > 0) {
    const additionallyDiscarded = new Set<number>();
    for (let index = 0; index < events.length - 1 && excess > 0; index += 1) {
      const event = events[index]!;
      if (event.type === "message_end" || event.type === "tool_execution_end") continue;
      additionallyDiscarded.add(event.sequence);
      excess -= 1;
    }
    for (const event of events) {
      if (excess <= 0) break;
      if (additionallyDiscarded.has(event.sequence)) continue;
      additionallyDiscarded.add(event.sequence);
      excess -= 1;
    }
    events = events.filter((event) => !additionallyDiscarded.has(event.sequence));
  }
  return events;
}

export function eventTimeline(events: ReadonlyArray<OwnedSessionEvent>): ReadonlyArray<TimelineItem> {
  const items: Array<TimelineItem> = [];
  const tools = new Map<string, number>();
  let activeCompaction: number | undefined;
  let activeRetry: number | undefined;
  let activeSupervisor: number | undefined;
  let liveText = "";
  let liveTextKey = "";
  let liveThinking = "";
  let liveThinkingKey = "";

  for (const event of events) {
    const data = record(event.data);
    if (event.type === "browser_artifact_created") {
      const artifact = browserArtifact(data);
      if (artifact?.kind === "browser-screenshot") items.push({ _tag: "browser-image", key: `browser-artifact-${event.sequence}`, sequence: event.sequence, artifact });
      if (artifact?.kind === "browser-video") items.push({ _tag: "browser-video", key: `browser-artifact-${event.sequence}`, sequence: event.sequence, artifact });
    }
    if (event.type === "browser_artifact_failed" && typeof data?.message === "string") {
      items.push({ _tag: "notice", key: `browser-artifact-failed-${event.sequence}`, sequence: event.sequence, text: data.message, tone: "error" });
    }
    if (event.type === "workflow_supervisor_consulting") {
      activeSupervisor = items.length;
      items.push({
        _tag: "status",
        key: `workflow-supervisor-${event.sequence}`,
        sequence: event.sequence,
        label: "Loop supervisor reviewing blocker",
        detail: typeof data?.repeatedBlockerCount === "number" ? `Bounded consultation ${data.repeatedBlockerCount}` : "Inspecting the approved plan and blocker evidence",
        tone: "running",
      });
    }
    if (event.type === "workflow_supervisor_advice" && typeof data?.summary === "string") {
      const automatic = data.automaticRecovery === true;
      const unsafe = data.action === "unsafe_stop";
      const status: TimelineItem = {
        _tag: "status",
        key: activeSupervisor === undefined ? `workflow-supervisor-${event.sequence}` : items[activeSupervisor]!._tag === "status" ? items[activeSupervisor]!.key : `workflow-supervisor-${event.sequence}`,
        sequence: event.sequence,
        label: automatic ? "Loop supervisor resumed workflow" : unsafe ? "Loop supervisor stopped unsafe work" : "Loop supervisor requested human authority",
        detail: data.summary,
        tone: automatic ? "success" : "error",
      };
      if (activeSupervisor === undefined) items.push(status);
      else items[activeSupervisor] = status;
      activeSupervisor = undefined;
    }
    // TODO(tracer): Project stateful setStatus/setWidget/set_editor_text RPC
    // methods once the web shell has session-scoped extension UI state.
    if (event.type === "extension_ui_request" && data?.method === "notify" && typeof data.message === "string") {
      const tone = data.notifyType === "error" ? "error" : data.notifyType === "warning" ? "warning" : "info";
      items.push({ _tag: "notice", key: `notice-${event.sequence}`, sequence: event.sequence, text: data.message, tone });
    }
    if (event.type === "compaction_start") {
      const reason = data?.reason === "overflow" ? "Context limit reached" : data?.reason === "threshold" ? "Context threshold reached" : "Manual compaction";
      activeCompaction = items.length;
      items.push({
        _tag: "status",
        key: `compaction-${event.sequence}`,
        sequence: event.sequence,
        label: "Compacting context",
        detail: `${reason} · preserving recent work and summarizing history`,
        tone: "running",
      });
    }
    if (event.type === "compaction_end") {
      const result = record(data?.result);
      const failed = data?.aborted === true || !result;
      const before = typeof result?.tokensBefore === "number" ? result.tokensBefore : undefined;
      const after = typeof result?.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : undefined;
      const status: TimelineItem = {
        _tag: "status",
        key: activeCompaction === undefined ? `compaction-${event.sequence}` : items[activeCompaction]!._tag === "status" ? items[activeCompaction]!.key : `compaction-${event.sequence}`,
        sequence: event.sequence,
        label: failed ? data?.aborted === true ? "Compaction cancelled" : "Compaction failed" : "Context compacted",
        detail: failed
          ? typeof data?.errorMessage === "string" ? data.errorMessage : "Pi could not reduce the active context"
          : before !== undefined ? `${before.toLocaleString()} → ${after?.toLocaleString() ?? "?"} estimated tokens` : "History summarized · recent work retained",
        tone: failed ? "error" : "success",
      };
      if (activeCompaction === undefined) items.push(status);
      else items[activeCompaction] = status;
      activeCompaction = undefined;
    }
    if (event.type === "auto_retry_start") {
      const attempt = typeof data?.attempt === "number" ? data.attempt : 1;
      const maximum = typeof data?.maxAttempts === "number" ? data.maxAttempts : undefined;
      activeRetry = items.length;
      items.push({
        _tag: "status",
        key: `retry-${event.sequence}`,
        sequence: event.sequence,
        label: "Retrying provider",
        detail: `Attempt ${attempt}${maximum ? ` of ${maximum}` : ""}${typeof data?.delayMs === "number" ? ` · waiting ${Math.ceil(data.delayMs / 1000)}s` : ""}`,
        tone: "running",
      });
    }
    if (event.type === "auto_retry_end") {
      const succeeded = data?.success === true;
      const status: TimelineItem = {
        _tag: "status",
        key: activeRetry === undefined ? `retry-${event.sequence}` : items[activeRetry]!._tag === "status" ? items[activeRetry]!.key : `retry-${event.sequence}`,
        sequence: event.sequence,
        label: succeeded ? "Provider recovered" : "Provider retry failed",
        detail: succeeded ? "The session continued automatically" : typeof data?.finalError === "string" ? data.finalError : "Retry attempts were exhausted",
        tone: succeeded ? "success" : "error",
      };
      if (activeRetry === undefined) items.push(status);
      else items[activeRetry] = status;
      activeRetry = undefined;
    }
    if (event.type === "message_start") {
      const message = record(data?.message);
      if (message?.role === "assistant") {
        liveText = "";
        liveTextKey = `live-${event.sequence}`;
        liveThinking = "";
        liveThinkingKey = `thinking-live-${event.sequence}`;
      }
    }
    if (event.type === "message_update") {
      const update = record(data?.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        if (!liveTextKey) liveTextKey = `live-${event.sequence}`;
        liveText += update.delta;
      }
      if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        if (!liveThinkingKey) liveThinkingKey = `thinking-live-${event.sequence}`;
        liveThinking += update.delta;
      }
    }
    if (event.type === "message_end") {
      const message = record(data?.message);
      const role = message?.role;
      const text = messageText(message);
      const thinking = messageThinking(message);
      const imageCount = messageImages(message);
      if (role === "assistant" && thinking) {
        items.push({ _tag: "thinking", key: `thinking-${event.sequence}`, sequence: event.sequence, text: thinking });
      }
      if ((role === "user" || role === "assistant") && (text || imageCount > 0)) {
        items.push({ _tag: "message", key: `message-${event.sequence}`, sequence: event.sequence, role, text, imageCount });
      }
      if (role === "assistant") {
        liveText = "";
        liveTextKey = "";
        liveThinking = "";
        liveThinkingKey = "";
      }
    }
    if (event.type === "tool_execution_start") {
      const id = typeof data?.toolCallId === "string" ? data.toolCallId : `tool-${event.sequence}`;
      tools.set(id, items.length);
      items.push({
        _tag: "tool",
        key: id,
        sequence: event.sequence,
        name: typeof data?.toolName === "string" ? data.toolName : "tool",
        detail: compact(data?.args) || "Executing…",
        error: false,
        state: "running",
      });
    }
    if (event.type === "tool_execution_update") {
      const id = typeof data?.toolCallId === "string" ? data.toolCallId : `tool-${event.sequence}`;
      const existing = tools.get(id);
      if (existing !== undefined) {
        const previous = items[existing];
        if (previous?._tag === "tool") items[existing] = { ...previous, detail: valueText(data?.partialResult) || previous.detail, ...toolOutput(data) };
      } else {
        tools.set(id, items.length);
        items.push({
          _tag: "tool",
          key: id,
          sequence: event.sequence,
          name: typeof data?.toolName === "string" ? data.toolName : "tool",
          detail: valueText(data?.partialResult) || "Execution in progress…",
          error: false,
          state: "running",
          ...toolOutput(data),
        });
      }
    }
    if (event.type === "tool_execution_end") {
      const id = typeof data?.toolCallId === "string" ? data.toolCallId : "";
      const existing = tools.get(id);
      const tool: TimelineItem = {
        _tag: "tool",
        key: id || `tool-${event.sequence}`,
        sequence: event.sequence,
        name: typeof data?.toolName === "string" ? data.toolName : "tool",
        detail: valueText(data?.result) || (data?.isError === true ? "Tool failed" : "Completed"),
        error: data?.isError === true,
        state: "done",
        ...toolOutput(data),
      };
      if (existing === undefined) items.push(tool);
      else items[existing] = tool;
    }
  }

  const liveSequence = events.at(-1)?.sequence ?? 0;
  if (liveThinking) items.push({ _tag: "thinking", key: liveThinkingKey, sequence: liveSequence, text: liveThinking, live: true });
  if (liveText) items.push({ _tag: "message", key: liveTextKey, sequence: liveSequence, role: "assistant", text: liveText, imageCount: 0, live: true });
  return items;
}
