import type { ReviewFile } from "../../shared/domain.ts";

export type DiffLineKind = "meta" | "hunk" | "added" | "removed" | "context";

export type DiffLine = {
  readonly index: number;
  readonly text: string;
  readonly kind: DiffLineKind;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly selectable: boolean;
};

export type DiffSelection = {
  readonly anchor: number;
  readonly end: number;
};

type ReviewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const REVIEWED_PREFIX = "piss:reviewed:";
const MAX_REVIEWED_KEYS = 500;

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

export function fileReviewKey(file: ReviewFile): string {
  return `${file.path}:${hash(`${file.indexStatus}\0${file.worktreeStatus}\0${file.binary ? "1" : "0"}\0${file.patch}`)}`;
}

export function reviewedStorageKey(sessionId: string): string {
  return `${REVIEWED_PREFIX}${sessionId}`;
}

export function readReviewedFiles(sessionId: string, storage: ReviewStorage = localStorage): ReadonlySet<string> {
  try {
    const raw = storage.getItem(reviewedStorageKey(sessionId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) throw new Error("Invalid reviewed files");
    return new Set(parsed.slice(-MAX_REVIEWED_KEYS));
  } catch {
    try { storage.removeItem(reviewedStorageKey(sessionId)); } catch { /* Storage is optional. */ }
    return new Set();
  }
}

export function writeReviewedFiles(sessionId: string, reviewed: ReadonlySet<string>, storage: ReviewStorage = localStorage): void {
  try {
    const keys = Array.from(reviewed).slice(-MAX_REVIEWED_KEYS);
    if (keys.length === 0) storage.removeItem(reviewedStorageKey(sessionId));
    else storage.setItem(reviewedStorageKey(sessionId), JSON.stringify(keys));
  } catch {
    // Storage may be unavailable or full in private browsing modes.
  }
}

export function parseUnifiedDiff(patch: string): ReadonlyArray<DiffLine> {
  let oldLine: number | undefined;
  let newLine: number | undefined;

  return patch.split("\n").map((text, index): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { index, text, kind: "hunk", selectable: false };
    }

    if (oldLine === undefined || newLine === undefined) return { index, text, kind: "meta", selectable: false };
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const line = { index, text, kind: "added" as const, newLine, selectable: true };
      newLine += 1;
      return line;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const line = { index, text, kind: "removed" as const, oldLine, selectable: true };
      oldLine += 1;
      return line;
    }
    if (text.startsWith(" ")) {
      const line = { index, text, kind: "context" as const, oldLine, newLine, selectable: true };
      oldLine += 1;
      newLine += 1;
      return line;
    }
    return { index, text, kind: "meta", selectable: false };
  });
}

export function nextDiffSelection(current: DiffSelection | undefined, lineIndex: number): DiffSelection | undefined {
  if (current?.anchor === lineIndex && current.end === lineIndex) return;
  return current ? { anchor: current.anchor, end: lineIndex } : { anchor: lineIndex, end: lineIndex };
}

export function selectedDiffLines(lines: ReadonlyArray<DiffLine>, selection: DiffSelection): ReadonlyArray<DiffLine> {
  const start = Math.min(selection.anchor, selection.end);
  const end = Math.max(selection.anchor, selection.end);
  return lines.filter((line) => line.selectable && line.index >= start && line.index <= end);
}

function lineRange(numbers: ReadonlyArray<number>): string | undefined {
  if (numbers.length === 0) return;
  const start = Math.min(...numbers);
  const end = Math.max(...numbers);
  return start === end ? `${start}` : `${start}-${end}`;
}

export function selectionLocation(path: string, lines: ReadonlyArray<DiffLine>): string {
  const oldRange = lineRange(lines.flatMap((line) => line.oldLine === undefined ? [] : [line.oldLine]));
  const newRange = lineRange(lines.flatMap((line) => line.newLine === undefined ? [] : [line.newLine]));
  if (newRange && !oldRange) return `${path}:${newRange}`;
  if (oldRange && !newRange) return `${path}:old:${oldRange}`;
  if (newRange && oldRange && newRange === oldRange) return `${path}:${newRange}`;
  return `${path} (new lines ${newRange ?? "—"}; old lines ${oldRange ?? "—"})`;
}

export function formatReviewComment(path: string, lines: ReadonlyArray<DiffLine>, comment: string): string {
  const location = selectionLocation(path, lines);
  const excerpt = lines.map((line) => line.text).join("\n");
  return `Review comment at ${location}:\n\n${comment.trim()}\n\nSelected diff:\n\`\`\`diff\n${excerpt}\n\`\`\``;
}
