import assert from "node:assert/strict";
import test from "node:test";
import { assistantOutcome, statusFromEntries } from "../extensions/agent-status.ts";

test("classifies completed and interrupted assistant runs", () => {
  assert.equal(assistantOutcome({ role: "assistant", stopReason: "stop" }), "finished");
  assert.equal(assistantOutcome({ role: "assistant", stopReason: "error" }), "blocked");
  assert.equal(assistantOutcome({ role: "assistant", stopReason: "aborted" }), "blocked");
  assert.equal(assistantOutcome({ role: "assistant", stopReason: "toolUse" }), "blocked");
  assert.equal(assistantOutcome({ role: "user" }), undefined);
});

test("restores status from the latest assistant message", () => {
  assert.deepEqual(statusFromEntries([], 10), { status: "idle", changedAt: 10 });
  assert.deepEqual(statusFromEntries([
    { type: "message", message: { role: "assistant", stopReason: "stop", timestamp: 20 } },
    { type: "message", message: { role: "user", timestamp: 30 } },
  ], 10), { status: "finished", changedAt: 20 });
});
