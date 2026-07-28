import { FileFinder, type MixedItem } from "@ff-labs/fff-node";
import type { FileHandle } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { FileMention } from "../../shared/domain.ts";
import { WorkspaceDirectory } from "../workspaces/WorkspaceDirectory.ts";

const MAX_RESULTS = 20;
const MAX_FINDERS = 16;
const SCAN_TIMEOUT_MS = 15_000;

export class FileMentionSearchError extends Data.TaggedError("FileMentionSearchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FileMentionSearchShape {
  readonly search: (
    workspaceRoot: string,
    query: string,
  ) => Effect.Effect<ReadonlyArray<FileMention>, FileMentionSearchError>;
  readonly release: (workspaceRoot: string) => Effect.Effect<void>;
}

export class FileMentionSearch extends Context.Service<FileMentionSearch, FileMentionSearchShape>()(
  "@piss/v2/FileMentionSearch",
) {}

type FinderResource = {
  readonly finder: FileFinder;
  readonly rootHandle: FileHandle;
};

type ManagedFinder = {
  readonly promise: Promise<FinderResource>;
  resource?: FinderResource;
  disposed: boolean;
  lastUsed: number;
};

function validMentionPath(path: string): boolean {
  return path.length > 0 && path.length <= 16 * 1024 && !/[\0\t\r\n"]/.test(path);
}

function mention(item: MixedItem): FileMention | undefined {
  const path = item.item.relativePath;
  if (!validMentionPath(path)) return;
  return item.type === "file"
    ? { path, name: item.item.fileName, kind: "file" }
    : { path, name: item.item.dirName.replace(/\/$/, ""), kind: "directory" };
}

export const FileMentionSearchLive = Layer.effect(
  FileMentionSearch,
  Effect.gen(function* () {
    const directories = yield* WorkspaceDirectory;
    const finders = new Map<string, ManagedFinder>();
    let closed = false;
    let accessSequence = 0;

    const dispose = async (entry: ManagedFinder): Promise<void> => {
      if (entry.disposed) return;
      entry.disposed = true;
      const resource = entry.resource ?? await entry.promise.catch(() => undefined);
      if (!resource) return;
      if (!resource.finder.isDestroyed) resource.finder.destroy();
      await resource.rootHandle.close().catch(() => undefined);
    };

    const finderFor = (workspaceRoot: string): Promise<FileFinder> => {
      const current = finders.get(workspaceRoot);
      if (current) {
        current.lastUsed = ++accessSequence;
        return current.promise.then(({ finder }) => finder);
      }

      if (finders.size >= MAX_FINDERS) {
        const oldest = [...finders.entries()]
          .filter((candidate) => candidate[1].resource !== undefined)
          .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
        if (!oldest) return Promise.reject(new Error("Too many FFF file scans are already starting"));
        finders.delete(oldest[0]);
        void dispose(oldest[1]);
      }

      const entry: ManagedFinder = {
        disposed: false,
        lastUsed: ++accessSequence,
        promise: Promise.resolve().then(async () => {
          const rootHandle = await Effect.runPromise(directories.openAuthorized(workspaceRoot));
          let finder: FileFinder | undefined;
          try {
            const created = FileFinder.create({
              basePath: `/proc/self/fd/${rootHandle.fd}`,
              aiMode: true,
              disableMmapCache: true,
              disableContentIndexing: true,
            });
            if (!created.ok) throw new Error(created.error);
            finder = created.value;
            const scanned = await finder.waitForScan(SCAN_TIMEOUT_MS);
            if (!scanned.ok) throw new Error(scanned.error);
            if (!scanned.value) throw new Error("FFF file scan timed out");
            if (closed || entry.disposed) throw new Error("File mention search is shutting down");
            const resource = { finder, rootHandle };
            entry.resource = resource;
            return resource;
          } catch (cause) {
            if (finder && !finder.isDestroyed) finder.destroy();
            await rootHandle.close().catch(() => undefined);
            throw cause;
          }
        }).catch((cause) => {
          if (finders.get(workspaceRoot) === entry) finders.delete(workspaceRoot);
          throw cause;
        }),
      };

      finders.set(workspaceRoot, entry);
      return entry.promise.then(({ finder }) => finder);
    };

    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      closed = true;
      const active = [...finders.values()];
      finders.clear();
      await Promise.all(active.map(dispose));
    }));

    return FileMentionSearch.of({
      search: (workspaceRoot, query) => Effect.tryPromise({
        try: async () => {
          const finder = await finderFor(workspaceRoot);
          const result = finder.mixedSearch(query, { pageSize: MAX_RESULTS });
          if (!result.ok) throw new Error(result.error);
          return result.value.items.slice(0, MAX_RESULTS).flatMap((item) => {
            const projected = mention(item);
            return projected ? [projected] : [];
          });
        },
        catch: (cause) => new FileMentionSearchError({
          message: "FFF file search is unavailable",
          cause,
        }),
      }),
      release: (workspaceRoot) => Effect.promise(async () => {
        const entry = finders.get(workspaceRoot);
        if (!entry) return;
        finders.delete(workspaceRoot);
        await dispose(entry);
      }),
    });
  }),
);
