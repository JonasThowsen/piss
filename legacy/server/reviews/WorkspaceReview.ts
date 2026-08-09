import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { ReviewFile, ReviewSnapshot } from "../../shared/domain.ts";
import { WorkspaceDirectory, type WorkspaceDirectoryShape } from "../workspaces/WorkspaceDirectory.ts";
import type { WorkspacePathError } from "../workspaces/errors.ts";
import { WorkspaceReviewError } from "./errors.ts";

const MAX_FILES = 100;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_REVIEWABLE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

export interface StatusEntry {
  readonly path: string;
  readonly indexStatus: ReviewFile["indexStatus"];
  readonly worktreeStatus: ReviewFile["worktreeStatus"];
}

const GIT_STATUS_CODES: ReadonlySet<string> = new Set([" ", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);

function isGitStatusCode(value: string): value is ReviewFile["indexStatus"] {
  return GIT_STATUS_CODES.has(value);
}

interface GitCheckout {
  readonly repositoryFd: number;
  readonly workspaceFd: number;
  readonly gitFd: number;
  readonly commonGitFd: number;
  readonly workspaceRelativePath: string;
}

interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface WorkspaceIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface WorkspaceReviewShape {
  readonly collect: (root: string, identity: WorkspaceIdentity) => Effect.Effect<ReviewSnapshot, WorkspaceReviewError | WorkspacePathError>;
}

export class WorkspaceReview extends Context.Service<WorkspaceReview, WorkspaceReviewShape>()(
  "@piss/WorkspaceReview",
) {}

function safeGitPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\0");
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
    if (!isGitStatusCode(indexStatus) || !isGitStatusCode(worktreeStatus) || !safeGitPath(path) || (indexStatus === "!" && worktreeStatus === "!")) continue;
    entries.push({ path, indexStatus, worktreeStatus });
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") index += 1;
  }
  return entries;
}

function runGit(checkout: GitCheckout, args: ReadonlyArray<string>, maximumStdout: number, signal: AbortSignal): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    signal.throwIfAborted();
    const safeArgs = ["-c", "safe.directory=/repo", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-pager", ...args];
    const sandboxArgs = [
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
      "--ro-bind", "/nix/store", "/nix/store",
      "--ro-bind", "/proc/self/fd/3", "/repo",
      "--dir", "/git",
      "--ro-bind", "/proc/self/fd/4", "/git/worktree",
      "--ro-bind", "/proc/self/fd/5", "/git/common",
      "--dir", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home",
      "--setenv", "HOME", "/tmp",
      "--setenv", "PATH", process.env.PATH ?? "",
      "--setenv", "LC_ALL", "C",
      "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
      "--setenv", "GIT_OPTIONAL_LOCKS", "0",
      "--setenv", "GIT_TERMINAL_PROMPT", "0",
      "--setenv", "GIT_DIR", "/git/worktree",
      "--setenv", "GIT_COMMON_DIR", "/git/common",
      "--setenv", "GIT_WORK_TREE", "/repo",
      "--chdir", checkout.workspaceRelativePath ? `/repo/${checkout.workspaceRelativePath}` : "/repo", "--", "git", ...safeArgs,
    ];
    const child = spawn("bwrap", sandboxArgs, { detached: true, stdio: ["ignore", "pipe", "pipe", checkout.repositoryFd, checkout.gitFd, checkout.commonGitFd] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutSeen = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const retain = (chunks: Buffer[], chunk: Buffer, retained: number, maximum: number): number => {
      if (retained >= maximum) return retained;
      const slice = chunk.subarray(0, maximum - retained);
      if (slice.length > 0) chunks.push(slice);
      return retained + slice.length;
    };
    child.stdout!.on("data", (value: Buffer) => {
      stdoutSeen += value.length;
      stdoutBytes = retain(stdout, value, stdoutBytes, maximumStdout);
      truncated ||= stdoutSeen > maximumStdout;
    });
    child.stderr!.on("data", (value: Buffer) => { stderrBytes = retain(stderr, value, stderrBytes, 16 * 1024); });
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const onAbort = () => terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cause);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(signal.reason);
      if (timedOut) return reject(new Error("Git review timed out"));
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, GIT_TIMEOUT_MS);
  });
}

function truncateUtf8(value: string, maximum: number, alreadyTruncated = false): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum && !alreadyTruncated) return { value, truncated: false };
  const suffix = "\n\n[patch truncated by PISS]\n";
  return {
    value: `${bytes.subarray(0, Math.max(0, maximum - Buffer.byteLength(suffix))).toString("utf8")}${suffix}`,
    truncated: true,
  };
}

