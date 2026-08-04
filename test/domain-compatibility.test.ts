import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";
import { OwnedSessionDetailResponse, OwnedSessionListResponse } from "../shared/domain.ts";
import { workflowPhasePrompt } from "../server/runtimes/PiRuntimeSupervisor.ts";

const legacySummary = {
  id: "session-1",
  runtimeId: "runtime-1",
  workspaceId: "workspace-deadbeef",
  name: "Legacy session",
  branch: "main",
  status: "idle",
  pid: 123,
  piSessionId: null,
  sessionFile: null,
  model: null,
  thinkingLevel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
  error: null,
};

const legacySession = {
  ...legacySummary,
  usage: null,
  autoCompactionEnabled: null,
  pendingMessageCount: 0,
  compaction: {
    status: "idle",
    reason: null,
    tokensBefore: null,
    estimatedTokensAfter: null,
    error: null,
    updatedAt: null,
  },
  events: [],
  interactiveRequests: [],
};

test("session responses from the pre-workflow server decode with no active workflow", () => {
  const list = Schema.decodeUnknownSync(OwnedSessionListResponse)({ sessions: [legacySummary] });
  const detail = Schema.decodeUnknownSync(OwnedSessionDetailResponse)({ session: legacySession });

  assert.equal(list.sessions[0]?.workflow, null);
  assert.equal(detail.session.workflow, null);
});

test("legacy active workflows and queued intervention text decode without losing resumable state", () => {
  const detail = Schema.decodeUnknownSync(OwnedSessionDetailResponse)({
    session: {
      ...legacySession,
      status: "stopped",
      workflow: {
        id: "legacy-workflow",
        phase: "building",
        objective: "Resume the legacy approved plan",
        repairAttempts: 0,
        maxRepairAttempts: 2,
        specification: "# Legacy specification",
        plan: "# Legacy plan",
        checkpoint: null,
        blockedFromPhase: null,
        queuedIntervention: "Preserve the legacy operator guidance",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        error: null,
      },
    },
  });

  const workflow = detail.session.workflow!;
  assert.equal(workflow.revision, undefined);
  assert.equal(workflow.guidance, undefined);
  assert.equal(workflow.queuedIntervention, "Preserve the legacy operator guidance");
  assert.match(workflowPhasePrompt(workflow, workflow.queuedIntervention), /Preserve the legacy operator guidance/);
});
