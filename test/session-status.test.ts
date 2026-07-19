import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "../shared/protocol.ts";
import { BLOCKED_AFTER_MS, FINISHED_FOR_MS, displaySessionStatus } from "../web/src/session-status.ts";

const NOW = 1_000_000;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "session",
    runtimeId: "runtime",
    pid: 1,
    cwd: "/tmp/project",
    state: "idle",
    startedAt: 1,
    lastActivity: NOW,
    ...overrides,
  };
}

test("derives working and blocked states from streaming activity", () => {
  assert.equal(displaySessionStatus(session({ state: "streaming" }), NOW), "working");
  assert.equal(displaySessionStatus(session({ state: "streaming", lastActivity: NOW - BLOCKED_AFTER_MS }), NOW), "blocked");
});

test("keeps failures visible and lets completed work settle back to idle", () => {
  assert.equal(displaySessionStatus(session({ status: "blocked" }), NOW), "blocked");
  assert.equal(displaySessionStatus(session({ status: "finished", statusChangedAt: NOW }), NOW), "finished");
  assert.equal(displaySessionStatus(session({ status: "finished", statusChangedAt: NOW - FINISHED_FOR_MS }), NOW), "idle");
  assert.equal(displaySessionStatus(session({ state: "offline", status: "working" }), NOW), "offline");
});
