import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewFile, ReviewSnapshot } from "../shared/protocol.ts";

const MAX_FILES = 100;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_REVIEWABLE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

export interface StatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export function parsePorcelainStatus(output: string): StatusEntry[] {
  const records = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    if (!path || (indexStatus === "!" && worktreeStatus === "!")) continue;
    entries.push({ path, indexStatus, worktreeStatus });
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      index += 1; // porcelain -z follows a renamed path with its original path
    }
  }
  return entries;
}

function truncateUtf8(value: string, maximum: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return { value, truncated: false };
  const suffix = "\n\n[patch truncated by PISS]\n";
  return {
    value: `${bytes.subarray(0, maximum - Buffer.byteLength(suffix)).toString("utf8")}${suffix}`,
    truncated: true,
  };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function isTooLargeToReview(pi: ExtensionAPI, cwd: string, entry: StatusEntry): Promise<boolean> {
  try {
    const info = await lstat(resolve(cwd, entry.path));
    if (info.isFile() && info.size > MAX_REVIEWABLE_FILE_BYTES) return true;
  } catch {
    // Deleted worktree files are checked against Git objects below.
  }
  const revisions = new Set<string>();
  if (entry.indexStatus !== " " && entry.indexStatus !== "?") revisions.add(`:${entry.path}`);
  if (entry.worktreeStatus === "D" || entry.indexStatus === "D") revisions.add(`HEAD:${entry.path}`);
  for (const revision of revisions) {
    const size = await pi.exec("git", ["cat-file", "-s", revision], { cwd, timeout: GIT_TIMEOUT_MS });
    if (size.code === 0 && Number.parseInt(size.stdout.trim(), 10) > MAX_REVIEWABLE_FILE_BYTES) return true;
  }
  return false;
}

export async function collectReview(pi: ExtensionAPI, cwd: string): Promise<ReviewSnapshot> {
  const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (status.code !== 0) throw new Error("The session working directory is not an accessible Git repository");

  const allEntries = parsePorcelainStatus(status.stdout);
  const selected = allEntries.slice(0, MAX_FILES);
  const files = await mapWithConcurrency(selected, CONCURRENCY, async (entry): Promise<ReviewFile> => {
    if (await isTooLargeToReview(pi, cwd, entry)) {
      return {
        ...entry,
        patch: "[file omitted because it exceeds the 1 MiB review limit]\n",
        truncated: true,
        binary: false,
      };
    }
    const sections: string[] = [];
    if (entry.indexStatus === "?" && entry.worktreeStatus === "?") {
      const result = await pi.exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", "/dev/null", entry.path], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      if (result.stdout) sections.push(result.stdout);
    } else {
      if (entry.indexStatus !== " " && entry.indexStatus !== "?") {
        const staged = await pi.exec("git", ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3", "--", entry.path], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        });
        if (staged.stdout) sections.push("# STAGED\n", staged.stdout);
      }
      if (entry.worktreeStatus !== " " && entry.worktreeStatus !== "?") {
        const unstaged = await pi.exec("git", ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--", entry.path], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        });
        if (unstaged.stdout) sections.push("# UNSTAGED\n", unstaged.stdout);
      }
    }

    const patch = sections.join("\n");
    const limited = truncateUtf8(patch, MAX_PATCH_BYTES);
    return {
      ...entry,
      patch: limited.value,
      truncated: limited.truncated,
      binary: /(?:Binary files .* differ|GIT binary patch)/.test(patch),
    };
  });

  let totalBytes = 0;
  let truncated = allEntries.length > selected.length;
  const boundedFiles: ReviewFile[] = [];
  for (const file of files) {
    const bytes = Buffer.byteLength(file.patch);
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += bytes;
    boundedFiles.push(file);
    truncated ||= file.truncated;
  }

  return {
    cwd,
    generatedAt: Date.now(),
    files: boundedFiles,
    truncated,
    totalFiles: allEntries.length,
  };
}
