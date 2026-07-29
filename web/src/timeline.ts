import type { OwnedSessionEvent } from "../../shared/domain.ts";

export type TimelineItem =
  | { readonly _tag: "message"; readonly key: string; readonly sequence: number; readonly role: "user" | "assistant"; readonly text: string; readonly imageCount: number; readonly live?: boolean }
  | { readonly _tag: "tool"; readonly key: string; readonly name: string; readonly detail: string; readonly error: boolean; readonly state: "running" | "done"; readonly outputRef?: string; readonly outputBytes?: number; readonly outputTruncated?: boolean }
  | { readonly _tag: "status"; readonly key: string; readonly label: string; readonly detail: string; readonly tone: "running" | "success" | "error" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

const MAX_CLIENT_EVENTS = 750;

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
  const events = [...current];
  const knownSequences = new Set(events.map((event) => event.sequence));

  for (const event of incoming) {
    if (knownSequences.has(event.sequence)) continue;
    const id = toolCallId(event);
    if (id && (event.type === "tool_execution_update" || event.type === "tool_execution_end")) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const candidate = events[index]!;
        if (toolCallId(candidate) !== id) continue;
        if (candidate.type === "tool_execution_update" || event.type === "tool_execution_end" && candidate.type === "tool_execution_start") {
          knownSequences.delete(candidate.sequence);
          events.splice(index, 1);
        }
      }
    }
    if (event.type === "message_end") {
      const previousMessage = events.findLastIndex((candidate) => candidate.type === "message_end");
      for (let index = events.length - 1; index > previousMessage; index -= 1) {
        if (events[index]?.type === "message_start" || events[index]?.type === "message_update") {
          knownSequences.delete(events[index]!.sequence);
          events.splice(index, 1);
        }
      }
    }
    events.push(event);
    knownSequences.add(event.sequence);
    while (events.length > MAX_CLIENT_EVENTS) {
      const disposable = events.findIndex((candidate, index) =>
        index < events.length - 1 && candidate.type !== "message_end" && candidate.type !== "tool_execution_end"
      );
      const [removed] = events.splice(disposable >= 0 ? disposable : 0, 1);
      if (removed) knownSequences.delete(removed.sequence);
    }
  }
  return events;
}

export function eventTimeline(events: ReadonlyArray<OwnedSessionEvent>): ReadonlyArray<TimelineItem> {
  const items: Array<TimelineItem> = [];
  const tools = new Map<string, number>();
  let activeCompaction: number | undefined;
  let activeRetry: number | undefined;
  let liveText = "";
  let liveKey = "";

  for (const event of events) {
    const data = record(event.data);
    if (event.type === "compaction_start") {
      const reason = data?.reason === "overflow" ? "Context limit reached" : data?.reason === "threshold" ? "Context threshold reached" : "Manual compaction";
      activeCompaction = items.length;
      items.push({
        _tag: "status",
        key: `compaction-${event.sequence}`,
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
        liveKey = `live-${event.sequence}`;
      }
    }
    if (event.type === "message_update") {
      const update = record(data?.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        if (!liveKey) liveKey = `live-${event.sequence}`;
        liveText += update.delta;
      }
    }
    if (event.type === "message_end") {
      const message = record(data?.message);
      const role = message?.role;
      const text = messageText(message);
      const imageCount = messageImages(message);
      if ((role === "user" || role === "assistant") && (text || imageCount > 0)) {
        items.push({ _tag: "message", key: `message-${event.sequence}`, sequence: event.sequence, role, text, imageCount });
      }
      if (role === "assistant") {
        liveText = "";
        liveKey = "";
      }
    }
    if (event.type === "tool_execution_start") {
      const id = typeof data?.toolCallId === "string" ? data.toolCallId : `tool-${event.sequence}`;
      tools.set(id, items.length);
      items.push({
        _tag: "tool",
        key: id,
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

  if (liveText) items.push({ _tag: "message", key: liveKey, sequence: events.at(-1)?.sequence ?? 0, role: "assistant", text: liveText, imageCount: 0, live: true });
  return items;
}
