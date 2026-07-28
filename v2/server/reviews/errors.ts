import * as Data from "effect/Data";

export class WorkspaceReviewError extends Data.TaggedError("WorkspaceReviewError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
