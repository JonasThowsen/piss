import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppConfig, type AppConfigShape } from "../server/config.ts";
import { WorkspaceDirectory, WorkspaceDirectoryLive } from "../server/workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepository, WorkspaceRepositoryLive, workspaceId } from "../server/workspaces/WorkspaceRepository.ts";

function config(stateDir: string, roots: ReadonlyArray<string>): AppConfigShape {
  return {
    host: "127.0.0.1",
    port: 4318,
    stateDir,
    publicDir: stateDir,
    piCommand: "pi",
    browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
    workspaceSeeds: [],
    workspaceDiscoveryRoots: roots,
  };
}

test("fuzzy directory discovery stays inside approved real directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-directory-"));
  const root = join(directory, "coding");
  const project = join(root, "alpha-project", "backend");
  const outside = join(directory, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  const live = WorkspaceDirectoryLive.pipe(Layer.provide(Layer.succeed(AppConfig, AppConfig.of(config(directory, [root])))));

  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const directories = yield* WorkspaceDirectory;
      const matches = yield* directories.search("alp back");
      const existing = yield* directories.prepare(project, false);
      const created = yield* directories.prepare(join(root, "alpha-project"), true, "new-app");
      const escaped = yield* directories.prepare(join(root, "escape"), false).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const rejected = yield* directories.prepare(outside, false).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      return { matches, existing, created, escaped, rejected };
    }).pipe(Effect.provide(live)));

    assert.ok(result.matches.some((candidate) => candidate.path === project));
    assert.equal(result.existing, project);
    assert.equal(result.created, join(root, "alpha-project", "new-app"));
    assert.equal(result.escaped, "WorkspacePathError");
    assert.equal(result.rejected, "WorkspacePathError");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("created workspaces persist independently of Nix workspace seeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-workspace-store-"));
  const root = join(directory, "coding");
  const project = join(root, "durable-project");
  await mkdir(project, { recursive: true });
  const appConfig = config(directory, [root]);
  const configLayer = Layer.succeed(AppConfig, AppConfig.of(appConfig));
  const directoryLayer = WorkspaceDirectoryLive.pipe(Layer.provideMerge(configLayer));
  const live = WorkspaceRepositoryLive.pipe(Layer.provideMerge(directoryLayer));

  try {
    const created = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const added = yield* repository.add({ name: "Durable project", root: project, trustProjectResources: true });
      const renamed = yield* repository.rename(added.id, "Renamed project");
      return { added, renamed };
    }).pipe(Effect.provide(live)));
    assert.equal(created.added.root, project);
    assert.equal(created.added.trustProjectResources, true);
    assert.equal(created.renamed.id, created.added.id);
    assert.equal(created.renamed.name, "Renamed project");
    const persisted = JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")) as Array<{ id: string; name: string; root: string }>;
    assert.deepEqual(persisted.map((item) => [item.id, item.name, item.root]), [[created.added.id, "Renamed project", project]]);

    const reloaded = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const beforeRemoval = yield* repository.list;
      yield* repository.remove(created.added.id);
      const afterRemoval = yield* repository.list;
      return { beforeRemoval, afterRemoval };
    }).pipe(Effect.provide(WorkspaceRepositoryLive.pipe(Layer.provide(directoryLayer)))));
    assert.equal(reloaded.beforeRemoval.length, 1);
    assert.equal(reloaded.beforeRemoval[0]?.id, created.added.id);
    assert.equal(reloaded.beforeRemoval[0]?.name, "Renamed project");
    assert.deepEqual(reloaded.afterRemoval, []);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical roots prevent aliases of the same checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-workspace-alias-"));
  const root = join(directory, "coding");
  const project = join(root, "project");
  const second = join(root, "second");
  await mkdir(project, { recursive: true });
  await mkdir(second);
  await writeFile(join(directory, "workspaces.json"), JSON.stringify([
    { name: "Configured", root: project, trustProjectResources: false },
  ]));
  const appConfig = {
    ...config(directory, [root]),
    workspaceSeeds: [
      { name: "Configured", root: `${project}/`, trustProjectResources: false },
      { name: "Configured alias", root: join(project, "..", "project"), trustProjectResources: true },
    ],
  };
  const configLayer = Layer.succeed(AppConfig, AppConfig.of(appConfig));
  const directoryLayer = WorkspaceDirectoryLive.pipe(Layer.provideMerge(configLayer));
  const repositoryLayer = WorkspaceRepositoryLive.pipe(Layer.provideMerge(directoryLayer));

  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const listed = yield* repository.list;
      const duplicate = yield* repository.add({ name: "Alias", root: project, trustProjectResources: false }).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const configuredRename = yield* repository.rename(listed[0]!.id, "Browser rename").pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const configuredRemoval = yield* repository.remove(listed[0]!.id).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      yield* repository.add({ name: "Second", root: second, trustProjectResources: false });
      return { listed, duplicate, configuredRename, configuredRemoval };
    }).pipe(Effect.provide(repositoryLayer)));
    assert.equal(result.listed.length, 1);
    assert.equal(result.listed[0]?.root, project);
    assert.equal(result.duplicate, "WorkspaceAlreadyExistsError");
    assert.equal(result.configuredRename, "WorkspaceManagedByConfigurationError");
    assert.equal(result.configuredRemoval, "WorkspaceManagedByConfigurationError");
    const persisted = JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")) as Array<{ root: string }>;
    assert.deepEqual(persisted.map((seed) => seed.root), [project, second]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted workspace ID collisions are migrated before exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-workspace-id-collision-"));
  const root = join(directory, "coding");
  const configuredRoot = join(root, "configured");
  const dynamicRoot = join(root, "dynamic");
  await mkdir(configuredRoot, { recursive: true });
  await mkdir(dynamicRoot);
  const configuredId = workspaceId("Configured", configuredRoot);
  await writeFile(join(directory, "workspaces.json"), JSON.stringify([
    { id: configuredId, name: "Dynamic", root: dynamicRoot, trustProjectResources: false },
  ]));
  const appConfig = {
    ...config(directory, [root]),
    workspaceSeeds: [{ name: "Configured", root: configuredRoot, trustProjectResources: true }],
  };
  const configLayer = Layer.succeed(AppConfig, AppConfig.of(appConfig));
  const directoryLayer = WorkspaceDirectoryLive.pipe(Layer.provideMerge(configLayer));
  const repositoryLayer = WorkspaceRepositoryLive.pipe(Layer.provideMerge(directoryLayer));

  try {
    const listed = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.list;
    }).pipe(Effect.provide(repositoryLayer)));
    assert.equal(listed.length, 2);
    assert.equal(new Set(listed.map((workspace) => workspace.id)).size, 2);
    assert.equal(listed[0]?.id, configuredId);
    const dynamicId = listed.find((workspace) => workspace.root === dynamicRoot)?.id;
    assert.ok(dynamicId);
    assert.notEqual(dynamicId, configuredId);

    const persisted = JSON.parse(await readFile(join(directory, "workspaces.json"), "utf8")) as Array<{ id: string }>;
    assert.equal(persisted[0]?.id, dynamicId);
    const reloaded = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.list;
    }).pipe(Effect.provide(WorkspaceRepositoryLive.pipe(Layer.provide(directoryLayer)))));
    assert.equal(reloaded.find((workspace) => workspace.root === dynamicRoot)?.id, dynamicId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized persisted workspace state is rejected before decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-workspace-oversized-"));
  const root = join(directory, "coding");
  await mkdir(root);
  await writeFile(join(directory, "workspaces.json"), Buffer.alloc(1024 * 1024 + 1, 0x20));
  const appConfig = config(directory, [root]);
  const configLayer = Layer.succeed(AppConfig, AppConfig.of(appConfig));
  const directoryLayer = WorkspaceDirectoryLive.pipe(Layer.provideMerge(configLayer));
  const repositoryLayer = WorkspaceRepositoryLive.pipe(Layer.provideMerge(directoryLayer));

  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.list;
    }).pipe(
      Effect.provide(repositoryLayer),
      Effect.as("unexpected-success"),
      Effect.catch((error) => Effect.succeed(error._tag)),
    ));
    assert.equal(result, "WorkspaceStorageError");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted workspace state refuses symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-v2-workspace-symlink-state-"));
  const root = join(directory, "coding");
  const outside = join(directory, "outside.json");
  await mkdir(root);
  await writeFile(outside, "[]\n");
  await symlink(outside, join(directory, "workspaces.json"));
  const appConfig = config(directory, [root]);
  const configLayer = Layer.succeed(AppConfig, AppConfig.of(appConfig));
  const directoryLayer = WorkspaceDirectoryLive.pipe(Layer.provideMerge(configLayer));
  const repositoryLayer = WorkspaceRepositoryLive.pipe(Layer.provideMerge(directoryLayer));

  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return yield* repository.list;
    }).pipe(
      Effect.provide(repositoryLayer),
      Effect.as("unexpected-success"),
      Effect.catch((error) => Effect.succeed(error._tag)),
    ));
    assert.equal(result, "WorkspaceStorageError");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
