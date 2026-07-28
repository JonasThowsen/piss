import * as Effect from "effect/Effect";
import type { WorkspaceListResponse } from "../../shared/domain.ts";
import { WorkspaceRepository } from "./WorkspaceRepository.ts";

export const listWorkspaces: Effect.Effect<WorkspaceListResponse, never, WorkspaceRepository> = Effect.gen(
  function* () {
    const repository = yield* WorkspaceRepository;
    const workspaces = yield* repository.list;
    return { workspaces };
  },
);
