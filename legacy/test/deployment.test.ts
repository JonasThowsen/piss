import assert from "node:assert/strict";
import test from "node:test";
import type { OwnedSession } from "../shared/domain.ts";
import { isSessionUpdateSafe } from "../server/runtimes/PiRuntimeSupervisor.ts";

type UpdateProjection = Pick<OwnedSession, "status" | "pendingMessageCount" | "compaction" | "interactiveRequests" | "workflow">;

function session(overrides: Partial<UpdateProjection> = {}): UpdateProjection {
  return {
    status: "idle",
    pendingMessageCount: 0,
    compaction: {
      status: "idle",
      reason: null,
      tokensBefore: null,
      estimatedTokensAfter: null,
      error: null,
      updatedAt: null,
    },
    interactiveRequests: [],
    workflow: null,
    ...overrides,
  };
}

test("an update activates only after every disruptive runtime activity has settled", () => {
  for (const status of ["idle", "finished", "stopped", "crashed"] as const) {
    assert.equal(isSessionUpdateSafe(session({ status })), true, `${status} should permit activation`);
  }
  for (const status of ["starting", "working", "blocked", "stopping"] as const) {
    assert.equal(isSessionUpdateSafe(session({ status })), false, `${status} should defer activation`);
  }

  assert.equal(isSessionUpdateSafe(session({ pendingMessageCount: 1 })), false);
  assert.equal(isSessionUpdateSafe(session({ compaction: { ...session().compaction, status: "running" } })), false);
  assert.equal(isSessionUpdateSafe(session({ workflow: {
    id: "workflow-1", phase: "building", objective: "Build", repairAttempts: 0, maxRepairAttempts: 3,
    specification: "Spec", plan: "Plan", checkpoint: null, blockedFromPhase: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", error: null,
  } })), false);
  assert.equal(isSessionUpdateSafe(session(), 1), false);
});