async function mapWithConcurrency<T, R>(values: ReadonlyArray<T>, limit: number, signal: AbortSignal, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function isTooLargeToReview(checkout: GitCheckout, entry: StatusEntry, signal: AbortSignal): Promise<boolean> {
  try {
    const info = await lstat(resolve(`/proc/self/fd/${checkout.workspaceFd}`, entry.path));
    if (info.isFile() && info.size > MAX_REVIEWABLE_FILE_BYTES) return true;
  } catch {
    // Deleted worktree files are checked against Git objects below.
  }
  const revisions = new Set<string>();
  const repositoryPath = checkout.workspaceRelativePath ? `${checkout.workspaceRelativePath}/${entry.path}` : entry.path;
  if (entry.indexStatus !== " " && entry.indexStatus !== "?") revisions.add(`:${repositoryPath}`);
  if (!(entry.indexStatus === "?" && entry.worktreeStatus === "?")) revisions.add(`HEAD:${repositoryPath}`);
  for (const revision of revisions) {
    const size = await runGit(checkout, ["cat-file", "-s", revision], 128, signal);
    if (size.code === 0 && Number.parseInt(size.stdout.trim(), 10) > MAX_REVIEWABLE_FILE_BYTES) return true;
  }
  return false;
}

async function collect(checkout: GitCheckout, signal: AbortSignal): Promise<ReviewSnapshot> {
  const filters = await runGit(checkout, ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"], 64 * 1024, signal);
  if (filters.code !== 0 && filters.code !== 1) throw new WorkspaceReviewError({ message: "Could not validate this repository's Git configuration" });
  if (filters.truncated || filters.stdout) throw new WorkspaceReviewError({ message: "Repositories with executable Git filters cannot be reviewed safely" });

  const status = await runGit(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], MAX_STATUS_BYTES, signal);
  if (status.code !== 0) {
    console.warn("PISS review status command failed", { code: status.code });
    throw new WorkspaceReviewError({ message: "This workspace is not an accessible Git repository" });
  }
  if (status.truncated) throw new WorkspaceReviewError({ message: "This repository has too many changed paths to review safely" });

  const allEntries = parsePorcelainStatus(status.stdout).flatMap((entry) => {
    if (!checkout.workspaceRelativePath) return [entry];
    const prefix = `${checkout.workspaceRelativePath}/`;
    return entry.path.startsWith(prefix) ? [{ ...entry, path: entry.path.slice(prefix.length) }] : [];
  });
  const selected = allEntries.slice(0, MAX_FILES);
  const workers = new AbortController();
  const cancelWorkers = () => workers.abort(signal.reason);
  signal.addEventListener("abort", cancelWorkers, { once: true });
  let files: ReviewFile[];
  try {
    files = await mapWithConcurrency(selected, CONCURRENCY, workers.signal, async (entry): Promise<ReviewFile> => {
      if (await isTooLargeToReview(checkout, entry, workers.signal)) {
        return { ...entry, patch: "[file omitted because it exceeds the 1 MiB review limit]\n", truncated: true, binary: false };
      }

      const sections: string[] = [];
      let commandTruncated = false;
      if (entry.indexStatus === "?" && entry.worktreeStatus === "?") {
        const result = await runGit(checkout, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", "/dev/null", entry.path], MAX_PATCH_BYTES, workers.signal);
        if (result.code !== 0 && result.code !== 1) throw new Error("Could not read an untracked patch");
        if (result.stdout) sections.push(result.stdout);
        commandTruncated ||= result.truncated;
      } else {
        if (entry.indexStatus !== " " && entry.indexStatus !== "?") {
          const staged = await runGit(checkout, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", entry.path], MAX_PATCH_BYTES, workers.signal);
          if (staged.code !== 0) throw new Error("Could not read a staged patch");
          if (staged.stdout) sections.push("# STAGED\n", staged.stdout);
          commandTruncated ||= staged.truncated;
        }
        if (entry.worktreeStatus !== " " && entry.worktreeStatus !== "?") {
          const unstaged = await runGit(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", entry.path], MAX_PATCH_BYTES, workers.signal);
          if (unstaged.code !== 0) throw new Error("Could not read an unstaged patch");
          if (unstaged.stdout) sections.push("# UNSTAGED\n", unstaged.stdout);
          commandTruncated ||= unstaged.truncated;
        }
      }

      const patch = sections.join("\n");
      const limited = truncateUtf8(patch, MAX_PATCH_BYTES, commandTruncated);
      return {
        ...entry,
        patch: limited.value,
        truncated: limited.truncated,
        binary: /(?:Binary files .* differ|GIT binary patch)/.test(patch),
      };
    });
  } catch (cause) {
    workers.abort(cause);
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancelWorkers);
  }

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

  return { generatedAt: Date.now(), files: boundedFiles, truncated, totalFiles: allEntries.length };
}

interface LocatedRepository {
  readonly repository: FileHandle;
  readonly gitDirectory: FileHandle;
  readonly commonGitDirectory: FileHandle;
  readonly workspaceRelativePath: string;
  readonly ownsRepositoryHandle: boolean;
}

async function readPointerFile(path: string, maximumBytes = 16 * 1024): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) throw new Error("Git pointer must be a bounded regular file");
    const encoded = await handle.readFile("utf8");
    const match = /^([^\0\r\n]+)\n?$/.exec(encoded);
    if (!match) throw new Error("Git pointer has an invalid format");
    return match[1]!;
  } finally {
    await handle.close();
  }
}

