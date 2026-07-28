import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceId, WorkspaceName, WorkspaceRoot, type Workspace, type WorkspaceSeed as WorkspaceSeedType } from "../../shared/domain.ts";
import { AppConfig } from "../config.ts";
import { WorkspaceDirectory } from "./WorkspaceDirectory.ts";
import { WorkspaceAlreadyExistsError, WorkspaceManagedByConfigurationError, WorkspaceRecordNotFoundError, WorkspaceStorageError } from "./errors.ts";

const MAX_DYNAMIC_WORKSPACES = 200;
const MAX_STORAGE_BYTES = 1024 * 1024;

export interface AddWorkspaceInput {
  readonly name: string;
  readonly root: string;
  readonly trustProjectResources: boolean;
}

export interface WorkspaceRepositoryShape {
  readonly list: Effect.Effect<ReadonlyArray<Workspace>>;
  readonly findById: (id: WorkspaceId) => Effect.Effect<Workspace | undefined>;
  readonly ensureCapacity: Effect.Effect<void, WorkspaceStorageError>;
  readonly add: (input: AddWorkspaceInput) => Effect.Effect<Workspace, WorkspaceAlreadyExistsError | WorkspaceStorageError>;
  readonly rename: (id: WorkspaceId, name: string) => Effect.Effect<Workspace, WorkspaceRecordNotFoundError | WorkspaceManagedByConfigurationError | WorkspaceStorageError>;
  readonly remove: (id: WorkspaceId) => Effect.Effect<void, WorkspaceRecordNotFoundError | WorkspaceManagedByConfigurationError | WorkspaceStorageError>;
}

export class WorkspaceRepository extends Context.Service<WorkspaceRepository, WorkspaceRepositoryShape>()(
  "@piss/v2/WorkspaceRepository",
) {}

const PersistedWorkspaceSeed = Schema.Struct({
  id: Schema.optional(WorkspaceId),
  name: WorkspaceName,
  root: WorkspaceRoot,
  trustProjectResources: Schema.Boolean,
  createdAt: Schema.optional(Schema.String),
});
type PersistedWorkspaceSeed = typeof PersistedWorkspaceSeed.Type;
type DynamicWorkspaceSeed = WorkspaceSeedType & { readonly id: WorkspaceId; readonly createdAt: string };

const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const decodePersistedWorkspaceSeeds = Schema.decodeUnknownSync(Schema.Array(PersistedWorkspaceSeed));

function workspaceSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "workspace";
}

export function workspaceId(name: string, root: string): WorkspaceId {
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return decodeWorkspaceId(`${workspaceSlug(name)}-${suffix}`);
}

function uniqueWorkspaceId(name: string, root: string, preferred: WorkspaceId | undefined, used: ReadonlySet<WorkspaceId>): WorkspaceId {
  if (preferred && !used.has(preferred)) return preferred;
  const generated = workspaceId(name, root);
  if (!used.has(generated)) return generated;
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 24);
  for (let attempt = 0; attempt < MAX_DYNAMIC_WORKSPACES + 1; attempt += 1) {
    const candidate = decodeWorkspaceId(`${workspaceSlug(name)}-${digest}${attempt === 0 ? "" : `-${attempt}`}`);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique workspace ID");
}

function workspace(seed: WorkspaceSeedType, createdAt: string, id = workspaceId(seed.name, seed.root)): Workspace {
  return {
    id,
    name: seed.name,
    root: seed.root,
    trustProjectResources: seed.trustProjectResources,
    createdAt,
    sessionCount: 0,
    activeSessionCount: 0,
  };
}

async function loadDynamicSeeds(path: string): Promise<ReadonlyArray<PersistedWorkspaceSeed>> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let encoded: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Persisted workspace state must be a regular file");
      const bounded = Buffer.allocUnsafe(MAX_STORAGE_BYTES + 1);
      let total = 0;
      while (total < bounded.length) {
        const { bytesRead } = await handle.read(bounded, total, bounded.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_STORAGE_BYTES) throw new Error("Persisted workspace state exceeds its size limit");
      encoded = bounded.subarray(0, total);
    } finally {
      await handle.close();
    }
    const seeds = decodePersistedWorkspaceSeeds(JSON.parse(encoded.toString("utf8")));
    if (seeds.length > MAX_DYNAMIC_WORKSPACES) throw new Error("Persisted workspace count exceeds its limit");
    if (seeds.some((seed) => !isAbsolute(seed.root))) throw new Error("Persisted workspace roots must be absolute");
    return seeds;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

