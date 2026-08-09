import * as Data from "effect/Data";
import type { WorkspaceId } from "../../shared/domain.ts";

export class WorkspaceStorageError extends Data.TaggedError("WorkspaceStorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkspacePathError extends Data.TaggedError("WorkspacePathError")<{
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}> {}

export class WorkspaceRecordNotFoundError extends Data.TaggedError("WorkspaceRecordNotFoundError")<{
  readonly workspaceId: WorkspaceId;
}> {
  override get message(): string {
    return `Workspace ${this.workspaceId} does not exist`;
  }
}

export class WorkspaceManagedByConfigurationError extends Data.TaggedError("WorkspaceManagedByConfigurationError")<{
  readonly workspaceId: WorkspaceId;
}> {
  override get message(): string {
    return "This workspace is managed by Nix configuration";
  }
}

export class WorkspaceHasSessionsError extends Data.TaggedError("WorkspaceHasSessionsError")<{
  readonly workspaceId: WorkspaceId;
  readonly sessionCount: number;
}> {
  override get message(): string {
    return `Delete ${this.sessionCount} ${this.sessionCount === 1 ? "session" : "sessions"} before removing this workspace`;
  }
}

export class WorkspaceAlreadyExistsError extends Data.TaggedError("WorkspaceAlreadyExistsError")<{
  readonly path: string;
}> {
  override get message(): string {
    return `A workspace already exists at ${this.path}`;
  }
}