async function rejectMetadataSymlinks(rootFd: number, paths: ReadonlyArray<string>): Promise<void> {
  for (const path of paths) {
    try {
      const metadata = await lstat(`/proc/self/fd/${rootFd}/${path}`);
      if (metadata.isSymbolicLink()) throw new Error("Symlinked Git metadata is not permitted");
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
  }
}

async function openStandardGitDirectory(repository: FileHandle): Promise<{ gitDirectory: FileHandle; commonGitDirectory: FileHandle } | undefined> {
  const gitPath = `/proc/self/fd/${repository.fd}/.git`;
  let gitDirectory: FileHandle;
  try {
    gitDirectory = await open(gitPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ENOTDIR" || cause.code === "ENOENT" || cause.code === "ELOOP")) return;
    throw cause;
  }
  try {
    const commonGitDirectory = await open(gitPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await rejectMetadataSymlinks(gitDirectory.fd, ["HEAD", "config", "index", "objects", "refs"]);
    return { gitDirectory, commonGitDirectory };
  } catch (cause) {
    await gitDirectory.close();
    throw cause;
  }
}

async function openWorktreeGitDirectories(
  directories: WorkspaceDirectoryShape,
  repository: FileHandle,
  candidatePath: string,
  signal: AbortSignal,
): Promise<{ gitDirectory: FileHandle; commonGitDirectory: FileHandle } | undefined> {
  const gitFilePath = `/proc/self/fd/${repository.fd}/.git`;
  let encoded: string;
  try {
    encoded = await readPointerFile(gitFilePath, 4 * 1024);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return;
    throw new WorkspaceReviewError({ message: "The workspace contains a malformed or symlinked .git file", cause });
  }
  const match = /^gitdir: (.+)$/.exec(encoded);
  if (!match) throw new WorkspaceReviewError({ message: "The workspace contains a malformed .git file" });
  const requestedGitDirectory = isAbsolute(match[1]!) ? resolve(match[1]!) : resolve(candidatePath, match[1]!);
  const canonicalGitDirectory = await realpath(requestedGitDirectory);
  if (canonicalGitDirectory !== requestedGitDirectory) throw new WorkspaceReviewError({ message: "Symlinked worktree Git metadata is not permitted" });
  const gitDirectory = await Effect.runPromise(directories.openAuthorized(canonicalGitDirectory), { signal }).catch((cause) => {
    throw new WorkspaceReviewError({ message: "The worktree Git directory is outside authorized roots", cause });
  });
  let commonGitDirectory: FileHandle | undefined;
  try {
    const commonPointer = await readPointerFile(`/proc/self/fd/${gitDirectory.fd}/commondir`, 4 * 1024);
    const requestedCommonDirectory = isAbsolute(commonPointer) ? resolve(commonPointer) : resolve(canonicalGitDirectory, commonPointer);
    const canonicalCommonDirectory = await realpath(requestedCommonDirectory);
    if (canonicalCommonDirectory !== requestedCommonDirectory || basename(canonicalCommonDirectory) !== ".git") {
      throw new WorkspaceReviewError({ message: "The worktree common Git directory is invalid" });
    }
    const worktreesRoot = resolve(canonicalCommonDirectory, "worktrees");
    if (dirname(canonicalGitDirectory) !== worktreesRoot || basename(canonicalGitDirectory).includes("/")) {
      throw new WorkspaceReviewError({ message: "The Git directory is not registered by the expected common repository" });
    }
    const backPointer = await readPointerFile(`/proc/self/fd/${gitDirectory.fd}/gitdir`, 16 * 1024);
    const requestedBackPointer = isAbsolute(backPointer) ? resolve(backPointer) : resolve(canonicalGitDirectory, backPointer);
    if (requestedBackPointer !== resolve(candidatePath, ".git")) {
      throw new WorkspaceReviewError({ message: "The Git worktree registration does not point back to this checkout" });
    }
    commonGitDirectory = await Effect.runPromise(directories.openAuthorized(canonicalCommonDirectory), { signal }).catch((cause) => {
      throw new WorkspaceReviewError({ message: "The common Git directory is outside authorized roots", cause });
    });
    await rejectMetadataSymlinks(gitDirectory.fd, ["HEAD", "index", "commondir", "gitdir"]);
    await rejectMetadataSymlinks(commonGitDirectory.fd, ["HEAD", "config", "objects", "refs", "worktrees"]);
    return { gitDirectory, commonGitDirectory };
  } catch (cause) {
    await commonGitDirectory?.close();
    await gitDirectory.close();
    throw cause;
  }
}

async function locateRepository(
  directories: WorkspaceDirectoryShape,
  root: string,
  workspace: FileHandle,
  identity: WorkspaceIdentity,
  signal: AbortSignal,
): Promise<LocatedRepository> {
  let candidatePath = resolve(root);
  for (let depth = 0; depth <= 8; depth += 1) {
    const ownsRepositoryHandle = depth > 0;
    let repository: FileHandle;
    try {
      repository = ownsRepositoryHandle
        ? await Effect.runPromise(directories.openAuthorized(candidatePath), { signal })
        : workspace;
    } catch {
      break;
    }

    let gitDirectories: { gitDirectory: FileHandle; commonGitDirectory: FileHandle } | undefined;
    try {
      gitDirectories = await openStandardGitDirectory(repository)
        ?? await openWorktreeGitDirectories(directories, repository, candidatePath, signal);
    } catch (cause) {
      if (ownsRepositoryHandle) await repository.close();
      throw cause;
    }
    if (!gitDirectories) {
      if (ownsRepositoryHandle) await repository.close();
      const parent = resolve(candidatePath, "..");
      if (parent === candidatePath) break;
      candidatePath = parent;
      continue;
    }

    const workspaceRelativePath = relative(candidatePath, root);
    try {
      const nestedWorkspace = workspaceRelativePath
        ? await open(`/proc/self/fd/${repository.fd}/${workspaceRelativePath}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        : repository;
      let stat;
      try {
        stat = await nestedWorkspace.stat({ bigint: true });
      } finally {
        if (nestedWorkspace !== repository) await nestedWorkspace.close();
      }
      if (stat.dev !== identity.device || stat.ino !== identity.inode) {
        throw new WorkspaceReviewError({ message: "The session checkout changed on disk; start a new session before reviewing it" });
      }
      return { repository, ...gitDirectories, workspaceRelativePath, ownsRepositoryHandle };
    } catch (cause) {
      await gitDirectories.gitDirectory.close();
      await gitDirectories.commonGitDirectory.close();
      if (ownsRepositoryHandle) await repository.close();
      throw cause;
    }
  }
  throw new WorkspaceReviewError({ message: "Review requires a standard repository or registered Git worktree in the workspace or an authorized parent" });
}

export const WorkspaceReviewLive = Layer.effect(
  WorkspaceReview,
  Effect.gen(function* () {
    const directories = yield* WorkspaceDirectory;
    const concurrency = yield* Semaphore.make(2);
    const review: WorkspaceReviewShape["collect"] = (root, identity) => concurrency.withPermit(Effect.acquireUseRelease(
      directories.openAuthorized(root),
      (handle) => Effect.tryPromise({
        try: async (signal) => {
          const stat = await handle.stat({ bigint: true });
          if (stat.dev !== identity.device || stat.ino !== identity.inode) {
            throw new WorkspaceReviewError({ message: "The session checkout changed on disk; start a new session before reviewing it" });
          }
          const located = await locateRepository(directories, root, handle, identity, signal);
          try {
            return await collect({
              repositoryFd: located.repository.fd,
              workspaceFd: handle.fd,
              gitFd: located.gitDirectory.fd,
              commonGitFd: located.commonGitDirectory.fd,
              workspaceRelativePath: located.workspaceRelativePath,
            }, signal);
          } finally {
            await located.gitDirectory.close();
            await located.commonGitDirectory.close();
            if (located.ownsRepositoryHandle) await located.repository.close();
          }
        },
        catch: (cause) => cause instanceof WorkspaceReviewError
          ? cause
          : new WorkspaceReviewError({ message: cause instanceof Error && cause.message === "Git review timed out" ? cause.message : "Could not collect the Git review", cause }),
      }).pipe(Effect.timeout("20 seconds"), Effect.mapError((cause) => cause instanceof WorkspaceReviewError
        ? cause
        : new WorkspaceReviewError({ message: "Git review timed out", cause }))),
      (handle) => Effect.promise(() => handle.close()),
    ));
    return WorkspaceReview.of({ collect: review });
  }),
);
