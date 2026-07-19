export type PiMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .map((part) => part.type === "text" ? part.text ?? "" : "")
    .filter(Boolean)
    .join("\n");
}

export function imageAttachments(content: unknown): Array<{ mimeType: string }> {
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

export function compactText(value: string, maximum = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

export function summarize(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return compactText(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as { content?: unknown; text?: unknown; path?: unknown };
    const content = textContent(record.content);
    if (content) return compactText(content);
    if (typeof record.text === "string") return compactText(record.text);
    if (typeof record.path === "string") return compactText(record.path);
  }
  try { return compactText(JSON.stringify(value)); } catch { return "Activity update"; }
}
