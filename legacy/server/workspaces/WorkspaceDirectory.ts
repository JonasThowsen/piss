import { constants } from "node:fs";
import { mkdir, open, opendir, realpath, rmdir, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { DirectoryCandidate } from "../../shared/domain.ts";
import { AppConfig } from "../config.ts";
import { WorkspacePathError } from "./errors.ts";

const MAX_DIRECTORIES = 15_000;
const MAX_DEPTH = 8;
const MAX_RESULTS = 60;
const CACHE_MILLIS = 30_000;
const SCAN_DEADLINE_MILLIS = 5_000;
const IGNORED_DIRECTORIES = new Set([".git", ".direnv", "node_modules", "result", "dist", "dist"]);

type DirectoryError = WorkspacePathError;

export interface WorkspaceDirectoryShape {
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<DirectoryCandidate>, DirectoryError>;
  readonly prepare: (path: string, createDirectory: boolean, directoryName?: string) => Effect.Effect<string, DirectoryError>;
  readonly authorize: (path: string) => Effect.Effect<string, DirectoryError>;
  readonly openAuthorized: (path: string) => Effect.Effect<FileHandle, DirectoryError>;
  readonly rollbackCreated: (path: string) => Effect.Effect<void, DirectoryError>;
}

export class WorkspaceDirectory extends Context.Service<WorkspaceDirectory, WorkspaceDirectoryShape>()(
  "@piss/WorkspaceDirectory",
) {}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function fuzzyScore(query: string, candidate: string): number | undefined {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const value = candidate.toLowerCase();
  let total = 0;
  for (const term of terms) {
    let cursor = 0;
    let previous = -2;
    let score = 0;
    for (const character of term) {
      const index = value.indexOf(character, cursor);
      if (index < 0) return undefined;
      score += index === previous + 1 ? 8 : 2;
      if (index === 0 || value[index - 1] === "/" || value[index - 1] === "-" || value[index - 1] === "_") score += 7;
      previous = index;
      cursor = index + 1;
    }
    if (value.includes(term)) score += 35;
    total += score;
  }
  return total - Math.min(value.length, 240) * 0.04;
}

async function canonicalRoots(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  const roots = await Promise.all(paths.map((path) => realpath(path)));
  return [...new Set(roots)];
}

async function scanRoots(roots: ReadonlyArray<string>): Promise<ReadonlyArray<DirectoryCandidate>> {
  const candidates: DirectoryCandidate[] = roots.map((root) => ({ path: root, root, name: basename(root), relativePath: "." }));
  const queue: Array<{ path: string; root: string; depth: number }> = roots.map((root) => ({ path: root, root, depth: 0 }));
  const deadline = Date.now() + SCAN_DEADLINE_MILLIS;
  while (queue.length > 0 && candidates.length < MAX_DIRECTORIES && Date.now() < deadline) {
    const current = queue.shift();
    if (!current || current.depth >= MAX_DEPTH) continue;
    let handle;
    let directory;
    try {
      handle = await open(current.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isWithin(current.root, canonical)) continue;
      directory = await opendir(`/proc/self/fd/${handle.fd}`);
      for await (const entry of directory) {
        if (candidates.length >= MAX_DIRECTORIES || Date.now() >= deadline) break;
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
        const path = resolve(current.path, entry.name);
        candidates.push({ path, root: current.root, name: entry.name, relativePath: relative(current.root, path) || "." });
        queue.push({ path, root: current.root, depth: current.depth + 1 });
      }
    } catch {
      // Directories can disappear or become unreadable while an index is built.
    } finally {
      await directory?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
    }
  }
  return candidates;
}

function validDirectoryName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

export const WorkspaceDirectoryLive = Layer.effect(
  WorkspaceDirectory,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const discoveryRoots = yield* Effect.tryPromise({
      try: () => canonicalRoots(config.workspaceDiscoveryRoots),
      catch: (cause) => new WorkspacePathError({ path: config.workspaceDiscoveryRoots.join(", "), message: "A workspace discovery root is unavailable", cause }),
    });
    const configuredWorkspaceRoots = yield* Effect.tryPromise({
      try: () => canonicalRoots(config.workspaceSeeds.map((seed) => seed.root)),
      catch: (cause) => new WorkspacePathError({ path: config.workspaceSeeds.map((seed) => seed.root).join(", "), message: "A configured workspace root is unavailable", cause }),
    });
    const scanLock = yield* Semaphore.make(1);
    const searchLock = yield* Semaphore.make(1);
    let cache: { readonly expiresAt: number; readonly candidates: ReadonlyArray<DirectoryCandidate> } | undefined;

    const index = scanLock.withPermit(Effect.suspend(() => {
      if (cache && cache.expiresAt > Date.now()) return Effect.succeed(cache.candidates);
      return Effect.tryPromise({
        try: () => scanRoots(discoveryRoots),
        catch: (cause) => new WorkspacePathError({ path: discoveryRoots.join(", "), message: "Could not scan workspace directories", cause }),
      }).pipe(Effect.tap((candidates) => Effect.sync(() => {
        cache = { candidates, expiresAt: Date.now() + CACHE_MILLIS };
      })));
    }));

    const search: WorkspaceDirectoryShape["search"] = (query) => searchLock.withPermit(index.pipe(
      Effect.map((candidates) => candidates
        .flatMap((candidate) => {
          const score = fuzzyScore(query, `${candidate.name} ${candidate.relativePath}`);
          return score === undefined ? [] : [{ candidate, score }];
        })
        .sort((left, right) => right.score - left.score || left.candidate.relativePath.length - right.candidate.relativePath.length || left.candidate.path.localeCompare(right.candidate.path))
        .slice(0, MAX_RESULTS)
        .map(({ candidate }) => candidate)),
    ));

    const openAuthorized: WorkspaceDirectoryShape["openAuthorized"] = (requestedPath) => Effect.tryPromise({
      try: async () => {
        if (!isAbsolute(requestedPath)) throw new Error("Workspace paths must be absolute");
        const handle = await open(resolve(requestedPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
          const authorized = discoveryRoots.some((root) => isWithin(root, canonical)) || configuredWorkspaceRoots.includes(canonical);
          if (!authorized) throw new Error("Directory is outside the approved workspace roots");
          return handle;
        } catch (cause) {
          await handle.close();
          throw cause;
        }
      },
      catch: (cause) => new WorkspacePathError({ path: requestedPath, message: cause instanceof Error ? cause.message : "Invalid workspace directory", cause }),
    });

    const authorize: WorkspaceDirectoryShape["authorize"] = (requestedPath) => Effect.acquireUseRelease(
      openAuthorized(requestedPath),
      (handle) => Effect.tryPromise({
        try: () => realpath(`/proc/self/fd/${handle.fd}`),
        catch: (cause) => new WorkspacePathError({ path: requestedPath, message: "Could not resolve workspace directory", cause }),
      }),
      (handle) => Effect.promise(() => handle.close()),
    );

    const prepare: WorkspaceDirectoryShape["prepare"] = (requestedPath, createDirectory, directoryName) => {
      if (!createDirectory) return authorize(requestedPath);
      return Effect.tryPromise({
        try: async () => {
          if (!isAbsolute(requestedPath)) throw new Error("Workspace parent paths must be absolute");
          if (!directoryName || !validDirectoryName(directoryName)) throw new Error("Choose one valid new directory name");
          const canonicalParent = await realpath(resolve(requestedPath));
          const allowedRoot = discoveryRoots.find((root) => isWithin(root, canonicalParent));
          if (!allowedRoot) throw new Error("Parent directory is outside the approved workspace roots");
          const parent = await open(canonicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            const stableParent = await realpath(`/proc/self/fd/${parent.fd}`);
            if (!isWithin(allowedRoot, stableParent)) throw new Error("Workspace parent resolves outside the approved root");
            await mkdir(`/proc/self/fd/${parent.fd}/${directoryName}`, { mode: 0o700 });
            const canonical = await realpath(`/proc/self/fd/${parent.fd}/${directoryName}`);
            if (!isWithin(allowedRoot, canonical)) throw new Error("Created directory escaped the approved workspace root");
            cache = undefined;
            return canonical;
          } finally {
            await parent.close();
          }
        },
        catch: (cause) => new WorkspacePathError({ path: requestedPath, message: cause instanceof Error ? cause.message : "Invalid workspace directory", cause }),
      });
    };

    const rollbackCreated: WorkspaceDirectoryShape["rollbackCreated"] = (createdPath) => {
      const name = basename(createdPath);
      const parentPath = resolve(createdPath, "..");
      if (!validDirectoryName(name)) {
        return Effect.fail(new WorkspacePathError({ path: createdPath, message: "Cannot roll back an invalid workspace path" }));
      }
      return Effect.acquireUseRelease(
        openAuthorized(parentPath),
        (parent) => Effect.tryPromise({
          try: () => rmdir(`/proc/self/fd/${parent.fd}/${name}`),
          catch: (cause) => new WorkspacePathError({ path: createdPath, message: "Could not roll back the unregistered workspace directory", cause }),
        }),
        (parent) => Effect.promise(() => parent.close()),
      );
    };

    return WorkspaceDirectory.of({ search, prepare, authorize, openAuthorized, rollbackCreated });
  }),
);
