import assert from "node:assert/strict";
import test from "node:test";
import { fileReviewKey, formatReviewComment, nextDiffSelection, parseUnifiedDiff, readReviewedFiles, reviewedStorageKey, selectedDiffLines, selectionLocation, writeReviewedFiles } from "../web/src/review.ts";

const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 context
-old value
+new value
+another value
 tail`;

test("unified diff lines retain old and new locations", () => {
  const lines = parseUnifiedDiff(patch);
  const removed = lines.find((line) => line.kind === "removed");
  const additions = lines.filter((line) => line.kind === "added");
  assert.deepEqual({ old: removed?.oldLine, new: removed?.newLine }, { old: 11, new: undefined });
  assert.deepEqual(additions.map((line) => ({ old: line.oldLine, new: line.newLine })), [
    { old: undefined, new: 11 },
    { old: undefined, new: 12 },
  ]);

  const selection = selectedDiffLines(lines, { anchor: removed!.index, end: additions[1]!.index });
  assert.equal(selectionLocation("src/example.ts", selection), "src/example.ts (new lines 11-12; old lines 11)");
  assert.match(formatReviewComment("src/example.ts", selection, "Please keep the old behavior."), /^Review comment at src\/example\.ts \(new lines 11-12; old lines 11\):/);
  assert.match(formatReviewComment("src/example.ts", selection, "Please keep the old behavior."), /-old value\n\+new value\n\+another value/);
});

test("tapping one line twice deselects it while a different line extends the range", () => {
  const first = nextDiffSelection(undefined, 4);
  assert.deepEqual(first, { anchor: 4, end: 4 });
  assert.equal(nextDiffSelection(first, 4), undefined);
  assert.deepEqual(nextDiffSelection(first, 7), { anchor: 4, end: 7 });
});

test("reviewed file state is scoped to the exact file change", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const file = { path: "src/example.ts", indexStatus: " ", worktreeStatus: "M", patch, truncated: false, binary: false } as const;
  const key = fileReviewKey(file);
  writeReviewedFiles("session-1", new Set([key]), storage);
  assert.deepEqual(Array.from(readReviewedFiles("session-1", storage)), [key]);
  assert.notEqual(fileReviewKey({ ...file, patch: `${patch}\n+changed again` }), key);
  assert.equal(values.has(reviewedStorageKey("session-1")), true);

  values.set(reviewedStorageKey("session-1"), "not json");
  assert.deepEqual(Array.from(readReviewedFiles("session-1", storage)), []);
  assert.equal(values.has(reviewedStorageKey("session-1")), false);
});
