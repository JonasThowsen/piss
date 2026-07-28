import * as Data from "effect/Data";
import type { WorkspaceId } from "../../shared/domain.ts";

export class WorkspaceNotFoundError extends Data.TaggedError("WorkspaceNotFoundError")<{
  readonly workspaceId: WorkspaceId;
}> {
  override get message(): string {
    return `Workspace ${this.workspaceId} does not exist`;
  }
}

export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionId: string;
}> {
  override get message(): string {
    return `Owned session ${this.sessionId} does not exist`;
  }
}

export class PiSpawnError extends Data.TaggedError("PiSpawnError")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not start Pi with ${this.command}`;
  }
}

export class PiCommandError extends Data.TaggedError("PiCommandError")<{
  readonly sessionId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class StaleRuntimeGenerationError extends Data.TaggedError("StaleRuntimeGenerationError")<{
  readonly sessionId: string;
  readonly expectedRuntimeId: string;
  readonly receivedRuntimeId: string;
}> {
  override get message(): string {
    return `Runtime ${this.receivedRuntimeId} is stale for session ${this.sessionId}`;
  }
}

export class SessionStorageError extends Data.TaggedError("SessionStorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionResumeError extends Data.TaggedError("SessionResumeError")<{
  readonly sessionId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionLimitError extends Data.TaggedError("SessionLimitError")<{
  readonly maximum: number;
}> {
  override get message(): string {
    return `PISS V2 retains at most ${this.maximum} owned sessions`;
  }
}

export class ActiveRuntimeLimitError extends Data.TaggedError("ActiveRuntimeLimitError")<{
  readonly maximum: number;
}> {
  override get message(): string {
    return `PISS V2 runs at most ${this.maximum} simultaneous Pi runtimes`;
  }
}