async function persistSeeds(path: string, seeds: ReadonlyArray<DynamicWorkspaceSeed>): Promise<void> {
  const encoded = `${JSON.stringify(seeds, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw new Error("Persisted workspace state would exceed its size limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const temporaryHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await temporaryHandle.writeFile(encoded, { encoding: "utf8" });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export const WorkspaceRepositoryLive = Layer.effect(
  WorkspaceRepository,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directories = yield* WorkspaceDirectory;
    const storagePath = join(config.stateDir, "workspaces.json");
    const loadedDynamicSeeds = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
        await chmod(config.stateDir, 0o700);
        return loadDynamicSeeds(storagePath);
      },
      catch: (cause) => new WorkspaceStorageError({ message: "Could not load persisted workspaces", cause }),
    });
    const authorizedConfiguredSeeds = yield* Effect.forEach(config.workspaceSeeds, (seed) => directories.authorize(seed.root).pipe(
      Effect.map((root) => ({ ...seed, root })),
      Effect.mapError((cause) => new WorkspaceStorageError({ message: `Configured workspace ${seed.root} is unavailable`, cause })),
    ));
    const configuredSeeds = authorizedConfiguredSeeds.filter((seed, index, seeds) =>
      seeds.findIndex((candidate) => candidate.root === seed.root) === index
    );
    const authorizedDynamicSeeds = yield* Effect.forEach(loadedDynamicSeeds, (seed) => directories.authorize(seed.root).pipe(
      Effect.map((root) => ({ ...seed, root })),
      Effect.mapError((cause) => new WorkspaceStorageError({ message: `Persisted workspace ${seed.root} is no longer authorized`, cause })),
    ));
    const loadedAt = new Date().toISOString();
    const configuredWorkspaceIds = new Set(configuredSeeds.map((seed) => workspaceId(seed.name, seed.root)));
    const usedWorkspaceIds = new Set(configuredWorkspaceIds);
    let workspaceIdsMigrated = false;
    const dynamicSeeds: ReadonlyArray<DynamicWorkspaceSeed> = authorizedDynamicSeeds
      .filter((seed, index, seeds) => seeds.findIndex((candidate) => candidate.root === seed.root) === index)
      .map((seed) => {
        const id = uniqueWorkspaceId(seed.name, seed.root, seed.id, usedWorkspaceIds);
        usedWorkspaceIds.add(id);
        if (seed.id !== id) workspaceIdsMigrated = true;
        return {
          id,
          name: seed.name,
          root: seed.root,
          trustProjectResources: seed.trustProjectResources,
          createdAt: seed.createdAt ?? loadedAt,
        };
      });
    if (workspaceIdsMigrated) {
      yield* Effect.tryPromise({
        try: () => persistSeeds(storagePath, dynamicSeeds),
        catch: (cause) => new WorkspaceStorageError({ message: "Could not persist workspace ID migration", cause }),
      });
    }
    const visibleDynamicSeeds = dynamicSeeds.filter((seed) =>
      !configuredSeeds.some((configured) => configured.root === seed.root)
    );
    const state = yield* Ref.make({
      workspaces: [
        ...configuredSeeds.map((seed) => workspace(seed, loadedAt)),
        ...visibleDynamicSeeds.map((seed) => workspace(seed, seed.createdAt, seed.id)),
      ] as ReadonlyArray<Workspace>,
      dynamicSeeds,
    });
    const lock = yield* Semaphore.make(1);

    const ensureCapacity = Ref.get(state).pipe(
      Effect.flatMap((current) => current.dynamicSeeds.length >= MAX_DYNAMIC_WORKSPACES
        ? Effect.fail(new WorkspaceStorageError({ message: `PISS V2 supports at most ${MAX_DYNAMIC_WORKSPACES} dynamic workspaces` }))
        : Effect.void),
    );

    const add: WorkspaceRepositoryShape["add"] = (input) => lock.withPermit(Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.workspaces.some((candidate) => candidate.root === input.root)) {
        return yield* Effect.fail(new WorkspaceAlreadyExistsError({ path: input.root }));
      }
      if (current.dynamicSeeds.length >= MAX_DYNAMIC_WORKSPACES) {
        return yield* Effect.fail(new WorkspaceStorageError({ message: `PISS V2 supports at most ${MAX_DYNAMIC_WORKSPACES} dynamic workspaces` }));
      }
      const createdAt = new Date().toISOString();
      const usedIds = new Set(current.workspaces.map((candidate) => candidate.id));
      for (const seed of current.dynamicSeeds) usedIds.add(seed.id);
      const seed: DynamicWorkspaceSeed = {
        id: uniqueWorkspaceId(input.name, input.root, undefined, usedIds),
        name: input.name,
        root: input.root,
        trustProjectResources: input.trustProjectResources,
        createdAt,
      };
      const nextWorkspace = workspace(seed, createdAt, seed.id);
      const nextDynamicSeeds = [...current.dynamicSeeds, seed];
      yield* Effect.tryPromise({
        try: () => persistSeeds(storagePath, nextDynamicSeeds),
        catch: (cause) => new WorkspaceStorageError({ message: "Could not persist the workspace", cause }),
      });
      yield* Ref.set(state, {
        workspaces: [...current.workspaces, nextWorkspace],
        dynamicSeeds: nextDynamicSeeds,
      });
      return nextWorkspace;
    }));

    const renameWorkspace: WorkspaceRepositoryShape["rename"] = (id, name) => lock.withPermit(Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const existing = current.workspaces.find((candidate) => candidate.id === id);
      if (!existing) return yield* Effect.fail(new WorkspaceRecordNotFoundError({ workspaceId: id }));
      if (configuredSeeds.some((seed) => seed.root === existing.root)) {
        return yield* Effect.fail(new WorkspaceManagedByConfigurationError({ workspaceId: id }));
      }
      const dynamicIndex = current.dynamicSeeds.findIndex((seed) => seed.id === id);
      if (dynamicIndex < 0) return yield* Effect.fail(new WorkspaceManagedByConfigurationError({ workspaceId: id }));
      const nextDynamicSeeds = current.dynamicSeeds.map((seed) => seed.id === id ? { ...seed, name } : seed);
      yield* Effect.tryPromise({
        try: () => persistSeeds(storagePath, nextDynamicSeeds),
        catch: (cause) => new WorkspaceStorageError({ message: "Could not persist the renamed workspace", cause }),
      });
      const renamed = { ...existing, name };
      yield* Ref.set(state, {
        workspaces: current.workspaces.map((candidate) => candidate.id === id ? renamed : candidate),
        dynamicSeeds: nextDynamicSeeds,
      });
      return renamed;
    }));

    const removeWorkspace: WorkspaceRepositoryShape["remove"] = (id) => lock.withPermit(Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const existing = current.workspaces.find((candidate) => candidate.id === id);
      if (!existing) {
        return yield* Effect.fail(new WorkspaceRecordNotFoundError({ workspaceId: id }));
      }
      if (configuredSeeds.some((seed) => seed.root === existing.root)) {
        return yield* Effect.fail(new WorkspaceManagedByConfigurationError({ workspaceId: id }));
      }
      if (!current.dynamicSeeds.some((seed) => seed.id === id)) {
        return yield* Effect.fail(new WorkspaceManagedByConfigurationError({ workspaceId: id }));
      }
      const nextDynamicSeeds = current.dynamicSeeds.filter((seed) => seed.id !== id);
      yield* Effect.tryPromise({
        try: () => persistSeeds(storagePath, nextDynamicSeeds),
        catch: (cause) => new WorkspaceStorageError({ message: "Could not persist workspace removal", cause }),
      });
      yield* Ref.set(state, {
        workspaces: current.workspaces.filter((candidate) => candidate.id !== id),
        dynamicSeeds: nextDynamicSeeds,
      });
    }));

    return WorkspaceRepository.of({
      list: Ref.get(state).pipe(Effect.map((current) => current.workspaces)),
      findById: (id) => Ref.get(state).pipe(Effect.map((current) => current.workspaces.find((candidate) => candidate.id === id))),
      ensureCapacity,
      add,
      rename: renameWorkspace,
      remove: removeWorkspace,
    });
  }),
);
