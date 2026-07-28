import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkspaceId, type Workspace } from "../shared/domain.ts";
import { WorkspaceRepository } from "../server/workspaces/WorkspaceRepository.ts";
import { listWorkspaces } from "../server/workspaces/listWorkspaces.ts";

const id = Schema.decodeUnknownSync(WorkspaceId)("piss-deadbeef");
const fixture: Workspace = {
  id,
  name: "PISS",
  root: "/srv/piss",
  trustProjectResources: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  sessionCount: 3,
  activeSessionCount: 1,
};

test("workspace use case depends on a replaceable Effect service", async () => {
  const repository = Layer.succeed(
    WorkspaceRepository,
    WorkspaceRepository.of({
      list: Effect.succeed([fixture]),
      findById: (workspaceId) => Effect.succeed(workspaceId === id ? fixture : undefined),
      ensureCapacity: Effect.void,
      add: () => Effect.die("not used by list use-case test"),
      rename: () => Effect.die("not used by list use-case test"),
      remove: () => Effect.die("not used by list use-case test"),
    }),
  );

  const result = await Effect.runPromise(listWorkspaces.pipe(Effect.provide(repository)));

  assert.deepEqual(result, { workspaces: [fixture] });
});

test("workspace IDs reject values that are unsafe in URLs", () => {
  assert.throws(() => Schema.decodeUnknownSync(WorkspaceId)("../../etc/passwd"));
});
