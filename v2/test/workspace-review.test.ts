import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainStatus } from "../server/reviews/WorkspaceReview.ts";

test("parses bounded porcelain records without accepting traversal paths", () => {
  assert.deepEqual(
    parsePorcelainStatus(" M src/app.ts\0?? notes.md\0R  src/new.ts\0src/old.ts\0?? ../escape\0!! ignored\0"),
    [
      { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" },
      { path: "notes.md", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/new.ts", indexStatus: "R", worktreeStatus: " " },
    ],
  );
});
