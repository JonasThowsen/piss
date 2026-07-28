export type ActiveFileMention = {
  readonly prefix: string;
  readonly query: string;
  readonly start: number;
  readonly end: number;
};

export function activeFileMention(text: string, cursor: number): ActiveFileMention | undefined {
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const beforeCursor = text.slice(lineStart, cursor);
  const match = beforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  const prefix = match?.[1];
  if (!prefix) return;
  return {
    prefix,
    query: prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1),
    start: cursor - prefix.length,
    end: cursor,
  };
}

export function fileMentionValue(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

export function applyFileMention(text: string, active: ActiveFileMention, path: string): {
  readonly text: string;
  readonly cursor: number;
} {
  const value = fileMentionValue(path);
  return {
    text: `${text.slice(0, active.start)}${value}${text.slice(active.end)}`,
    cursor: active.start + value.length,
  };
}
