import type { OwnedSessionEvent } from "../../shared/domain.ts";

export type TimelineItem =
  | { readonly _tag: "message"; readonly key: string; readonly sequence: number; readonly role: "user" | "assistant"; readonly text: string; readonly imageCount: number; readonly live?: boolean }
  | { readonly _tag: "tool"; readonly key: string; readonly name: string; readonly detail: string; readonly error: boolean; readonly state: "running" | "done" };

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

export function eventTimeline(events: ReadonlyArray<OwnedSessionEvent>): ReadonlyArray<TimelineItem> {
  const items: Array<TimelineItem> = [];
  const tools = new Map<string, number>();
  let liveText = "";
  let liveKey = "";

  for (const event of events) {
    const data = record(event.data);
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
        if (previous?._tag === "tool") items[existing] = { ...previous, detail: valueText(data?.partialResult) || previous.detail };
      } else {
        tools.set(id, items.length);
        items.push({
          _tag: "tool",
          key: id,
          name: typeof data?.toolName === "string" ? data.toolName : "tool",
          detail: valueText(data?.partialResult) || "Execution in progress…",
          error: false,
          state: "running",
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
      };
      if (existing === undefined) items.push(tool);
      else items[existing] = tool;
    }
  }

  if (liveText) items.push({ _tag: "message", key: liveKey, sequence: events.at(-1)?.sequence ?? 0, role: "assistant", text: liveText, imageCount: 0, live: true });
  return items;
}
