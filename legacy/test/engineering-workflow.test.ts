import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as Schema from "effect/Schema";
import { EngineeringWorkflow as EngineeringWorkflowSchema, WORKFLOW_MUTATION_RECEIPT_CAPACITY, WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH, WORKFLOW_SUPERSEDED_REVISION_CAPACITY } from "../shared/domain.ts";
import type { EngineeringWorkflow, EngineeringWorkflowCheckpoint, EngineeringWorkflowDossier, EngineeringWorkflowPhase } from "../shared/domain.ts";
import { activeResearchTools, researchToolAllowed } from "../workflow-resources/researchToolPolicy.ts";
import {
  appendBoundedSupersededRevision,
  appendBoundedWorkflowGuidance,
  applyWorkflowCheckpoint,
  applyWorkflowProgress,
  cancelEngineeringWorkflow,
  cancelEngineeringWorkflowWithReceipt,
  canAutomaticallyAuthorize,
  fallbackWorkflowDossier,
  initialWorkflowProgress,
  isAutonomousWorkflowPhase,
  recordAuthorityDecision,
  recordWorkflowGuidanceDelivery,
  reconcileWorkflowApprovalGuidance,
  workflowBadgePhaseLabel,
  workflowCanRecordMutation,
  workflowCompletionError,
  workflowFirstIncomplete,
  workflowHasActiveCurrentPhaseRun,
  workflowHasCompleteEvidence,
  workflowNeedsApproval,
  workflowUnappliedGuidanceIdsForCurrentPhase,
} from "../shared/engineeringWorkflow.ts";

const startedAt = "2026-04-15T10:00:00.000Z";
let checkpointSequence = 10;

function workflow(phase: EngineeringWorkflow["phase"] = "defining", overrides: Partial<EngineeringWorkflow> = {}): EngineeringWorkflow {
  return {
    id: "workflow-1",
    phase,
    objective: "Add a durable workflow",
    repairAttempts: 0,
    maxRepairAttempts: 2,
    specification: null,
    plan: null,
    checkpoint: null,
    blockedFromPhase: null,
    revision: 0,
    artifactRevision: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
    error: null,
    ...overrides,
  };
}

function checkpoint(stage: EngineeringWorkflowCheckpoint["stage"], outcome: EngineeringWorkflowCheckpoint["outcome"], artifact: string | null = null, additions: Partial<EngineeringWorkflowCheckpoint> = {}): EngineeringWorkflowCheckpoint {
  checkpointSequence += 1;
  return {
    stage,
    outcome,
    summary: `${stage} ${outcome}`,
    artifact,
    toolCallId: `${stage}-tool-${checkpointSequence}`,
    eventId: `${stage}-event-${checkpointSequence}`,
    sequence: checkpointSequence,
    receivedAt: `2026-04-15T10:${String(checkpointSequence).padStart(2, "0")}:00.000Z`,
    ...additions,
  };
}

function dossier(): EngineeringWorkflowDossier {
  return {
    revision: 2,
    criteria: [{ id: "AC1", title: "Durable authority" }, { id: "AC2", title: "Durable progress" }],
    slices: [
      { id: "S1", title: "Authority tracer", criterionIds: ["AC1"], dependencies: [] },
      { id: "S2", title: "Progress restoration", criterionIds: ["AC2"], dependencies: ["S1"] },
    ],
    verificationRequirements: ["Run focused tests"],
    operations: [{ id: "edit-workspace", kind: "workspace_write", target: "shared/", constraints: ["Repository-local writes only"], receiptRequired: true, idempotencyKey: "edit-1", description: "Edit workflow files", recovery: "Targeted rollback", evidence: "Passing tests" }],
    recoveryRequirements: ["Preserve unrelated work"],
    exclusions: ["Production deployment"],
    readiness: [{ id: "repo", label: "Repository", status: "passed", detail: "Ready" }],
    unresolved: [],
  };
}

function running(phase: EngineeringWorkflowPhase = "building", extra: Partial<EngineeringWorkflow> = {}): EngineeringWorkflow {
  const plan = dossier();
  return workflow(phase, {
    specification: "# Specification",
    plan: "# Plan",
    dossier: plan,
    artifactRevision: plan.revision,
    executionAuthority: { mode: "approved_plan", grantedAt: startedAt, planRevision: plan.revision, artifactDigest: "0123456789abcdef" },
    phaseRun: { id: `run-${phase}`, phase, attempt: 0, planRevision: plan.revision, runtimeId: "runtime-1", startedAt },
    progress: initialWorkflowProgress(startedAt, "working", plan),
    ...extra,
  });
}

test("workflow badge labels cover active phases and exclude terminal phases", () => {
  const expected = new Map<EngineeringWorkflowPhase, string>([
    ["defining", "DEFINE"],
    ["awaitingSpecApproval", "SPEC READY"],
    ["researching", "RESEARCH"],
    ["planning", "PLAN"],
    ["awaitingPlanApproval", "PLAN APPROVAL"],
    ["building", "BUILD"],
    ["verifying", "VERIFY"],
    ["reviewing", "REVIEW"],
    ["repairing", "REPAIR"],
    ["blocked", "BLOCKED"],
  ]);
  for (const [phase, label] of expected) assert.equal(workflowBadgePhaseLabel(phase), label);
  for (const phase of ["readyToShip", "accepted", "cancelled", "failed"] as const) assert.equal(workflowBadgePhaseLabel(phase), undefined);
});

test("definition flows directly into planning and only the complete plan needs approval", () => {
  const defined = applyWorkflowCheckpoint(workflow(), checkpoint("define", "ready", "# Specification"));
  assert.equal(defined.phase, "planning");
  assert.equal(defined.specification, "# Specification");
  assert.equal(workflowNeedsApproval(defined.phase), false);

  const planned = applyWorkflowCheckpoint(defined, checkpoint("plan", "ready", "# Complete delivery plan", { dossier: dossier() }));
  assert.equal(planned.phase, "awaitingPlanApproval");
  assert.equal(planned.plan, "# Complete delivery plan");
  assert.equal(planned.dossier?.slices.length, 2);
  assert.equal(planned.dossier?.revision, 1);
  assert.equal(planned.artifactRevision, 1);
  assert.equal(workflowNeedsApproval(planned.phase), true);
});

test("source-pinned research gates Plan and requires an explicit finding handoff", () => {
  const questions = [{ id: "RQ1", prompt: "Which existing implementation should this workflow adapt?", required: true }];
  const defined = applyWorkflowCheckpoint(
    workflow("defining", { researchPolicy: "targeted_external", researchQuestions: [] }),
    checkpoint("define", "ready", "# Specification", { researchQuestions: questions }),
  );
  assert.equal(defined.phase, "researching");
  assert.deepEqual(defined.researchQuestions, questions);

  const missingRevision = {
    policy: "targeted_external" as const,
    questions: [{ id: "RQ1", prompt: questions[0]!.prompt, status: "answered" as const, summary: "Found an implementation", sourceIds: ["SRC1"] }],
    sources: [{ id: "SRC1", kind: "repository" as const, title: "Example", url: "https://github.com/example/project", repository: "example/project", accessedAt: startedAt }],
    findings: [{ id: "F1", questionIds: ["RQ1"], sourceIds: ["SRC1"], confidence: "verified" as const, decision: "adapt" as const, summary: "Adapt its durable artifact boundary" }],
    summary: "One comparable implementation was inspected",
    completedAt: startedAt,
  };
  const rejected = applyWorkflowCheckpoint(defined, checkpoint("research", "ready", "# Research", { researchBrief: missingRevision }));
  assert.equal(rejected.phase, "blocked");
  assert.match(rejected.error ?? "", /immutable commit SHA/i);

  const researchBrief = {
    ...missingRevision,
    sources: [{ ...missingRevision.sources[0]!, revision: "0123456789abcdef0123456789abcdef01234567" }],
  };
  const researched = applyWorkflowCheckpoint(defined, checkpoint("research", "ready", "# Research", { researchBrief }));
  assert.equal(researched.phase, "planning");
  assert.equal(researched.researchBrief?.findings[0]?.id, "F1");

  const omitted = applyWorkflowCheckpoint(researched, checkpoint("plan", "ready", "# Plan", { dossier: dossier() }));
  assert.equal(omitted.phase, "blocked");
  assert.match(omitted.error ?? "", /did not apply required research findings: F1/i);

  const planned = applyWorkflowCheckpoint(researched, checkpoint("plan", "ready", "# Plan", { dossier: dossier(), appliedResearchFindingIds: ["F1"] }));
  assert.equal(planned.phase, "awaitingPlanApproval");
  assert.deepEqual(planned.appliedResearchFindingIds, ["F1"]);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(EngineeringWorkflowSchema)(planned));
});

test("targeted research records unsupported capability while required external coverage blocks", () => {
  const questions = [{ id: "RQ1", prompt: "What does public prior art establish?", required: true }];
  const unsupportedBrief = {
    policy: "targeted_external" as const,
    questions: [{ id: "RQ1", prompt: questions[0]!.prompt, status: "unsupported" as const, summary: "No external research capability is configured", sourceIds: [] }],
    sources: [],
    findings: [],
    summary: "External research capability was unavailable and no evidence was fabricated",
    completedAt: startedAt,
  };
  const targeted = workflow("researching", { researchPolicy: "targeted_external", researchQuestions: questions });
  assert.equal(applyWorkflowCheckpoint(targeted, checkpoint("research", "ready", "# Unsupported", { researchBrief: unsupportedBrief })).phase, "planning");
  const incorrectlyBlockedTargeted = applyWorkflowCheckpoint(targeted, checkpoint("research", "blocked", "Live readiness is unavailable in Research", { researchBrief: unsupportedBrief }));
  assert.equal(incorrectlyBlockedTargeted.phase, "planning");
  assert.equal(incorrectlyBlockedTargeted.error, null);

  const internalReceiptBrief = {
    ...unsupportedBrief,
    questions: [{ id: "RQ1", prompt: questions[0]!.prompt, status: "answered" as const, summary: "A bounded operator observation supplied the missing live fact", sourceIds: ["G07"] }],
    sources: [{ id: "G07", kind: "documentation" as const, title: "Bounded operator observation", url: "piss://workflow/90295f45-707e-4ead-8b47-4446fa6fb83a/guidance/rq-07-2026-08-05T19:07:00+02:00", accessedAt: startedAt }],
    findings: [{ id: "F-G07", questionIds: ["RQ1"], sourceIds: ["G07"], confidence: "verified" as const, decision: "context" as const, summary: "The durable workflow receipt records the bounded observation" }],
  };
  assert.equal(applyWorkflowCheckpoint(targeted, checkpoint("research", "ready", "# Internal receipt", { researchBrief: internalReceiptBrief })).phase, "planning");

  const required = workflow("researching", { researchPolicy: "required_external", researchQuestions: questions });
  const blocked = applyWorkflowCheckpoint(required, checkpoint("research", "ready", "# Unsupported", { researchBrief: { ...unsupportedBrief, policy: "required_external" } }));
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.error ?? "", /lacks external source coverage/i);
  const explicitlyBlocked = applyWorkflowCheckpoint(required, checkpoint("research", "blocked", "Required external coverage is unavailable", { researchBrief: { ...unsupportedBrief, policy: "required_external" } }));
  assert.equal(explicitlyBlocked.phase, "blocked");
});

test("planning stamps the control-plane allocated revision without regression", () => {
  const replanning = running("planning", {
    artifactRevision: 3,
    dossier: { ...dossier(), revision: 2 },
    executionAuthority: undefined,
    phaseRun: { id: "run-replanning", phase: "planning", attempt: 0, planRevision: 3, runtimeId: "runtime-1", startedAt },
  });
  const planned = applyWorkflowCheckpoint(replanning, checkpoint("plan", "ready", "# Revised plan", {
    phaseRunId: "run-replanning",
    planRevision: 3,
    runtimeId: "runtime-1",
    dossier: { ...dossier(), revision: 2 },
  }));
  assert.equal(planned.phase, "awaitingPlanApproval");
  assert.equal(planned.dossier?.revision, 3);
  assert.equal(planned.artifactRevision, 3);
});

test("missing and malformed structured dossiers block before final approval", () => {
  const missing = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan"));
  assert.equal(missing.phase, "blocked");
  assert.match(missing.error ?? "", /dossier/i);

  const malformed = { ...dossier(), slices: [{ id: "S1", title: "Broken", criterionIds: ["UNKNOWN"], dependencies: [] }] };
  const invalid = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: malformed }));
  assert.equal(invalid.phase, "blocked");
  assert.match(invalid.error ?? "", /unknown|covered/i);

  const missingReadiness = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: { ...dossier(), readiness: [] } }));
  assert.equal(missingReadiness.phase, "blocked");
  assert.match(missingReadiness.error ?? "", /readiness/i);
  const duplicateReadiness = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: { ...dossier(), readiness: [dossier().readiness[0]!, dossier().readiness[0]!] } }));
  assert.equal(duplicateReadiness.phase, "blocked");
  assert.match(duplicateReadiness.error ?? "", /readiness result IDs.*unique/i);

  const forwardDependency = { ...dossier(), slices: [dossier().slices[1]!, dossier().slices[0]!] };
  const invalidOrder = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: forwardDependency }));
  assert.equal(invalidOrder.phase, "blocked");
  assert.match(invalidOrder.error ?? "", /delivery order/i);

  const duplicateKey = {
    ...dossier(),
    operations: [
      ...dossier().operations,
      { id: "deploy-one", kind: "deployment" as const, target: "staging-a", idempotencyKey: "deploy-shared", description: "Deploy A", recovery: "Rollback A", evidence: "Receipt A" },
      { id: "deploy-two", kind: "deployment" as const, target: "staging-b", idempotencyKey: "deploy-shared", description: "Deploy B", recovery: "Rollback B", evidence: "Receipt B" },
    ],
  };
  const invalidKeys = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: duplicateKey }));
  assert.equal(invalidKeys.phase, "blocked");
  assert.match(invalidKeys.error ?? "", /idempotency keys.*unique/i);

  const commitWithoutReceipt = { ...dossier(), operations: [...dossier().operations, { id: "commit", kind: "git_commit" as const, target: "repository", description: "Commit", recovery: "Revert", evidence: "Commit ID" }] };
  const invalidCommit = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: commitWithoutReceipt }));
  assert.equal(invalidCommit.phase, "blocked");
  assert.match(invalidCommit.error ?? "", /receipt-required.*idempotency key/i);

  const genericWithoutReceipt = { ...dossier(), operations: [...dossier().operations, { id: "external-command", kind: "command" as const, target: "approved system", receiptRequired: true, description: "Mutate the approved system", recovery: "Restore prior state", evidence: "System record" }] };
  const invalidGeneric = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: genericWithoutReceipt }));
  assert.equal(invalidGeneric.phase, "blocked");
  assert.match(invalidGeneric.error ?? "", /receipt-required.*idempotency key/i);
});

test("unresolved readiness blocks before final approval", () => {
  const blockedDossier = { ...dossier(), unresolved: ["Deployment credential is unavailable"] };
  const result = applyWorkflowCheckpoint(workflow("planning"), checkpoint("plan", "ready", "# Plan", { dossier: blockedDossier }));
  assert.equal(result.phase, "blocked");
  assert.equal(result.blockedFromPhase, "planning");
  assert.match(result.error ?? "", /readiness/i);
});

test("duplicate and out-of-order checkpoints are harmless", () => {
  const buildCheckpoint = checkpoint("build", "passed");
  const first = applyWorkflowCheckpoint(workflow("building"), buildCheckpoint);
  const duplicate = applyWorkflowCheckpoint(first, { ...buildCheckpoint, sequence: buildCheckpoint.sequence + 50 });
  const outOfOrder = applyWorkflowCheckpoint(first, checkpoint("review", "passed"));
  assert.equal(first.phase, "verifying");
  assert.deepEqual(duplicate, first);
  assert.deepEqual(outOfOrder, first);
});

test("progress event IDs remain exact no-ops beyond the former 256-event window", () => {
  let current = running();
  const first = { eventId: "old-progress", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Old activity", currentSliceId: "S1", receivedAt: startedAt };
  current = applyWorkflowProgress(current, first);
  for (let index = 0; index < 300; index += 1) {
    current = applyWorkflowProgress(current, { ...first, eventId: `new-progress-${index}`, activity: `New activity ${index}`, currentSliceId: "S2" });
  }
  const beforeReplay = current;
  const replayed = applyWorkflowProgress(current, first);
  assert.deepEqual(replayed, beforeReplay);
  assert.equal(replayed.progress?.activity, "New activity 299");
  assert.equal(replayed.processedEventIds?.length, 301);
});

test("phase-run event receipt capacity fails closed while reserving its terminal checkpoint", () => {
  const current = running("building", { processedEventIds: Array.from({ length: 4_095 }, (_, index) => `event-${index}`) });
  const rejected = applyWorkflowProgress(current, { eventId: "event-over-capacity", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Must not evict an older receipt", receivedAt: startedAt });
  assert.strictEqual(rejected, current);
  const terminal = applyWorkflowCheckpoint(current, checkpoint("build", "passed", null, { eventId: "terminal-reserved", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1" }));
  assert.equal(terminal.phase, "verifying");
  assert.equal(terminal.processedEventIds?.length, 4_096);
  assert.equal(terminal.processedEventIds?.[0], "event-0");
});

test("worker progress cannot widen the server-owned transient retry budget", () => {
  const current = running();
  const updated = applyWorkflowProgress(current, { eventId: "untrusted-retry-budget", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Reported retry telemetry", retryAttempt: 100, maxTransientRetries: 100, receivedAt: startedAt });
  assert.equal(updated.progress?.retryAttempt, 2);
  assert.equal(updated.progress?.maxTransientRetries, 2);
});

test("cancelled state has terminal precedence over late progress and checkpoints", () => {
  const cancelled = running("cancelled", { revision: 9, progress: { ...initialWorkflowProgress(startedAt), condition: "blocked", activity: "Cancelled", nextAction: "No further action" } });
  const lateProgress = applyWorkflowProgress(cancelled, { eventId: "late-progress", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Must not resume", receivedAt: "2026-04-15T11:00:00.000Z" });
  const lateCheckpoint = applyWorkflowCheckpoint(cancelled, checkpoint("build", "passed", null, { phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1" }));
  assert.deepEqual(lateProgress, cancelled);
  assert.deepEqual(lateCheckpoint, cancelled);
});

test("cancel wins a serialized race with guidance delivery, progress, and checkpoint events", () => {
  const current = running("building", {
    guidance: [{ id: "guide-race", text: "Do not lose me", status: "queued", planRevision: 2, submittedRuntimeId: "runtime-1", commandId: "guide-command-race", submittedAt: startedAt, deliveredAt: null, appliedAt: null }],
  });
  const cancelled = cancelEngineeringWorkflow(current, "2026-04-15T10:01:00.000Z");
  const delivered = recordWorkflowGuidanceDelivery(cancelled, { eventId: "delivery-after-cancel", guidanceId: "guide-race", commandId: "guide-command-race", planRevision: 2, deliveredAt: "2026-04-15T10:01:01.000Z" });
  const progressed = applyWorkflowProgress(cancelled, { eventId: "progress-after-cancel", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "late", appliedGuidanceIds: ["guide-race"], receivedAt: "2026-04-15T10:01:02.000Z" });
  const checkpointed = applyWorkflowCheckpoint(cancelled, checkpoint("build", "passed", null, { phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1" }));
  assert.deepEqual(delivered, cancelled);
  assert.deepEqual(progressed, cancelled);
  assert.deepEqual(checkpointed, cancelled);
  assert.equal(cancelled.guidance?.[0]?.status, "queued");
});

test("guidance delivery and first-incomplete derivation are deterministic", () => {
  const current = running("building", {
    guidance: [{ id: "guide-1", text: "Resume safely", status: "queued", planRevision: 2, submittedRuntimeId: "runtime-1", commandId: "guide-command", submittedAt: startedAt, deliveredAt: null, appliedAt: null }],
    progress: {
      ...initialWorkflowProgress(startedAt, "working", dossier()),
      completedSliceIds: ["S1"],
      passedCriterionIds: ["AC1"],
      evidence: [{ criterionId: "AC1", summary: "Authority evidence" }],
    },
  });
  const event = { eventId: "guidance-delivery", guidanceId: "guide-1", commandId: "guide-command", planRevision: 2, deliveredAt: "2026-04-15T10:02:00.000Z" };
  const delivered = recordWorkflowGuidanceDelivery(current, event);
  assert.equal(delivered.guidance?.[0]?.status, "delivered");
  assert.deepEqual(recordWorkflowGuidanceDelivery(delivered, event), delivered);
  assert.deepEqual(workflowFirstIncomplete(delivered), { sliceId: "S2", criterionId: "AC2" });
});

test("checkpoints cannot skip guidance delivery and capacity never evicts unresolved guidance", () => {
  const queued = running("building", {
    guidance: [{ id: "guide-checkpoint", text: "Apply after delivery", status: "queued", planRevision: 2, submittedRuntimeId: "runtime-1", commandId: "guide-checkpoint-command", submittedAt: startedAt, deliveredAt: null, appliedAt: null }],
  });
  const checkpointWithQueuedGuidance = checkpoint("build", "passed", null, { phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", appliedGuidanceIds: ["guide-checkpoint"] });
  assert.strictEqual(applyWorkflowCheckpoint(queued, checkpointWithQueuedGuidance), queued);
  assert.strictEqual(applyWorkflowCheckpoint(queued, { ...checkpointWithQueuedGuidance, eventId: "unknown-guidance-checkpoint", toolCallId: "unknown-guidance-checkpoint", appliedGuidanceIds: ["unknown-guidance"] }), queued);

  const delivered = recordWorkflowGuidanceDelivery(queued, { eventId: "deliver-checkpoint-guidance", guidanceId: "guide-checkpoint", commandId: "guide-checkpoint-command", planRevision: 2, deliveredAt: startedAt });
  const checkpointAfterDelivery = applyWorkflowCheckpoint(delivered, { ...checkpointWithQueuedGuidance, eventId: "checkpoint-after-delivery", toolCallId: "checkpoint-after-delivery" });
  assert.equal(checkpointAfterDelivery.phase, "verifying");
  assert.equal(checkpointAfterDelivery.guidance?.[0]?.status, "applied");

  const unresolved = Array.from({ length: 64 }, (_, index) => ({
    id: `queued-${index}`,
    text: `Queued ${index}`,
    status: "queued" as const,
    planRevision: 2,
    submittedRuntimeId: "runtime-1",
    commandId: `queued-command-${index}`,
    submittedAt: startedAt,
    deliveredAt: null,
    appliedAt: null,
  }));
  const additional = { ...unresolved[0]!, id: "queued-64", commandId: "queued-command-64" };
  assert.equal(appendBoundedWorkflowGuidance(unresolved, additional), null);
  const withApplied = [{ ...unresolved[0]!, status: "applied" as const, deliveredAt: startedAt, appliedAt: startedAt }, ...unresolved.slice(1)];
  assert.equal(appendBoundedWorkflowGuidance(withApplied, additional), null);
  assert.equal(withApplied.length, 64);
  assert.equal(withApplied[0]?.id, "queued-0");
});

test("replacement Plan requires exact guidance acknowledgement before approval", () => {
  const plan = dossier();
  const planning = workflow("planning", {
    specification: "# Revised specification",
    plan: "# Prior plan",
    dossier: plan,
    artifactRevision: 3,
    phaseRun: { id: "run-planning-3", phase: "planning", attempt: 0, planRevision: 3, runtimeId: "runtime-1", startedAt },
    progress: initialWorkflowProgress(startedAt, "working", plan),
    guidance: [{ id: "scope-current", text: "Add the new scope constraint", status: "delivered", planRevision: 3, submittedRuntimeId: "runtime-1", commandId: "scope-current-command", submittedAt: startedAt, deliveredAt: startedAt, appliedAt: null }],
    processedEventIds: [],
  });
  const ready = checkpoint("plan", "ready", "# Replacement plan", { dossier: plan, phaseRunId: "run-planning-3", planRevision: 3, runtimeId: "runtime-1" });

  const omitted = applyWorkflowCheckpoint(planning, ready);
  assert.equal(omitted.phase, "blocked");
  assert.equal(omitted.guidance?.[0]?.status, "delivered");
  assert.match(omitted.error ?? "", /scope-current/);

  const acknowledged = applyWorkflowCheckpoint(planning, { ...ready, eventId: "plan-with-scope-guidance", toolCallId: "plan-with-scope-guidance", appliedGuidanceIds: ["scope-current"] });
  assert.equal(acknowledged.phase, "awaitingPlanApproval");
  assert.equal(acknowledged.guidance?.[0]?.status, "applied");
});

test("persisted approval gates return to Plan for current, explicit carry, and legacy guidance", () => {
  const plan = dossier();
  const approval = workflow("awaitingPlanApproval", {
    specification: "# Revised specification",
    plan: "# Persisted replacement plan",
    dossier: plan,
    artifactRevision: 3,
    executionAuthority: { mode: "approved_plan", grantedAt: startedAt, planRevision: 3, artifactDigest: "stale-digest" },
    progress: initialWorkflowProgress(startedAt, "waiting_user", plan),
    guidance: [
      { id: "current-scope", text: "Current scope", status: "delivered", planRevision: 3, submittedRuntimeId: "runtime-old", commandId: "current-command", submittedAt: startedAt, deliveredAt: startedAt, appliedAt: null },
      { id: "explicit-carry", text: "Explicit carry", status: "delivered", planRevision: 2, applicationPlanRevision: 3, submittedRuntimeId: "runtime-old", commandId: "explicit-command", submittedAt: startedAt, deliveredAt: startedAt, appliedAt: null },
      { id: "legacy-carry", text: "Legacy carry", status: "delivered", planRevision: 1, submittedRuntimeId: "runtime-old", commandId: "legacy-command", submittedAt: startedAt, deliveredAt: startedAt, appliedAt: null },
    ],
  });

  assert.deepEqual(workflowUnappliedGuidanceIdsForCurrentPhase(approval), ["current-scope", "explicit-carry", "legacy-carry"]);
  const reconciled = reconcileWorkflowApprovalGuidance(approval, "2026-04-15T10:05:00.000Z");
  assert.equal(reconciled.phase, "planning");
  assert.equal(reconciled.executionAuthority, undefined);
  assert.equal(reconciled.phaseRun, undefined);
  assert.equal(reconciled.artifactRevision, 3);
  assert.match(reconciled.progress?.nextAction ?? "", /current-scope, explicit-carry, legacy-carry/);

  const planning = {
    ...reconciled,
    phaseRun: { id: "run-recovered-plan", phase: "planning" as const, attempt: 0, planRevision: 3, runtimeId: "runtime-new", startedAt },
    processedEventIds: [],
  };
  const acknowledged = applyWorkflowCheckpoint(planning, checkpoint("plan", "ready", "# Corrected replacement plan", {
    dossier: plan,
    phaseRunId: "run-recovered-plan",
    planRevision: 3,
    runtimeId: "runtime-new",
    appliedGuidanceIds: ["current-scope", "explicit-carry", "legacy-carry"],
  }));
  assert.equal(acknowledged.phase, "awaitingPlanApproval");
  assert.deepEqual(acknowledged.guidance?.map((item) => item.status), ["applied", "applied", "applied"]);
  assert.deepEqual(workflowUnappliedGuidanceIdsForCurrentPhase({ ...acknowledged, phase: "building" }), []);
});

test("maximum guidance IDs reconcile to schema-bounded progress and still require exact acknowledgement", () => {
  const plan = dossier();
  const guidance = Array.from({ length: 64 }, (_, index) => {
    const prefix = `max-${String(index).padStart(2, "0")}-`;
    const id = `${prefix}${"x".repeat(128 - prefix.length)}`;
    assert.equal(id.length, 128);
    return {
      id,
      text: `Maximum guidance ${index}`,
      status: "delivered" as const,
      planRevision: 3,
      submittedRuntimeId: "runtime-old",
      commandId: `max-command-${index}`,
      submittedAt: startedAt,
      deliveredAt: startedAt,
      appliedAt: null,
    };
  });
  const approval = workflow("awaitingPlanApproval", {
    specification: "# Revised specification",
    plan: "# Persisted maximum plan",
    dossier: plan,
    artifactRevision: 3,
    executionAuthority: { mode: "approved_plan", grantedAt: startedAt, planRevision: 3, artifactDigest: "stale-maximum-digest" },
    progress: initialWorkflowProgress(startedAt, "waiting_user", plan),
    guidance,
  });

  const reconciled = reconcileWorkflowApprovalGuidance(approval, "2026-04-15T10:06:00.000Z");
  assert.equal(reconciled.phase, "planning");
  assert.equal(reconciled.guidance?.length, 64);
  assert.ok((reconciled.progress?.nextAction.length ?? Infinity) <= WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH);
  assert.match(reconciled.progress?.nextAction ?? "", /64 guidance items/);
  assert.match(reconciled.progress?.nextAction ?? "", /\+56 more/);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(EngineeringWorkflowSchema)(reconciled));

  const planning = {
    ...reconciled,
    phaseRun: { id: "run-maximum-plan", phase: "planning" as const, attempt: 0, planRevision: 3, runtimeId: "runtime-new", startedAt },
    processedEventIds: [],
  };
  const ready = checkpoint("plan", "ready", "# Corrected maximum plan", {
    dossier: plan,
    phaseRunId: "run-maximum-plan",
    planRevision: 3,
    runtimeId: "runtime-new",
  });
  const omitted = applyWorkflowCheckpoint(planning, ready);
  assert.equal(omitted.phase, "blocked");
  assert.equal(omitted.guidance?.filter((item) => item.status !== "applied").length, 64);

  const acknowledged = applyWorkflowCheckpoint(planning, {
    ...ready,
    eventId: "maximum-plan-acknowledged",
    toolCallId: "maximum-plan-acknowledged",
    appliedGuidanceIds: guidance.map((item) => item.id),
  });
  assert.equal(acknowledged.phase, "awaitingPlanApproval");
  assert.equal(acknowledged.guidance?.filter((item) => item.status === "applied").length, 64);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(EngineeringWorkflowSchema)(acknowledged));
});

test("replacement Plan alone can consume immutable prior-revision carry-forward guidance", () => {
  const plan = dossier();
  let planning = workflow("planning", {
    specification: "# Revised specification",
    plan: "# Prior plan",
    dossier: plan,
    artifactRevision: 3,
    phaseRun: { id: "run-carry-forward", phase: "planning", attempt: 0, planRevision: 3, runtimeId: "runtime-1", startedAt },
    progress: initialWorkflowProgress(startedAt, "working", plan),
    guidance: [
      { id: "prior-queued", text: "Preserve queued guidance", status: "queued", planRevision: 2, applicationPlanRevision: 3, submittedRuntimeId: "runtime-1", commandId: "prior-queued-command", submittedAt: startedAt, deliveredAt: null, appliedAt: null },
      { id: "scope-current", text: "Apply the scope revision", status: "queued", planRevision: 3, submittedRuntimeId: "runtime-1", commandId: "scope-current-command", submittedAt: startedAt, deliveredAt: null, appliedAt: null },
    ],
    processedEventIds: [],
  });
  planning = recordWorkflowGuidanceDelivery(planning, { eventId: "deliver-prior-queued", guidanceId: "prior-queued", commandId: "prior-queued-command", planRevision: 2, deliveredAt: startedAt });
  planning = recordWorkflowGuidanceDelivery(planning, { eventId: "deliver-current-scope", guidanceId: "scope-current", commandId: "scope-current-command", planRevision: 3, deliveredAt: startedAt });

  const applied = applyWorkflowCheckpoint(planning, checkpoint("plan", "ready", "# Carried replacement plan", {
    dossier: plan,
    phaseRunId: "run-carry-forward",
    planRevision: 3,
    runtimeId: "runtime-1",
    appliedGuidanceIds: ["prior-queued", "scope-current"],
  }));
  assert.equal(applied.phase, "awaitingPlanApproval");
  assert.deepEqual(applied.guidance?.map((item) => item.status), ["applied", "applied"]);
  assert.equal(applied.guidance?.[0]?.planRevision, 2, "the immutable submission revision is retained");
  assert.equal(applied.guidance?.[0]?.applicationPlanRevision, 3);

  const staleAutonomous = running("building", {
    artifactRevision: 3,
    executionAuthority: { mode: "approved_plan", grantedAt: startedAt, planRevision: 3, artifactDigest: "0123456789abcdef" },
    phaseRun: { id: "run-building-3", phase: "building", attempt: 0, planRevision: 3, runtimeId: "runtime-1", startedAt },
    guidance: [{ ...planning.guidance![0]!, status: "delivered", appliedAt: null }],
  });
  const staleAcknowledgement = applyWorkflowProgress(staleAutonomous, {
    eventId: "stale-carry-forward-ack",
    phaseRunId: "run-building-3",
    planRevision: 3,
    runtimeId: "runtime-1",
    activity: "Must not apply stale carry-forward guidance",
    appliedGuidanceIds: ["prior-queued"],
    receivedAt: startedAt,
  });
  assert.strictEqual(staleAcknowledgement, staleAutonomous);
});

test("full mutation receipt capacity preserves immediate idempotent cancellation", () => {
  const atCapacity = running("building", {
    processedMutationIds: Array.from({ length: WORKFLOW_MUTATION_RECEIPT_CAPACITY }, (_, index) => `mutation-${index}`),
  });
  assert.equal(workflowCanRecordMutation(atCapacity), false);
  assert.equal(workflowCanRecordMutation(atCapacity, true), true);
  const cancelled = cancelEngineeringWorkflowWithReceipt(atCapacity, "cancel-at-capacity", "2026-04-15T10:10:00.000Z");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.cancellationMutationId, "cancel-at-capacity");
  assert.equal(cancelled.processedMutationIds?.length, WORKFLOW_MUTATION_RECEIPT_CAPACITY);
  assert.strictEqual(cancelEngineeringWorkflowWithReceipt(cancelled, "cancel-at-capacity", "2026-04-15T10:11:00.000Z"), cancelled);
  assert.strictEqual(applyWorkflowProgress(cancelled, { eventId: "late-after-capacity-cancel", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "late", receivedAt: startedAt }), cancelled);
  assert.strictEqual(applyWorkflowCheckpoint(cancelled, checkpoint("build", "passed", null, { phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1" })), cancelled);
});

test("superseded evidence capacity fails closed without evicting the oldest revision", () => {
  const revisions = Array.from({ length: WORKFLOW_SUPERSEDED_REVISION_CAPACITY }, (_, index) => ({
    planRevision: index + 1,
    completedSliceIds: [`slice-${index + 1}`],
    passedCriterionIds: [`criterion-${index + 1}`],
    evidence: [{ criterionId: `criterion-${index + 1}`, summary: `evidence-${index + 1}` }],
    supersededAt: startedAt,
    reason: `scope-${index + 1}`,
  }));
  const additional = {
    planRevision: WORKFLOW_SUPERSEDED_REVISION_CAPACITY + 1,
    completedSliceIds: ["slice-overflow"],
    passedCriterionIds: ["criterion-overflow"],
    evidence: [{ criterionId: "criterion-overflow", summary: "must not replace retained evidence" }],
    supersededAt: startedAt,
    reason: "overflow",
  };

  assert.equal(appendBoundedSupersededRevision(revisions, additional), null);
  assert.equal(revisions.length, WORKFLOW_SUPERSEDED_REVISION_CAPACITY);
  assert.equal(revisions[0]?.evidence[0]?.summary, "evidence-1");
});

test("stale phase-run progress and checkpoints cannot mutate a replacement run", () => {
  const current = running();
  const staleProgress = applyWorkflowProgress(current, {
    eventId: "stale-progress",
    phaseRunId: "old-run",
    planRevision: 2,
    runtimeId: "runtime-1",
    activity: "Must not apply",
    receivedAt: "2026-04-15T11:00:00.000Z",
  });
  const staleCheckpoint = applyWorkflowCheckpoint(current, checkpoint("build", "passed", null, { phaseRunId: "old-run", planRevision: 2, runtimeId: "runtime-1" }));
  const unidentifiedProgress = applyWorkflowProgress(current, { eventId: "missing-run-identity", activity: "Must not apply", receivedAt: startedAt });
  const unidentifiedCheckpoint = applyWorkflowCheckpoint(current, checkpoint("build", "passed"));
  assert.deepEqual(staleProgress, current);
  assert.deepEqual(staleCheckpoint, current);
  assert.deepEqual(unidentifiedProgress, current);
  assert.deepEqual(unidentifiedCheckpoint, current);
});

test("completed phase runs and absent runs reject delayed structured events", () => {
  const building = running("building");
  const verifying = applyWorkflowCheckpoint(building, checkpoint("build", "passed", null, { phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1" }));
  const lateBuildProgress = applyWorkflowProgress(verifying, { eventId: "late-build-progress", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Must not enter Verify", completedSliceIds: ["S1"], receivedAt: startedAt });
  assert.equal(verifying.phase, "verifying");
  assert.equal(workflowHasActiveCurrentPhaseRun(verifying), false);
  assert.strictEqual(lateBuildProgress, verifying);

  const replanning = { ...building, phase: "planning" as const, phaseRun: undefined, artifactRevision: 3 };
  const lateScopeProgress = applyWorkflowProgress(replanning, { eventId: "late-scope-progress", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Must not enter replanning", completedSliceIds: ["S1"], receivedAt: startedAt });
  assert.strictEqual(lateScopeProgress, replanning);

  assert.equal(workflowHasActiveCurrentPhaseRun(replanning), false);
  assert.equal(workflowHasActiveCurrentPhaseRun(building), true);

  const legacy = workflow("building", { progress: initialWorkflowProgress(startedAt) });
  const identityFree = applyWorkflowProgress(legacy, { eventId: "legacy-progress", activity: "Compatible legacy progress", receivedAt: startedAt });
  assert.equal(identityFree.progress?.activity, "Compatible legacy progress");
});

test("structured progress rejects IDs outside the approved dossier", () => {
  const current = running();
  const invalid = applyWorkflowProgress(current, {
    eventId: "unknown-progress-ids",
    phaseRunId: "run-building",
    planRevision: 2,
    runtimeId: "runtime-1",
    activity: "Invalid progress",
    currentSliceId: "S-UNKNOWN",
    completedSliceIds: ["S-UNKNOWN"],
    passedCriterionIds: ["AC-UNKNOWN"],
    evidence: [{ criterionId: "AC-UNKNOWN", summary: "Not approved" }],
    receivedAt: startedAt,
  });
  assert.strictEqual(invalid, current);
});

test("structured progress accumulates slices, evidence, guidance application, and receipts idempotently", () => {
  const current = running("building", {
    guidance: [{ id: "guide-1", text: "Keep it narrow", status: "delivered", planRevision: 2, submittedRuntimeId: "runtime-1", commandId: "guide-command", submittedAt: startedAt, deliveredAt: startedAt, appliedAt: null }],
    operationReceipts: [{ operationId: "edit-workspace", idempotencyKey: "edit-1", status: "started", target: "shared/", evidence: null, updatedAt: startedAt }],
  });
  const event = {
    eventId: "progress-1",
    phaseRunId: "run-building",
    planRevision: 2,
    runtimeId: "runtime-1",
    activity: "Completed authority tracer",
    currentSliceId: "S2",
    completedSliceIds: ["S1"],
    passedCriterionIds: ["AC1"],
    evidence: [{ criterionId: "AC1", summary: "Authority tests passed" }],
    appliedGuidanceIds: ["guide-1"],
    receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "completed" as const, target: "shared/", evidence: "tests", updatedAt: startedAt },
    receivedAt: "2026-04-15T11:00:00.000Z",
  };
  const updated = applyWorkflowProgress(current, event);
  const duplicate = applyWorkflowProgress(updated, { ...event, activity: "Duplicate must not replace" });
  assert.deepEqual(updated.progress?.completedSliceIds, ["S1"]);
  assert.equal(updated.guidance?.[0]?.status, "applied");
  assert.equal(updated.operationReceipts?.[0]?.status, "completed");
  assert.deepEqual(duplicate, updated);
  const lateStarted = applyWorkflowProgress(updated, {
    ...event,
    eventId: "progress-receipt-late-start",
    activity: "Late receipt must not regress completion",
    receipt: { ...event.receipt, status: "started" as const, evidence: null },
  });
  const changedIdentity = applyWorkflowProgress(updated, {
    ...event,
    eventId: "progress-receipt-changed-identity",
    activity: "Changed receipt identity must not replace completion",
    receipt: { ...event.receipt, operationId: "different-operation", target: "other/" },
  });
  assert.deepEqual(lateStarted.operationReceipts, updated.operationReceipts);
  assert.deepEqual(changedIdentity.operationReceipts, updated.operationReceipts);
});

test("operation receipts advance monotonically and allow reconciled completion", () => {
  const current = running("building", { operationReceipts: [{ operationId: "edit-workspace", idempotencyKey: "edit-1", status: "planned", target: "shared/", evidence: null, updatedAt: startedAt }] });
  const started = applyWorkflowProgress(current, { eventId: "receipt-started", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Starting operation", receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "started", target: "shared/", evidence: null, updatedAt: startedAt }, receivedAt: startedAt });
  const reconciliation = applyWorkflowProgress(started, { eventId: "receipt-reconciliation", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Reconcile operation", receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "reconciliation_required", target: "shared/", evidence: "system check required", updatedAt: startedAt }, receivedAt: startedAt });
  const completed = applyWorkflowProgress(reconciliation, { eventId: "receipt-completed", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Operation reconciled", receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "completed", target: "shared/", evidence: "system check passed", updatedAt: startedAt }, receivedAt: startedAt });
  assert.equal(started.operationReceipts?.[0]?.status, "started");
  assert.equal(reconciliation.operationReceipts?.[0]?.status, "reconciliation_required");
  assert.equal(completed.operationReceipts?.[0]?.status, "completed");
});

test("destructive receipts require a durable started boundary before completion", () => {
  const plan = { ...dossier(), operations: [...dossier().operations, { id: "deploy-staging", kind: "deployment" as const, target: "staging", constraints: ["idempotency key required"], idempotencyKey: "deploy-once", description: "Deploy staging", recovery: "Rollback staging", evidence: "Deployment record" }] };
  const current = running("building", { dossier: plan });
  const receiptEvent = (eventId: string, status: "planned" | "started" | "completed" | "reconciliation_required") => ({
    eventId,
    phaseRunId: "run-building",
    planRevision: 2,
    runtimeId: "runtime-1",
    activity: `Deployment ${status}`,
    ...(status === "completed" ? { completedSliceIds: ["S1"], passedCriterionIds: ["AC1"], evidence: [{ criterionId: "AC1", summary: "Claimed deployment evidence" }] } : {}),
    receipt: { operationId: "deploy-staging", idempotencyKey: "deploy-once", status, target: "staging", evidence: status === "completed" ? "deployment record" : null, updatedAt: startedAt },
    receivedAt: startedAt,
  });
  const completionWithoutStart = applyWorkflowProgress(current, receiptEvent("deploy-complete-too-early", "completed"));
  const reconciliationWithoutStart = applyWorkflowProgress(current, receiptEvent("deploy-reconcile-too-early", "reconciliation_required"));
  const planned = applyWorkflowProgress(current, receiptEvent("deploy-planned", "planned"));
  const completionAfterPlanOnly = applyWorkflowProgress(planned, receiptEvent("deploy-complete-after-plan", "completed"));
  const started = applyWorkflowProgress(planned, receiptEvent("deploy-started", "started"));
  const completed = applyWorkflowProgress(started, receiptEvent("deploy-completed", "completed"));
  assert.strictEqual(completionWithoutStart, current);
  assert.strictEqual(reconciliationWithoutStart, current);
  assert.strictEqual(completionAfterPlanOnly, planned);
  assert.equal(started.operationReceipts?.[0]?.status, "started");
  assert.equal(completed.operationReceipts?.[0]?.status, "completed");
});

test("receipt capacity retains every operation allowed by a maximum-size dossier", () => {
  const extraOperations = Array.from({ length: 199 }, (_, index) => ({
    id: `deploy-${index}`,
    kind: "deployment" as const,
    target: `staging-${index}`,
    idempotencyKey: `deploy-key-${index}`,
    description: `Deploy ${index}`,
    recovery: `Rollback ${index}`,
    evidence: `Receipt ${index}`,
  }));
  const plan = { ...dossier(), operations: [...dossier().operations, ...extraOperations] };
  let current = running("building", { dossier: plan });
  current = applyWorkflowProgress(current, { eventId: "capacity-workspace-start", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Starting workspace operation", receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "started", target: "shared/", evidence: null, updatedAt: startedAt }, receivedAt: startedAt });
  current = applyWorkflowProgress(current, { eventId: "capacity-workspace-complete", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", activity: "Completed workspace operation", receipt: { operationId: "edit-workspace", idempotencyKey: "edit-1", status: "completed", target: "shared/", evidence: "workspace record", updatedAt: startedAt }, receivedAt: startedAt });
  for (const [index, operation] of extraOperations.entries()) {
    current = applyWorkflowProgress(current, {
      eventId: `capacity-start-${index}`,
      phaseRunId: "run-building",
      planRevision: 2,
      runtimeId: "runtime-1",
      activity: `Starting ${operation.id}`,
      receipt: { operationId: operation.id, idempotencyKey: operation.idempotencyKey, status: "started", target: operation.target, evidence: null, updatedAt: startedAt },
      receivedAt: startedAt,
    });
    current = applyWorkflowProgress(current, {
      eventId: `capacity-complete-${index}`,
      phaseRunId: "run-building",
      planRevision: 2,
      runtimeId: "runtime-1",
      activity: `Completed ${operation.id}`,
      receipt: { operationId: operation.id, idempotencyKey: operation.idempotencyKey, status: "completed", target: operation.target, evidence: `receipt-${index}`, updatedAt: startedAt },
      receivedAt: startedAt,
    });
  }
  assert.equal(current.operationReceipts?.length, 200);
  assert.equal(current.operationReceipts?.[0]?.operationId, "edit-workspace");
  assert.equal(current.operationReceipts?.at(-1)?.operationId, "deploy-198");
});

test("alternate receipt keys cannot evict a completed destructive operation", () => {
  const deployment = { id: "deploy-staging", kind: "deployment" as const, target: "staging", constraints: [], idempotencyKey: "deploy-once", description: "Deploy", recovery: "Rollback", evidence: "Deployment record" };
  const plan = { ...dossier(), operations: [...dossier().operations, deployment] };
  let current = running("building", {
    dossier: plan,
    operationReceipts: [{ operationId: deployment.id, idempotencyKey: deployment.idempotencyKey, status: "completed", target: deployment.target, evidence: "deployment record", updatedAt: startedAt }],
  });
  for (let index = 0; index < 200; index += 1) {
    current = applyWorkflowProgress(current, {
      eventId: `receipt-flood-${index}`,
      phaseRunId: "run-building",
      planRevision: 2,
      runtimeId: "runtime-1",
      activity: "Attempt alternate receipt identity",
      receipt: { operationId: "edit-workspace", idempotencyKey: `invented-${index}`, status: "planned", target: "shared/", evidence: null, updatedAt: startedAt },
      receivedAt: startedAt,
    });
  }
  assert.equal(current.operationReceipts?.length, 1);
  assert.equal(current.operationReceipts?.[0]?.operationId, deployment.id);
  assert.equal(canAutomaticallyAuthorize(current, { workflowId: current.id, operationId: deployment.id, phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", kind: "deployment", target: "staging", constraints: [], idempotencyKey: "deploy-once" }), false);
});

test("unresolved destructive receipts block successful checkpoints", () => {
  const plan = { ...dossier(), operations: [...dossier().operations, { id: "deploy-staging", kind: "deployment" as const, target: "staging", constraints: ["idempotency key required"], idempotencyKey: "deploy-once", description: "Deploy staging", recovery: "Rollback staging", evidence: "Deployment record" }] };
  const completeProgress = {
    ...initialWorkflowProgress(startedAt, "working", plan),
    currentSliceId: null,
    completedSliceIds: ["S1", "S2"],
    passedCriterionIds: ["AC1", "AC2"],
    evidence: [{ criterionId: "AC1", summary: "Deployment evidence" }, { criterionId: "AC2", summary: "Verification evidence" }],
  };
  const reviewing = running("reviewing", {
    dossier: plan,
    phaseRun: { id: "run-reviewing", phase: "reviewing", attempt: 0, planRevision: 2, runtimeId: "runtime-1", startedAt },
    progress: completeProgress,
    operationReceipts: [{ operationId: "deploy-staging", idempotencyKey: "deploy-once", status: "started", target: "staging", evidence: null, updatedAt: startedAt }],
  });
  assert.equal(workflowHasCompleteEvidence(reviewing), false);
  const blocked = applyWorkflowCheckpoint(reviewing, checkpoint("review", "passed", null, { phaseRunId: "run-reviewing", planRevision: 2, runtimeId: "runtime-1" }));
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.blockedFromPhase, "reviewing");
  assert.match(blocked.error ?? "", /deploy-staging.*started.*deploy-once/i);

  const completed = { ...reviewing, operationReceipts: [{ operationId: "deploy-staging", idempotencyKey: "deploy-once", status: "completed" as const, target: "staging", evidence: "deployment record", updatedAt: startedAt }] };
  assert.equal(workflowHasCompleteEvidence(completed), true);
  const ready = applyWorkflowCheckpoint(completed, checkpoint("review", "passed", null, { phaseRunId: "run-reviewing", planRevision: 2, runtimeId: "runtime-1" }));
  assert.equal(ready.phase, "readyToShip");
});

test("ready to ship requires evidence for every structured slice and criterion without consuming repair budget", () => {
  let current = running("reviewing", { repairAttempts: 20, maxRepairAttempts: 30, phaseRun: { id: "run-reviewing", phase: "reviewing", attempt: 0, planRevision: 2, runtimeId: "runtime-1", startedAt } });
  const premature = applyWorkflowCheckpoint(current, checkpoint("review", "passed", null, { phaseRunId: "run-reviewing", planRevision: 2, runtimeId: "runtime-1" }));
  assert.equal(premature.phase, "blocked");
  assert.equal(premature.blockedFromPhase, "reviewing");
  assert.equal(premature.repairAttempts, 20);
  assert.match(premature.error ?? "", /Missing completed slices: S1, S2/);

  current = applyWorkflowProgress(current, {
    eventId: "complete-evidence",
    phaseRunId: "run-reviewing",
    planRevision: 2,
    runtimeId: "runtime-1",
    activity: "All evidence reviewed",
    completedSliceIds: ["S1", "S2"],
    passedCriterionIds: ["AC1", "AC2"],
    evidence: [{ criterionId: "AC1", summary: "Authority passed" }, { criterionId: "AC2", summary: "Reload passed" }],
    condition: "working",
    receivedAt: "2026-04-15T11:05:00.000Z",
  });
  assert.equal(workflowCompletionError(current), null);
  assert.equal(workflowHasCompleteEvidence(current), true);
  const passed = applyWorkflowCheckpoint(current, checkpoint("review", "passed", null, { phaseRunId: "run-reviewing", planRevision: 2, runtimeId: "runtime-1" }));
  assert.equal(passed.phase, "readyToShip");
  assert.equal(passed.repairAttempts, 20);
  assert.equal(passed.progress?.condition, "complete");
  const replay = applyWorkflowCheckpoint(passed, checkpoint("review", "passed", null, { phaseRunId: "run-reviewing", planRevision: 2, runtimeId: "runtime-1" }));
  assert.strictEqual(replay, passed);
});

test("a complete maximum-budget Review transitions once to ready to ship without another Repair", () => {
  const criteria = Array.from({ length: 10 }, (_, index) => ({ id: `AC${index + 1}`, title: `Criterion ${index + 1}` }));
  const slices = Array.from({ length: 8 }, (_, index) => ({
    id: `LPA-${String(index + 1).padStart(2, "0")}`,
    title: `Slice ${index + 1}`,
    criterionIds: index === 7 ? ["AC8", "AC9", "AC10"] : [`AC${index + 1}`],
    dependencies: index === 0 ? [] : [`LPA-${String(index).padStart(2, "0")}`],
  }));
  const plan: EngineeringWorkflowDossier = {
    revision: 0,
    criteria,
    slices,
    verificationRequirements: ["Run the canonical suite"],
    operations: [{ id: "verify", kind: "command", target: "canonical local checks", description: "Verify completion", recovery: "Retain output", evidence: "Passing checks" }],
    recoveryRequirements: ["Do not repeat completed work"],
    exclusions: ["Production operations"],
    readiness: [{ id: "ready", label: "Environment ready", status: "passed", detail: "Checked" }],
    unresolved: [],
  };
  const reviewing = running("reviewing", {
    dossier: plan,
    artifactRevision: 0,
    repairAttempts: 21,
    maxRepairAttempts: 30,
    phaseRun: { id: "review-final", phase: "reviewing", attempt: 0, planRevision: 0, runtimeId: "runtime-final", startedAt },
    progress: {
      ...initialWorkflowProgress(startedAt, "working", plan),
      currentSliceId: null,
      completedSliceIds: slices.map((slice) => slice.id),
      passedCriterionIds: criteria.map((criterion) => criterion.id),
      evidence: criteria.map((criterion) => ({ criterionId: criterion.id, summary: `${criterion.id} evidence` })),
    },
  });
  const finalReview = checkpoint("review", "passed", null, { eventId: "review-final-passed", phaseRunId: "review-final", planRevision: 0, runtimeId: "runtime-final" });
  const ready = applyWorkflowCheckpoint(reviewing, finalReview);
  assert.equal(workflowCompletionError(reviewing), null);
  assert.equal(ready.phase, "readyToShip");
  assert.equal(ready.repairAttempts, 21);
  assert.equal(ready.progress?.condition, "complete");
  assert.strictEqual(applyWorkflowCheckpoint(ready, finalReview), ready);
});

test("repair budget counts repair runs and never exceeds the grant", () => {
  const firstFailure = applyWorkflowCheckpoint(workflow("verifying", { maxRepairAttempts: 1 }), checkpoint("verify", "failed"));
  assert.equal(firstFailure.phase, "repairing");
  assert.equal(firstFailure.repairAttempts, 1);
  const exhausted = applyWorkflowCheckpoint(firstFailure, checkpoint("build", "failed"));
  assert.equal(exhausted.phase, "failed");
  assert.equal(exhausted.repairAttempts, 1);
  assert.equal(exhausted.maxRepairAttempts, 1);
});

test("authority requires exact workflow, plan revision, phase run, and operation", () => {
  const current = running();
  const request = { workflowId: current.id, operationId: "edit-workspace", phaseRunId: "run-building", planRevision: 2, runtimeId: "runtime-1", kind: "workspace_write" as const, target: "shared/", constraints: ["Repository-local writes only"], idempotencyKey: "edit-1" };
  assert.equal(canAutomaticallyAuthorize(current, request), true);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, operationId: "deploy-production" }), false);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, phaseRunId: "old-run" }), false);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, planRevision: 3 }), false);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, runtimeId: "old-runtime" }), false);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, target: "server/" }), false);
  assert.equal(canAutomaticallyAuthorize(current, { ...request, constraints: [] }), false);
  assert.equal(canAutomaticallyAuthorize({ ...current, phase: "verifying" }, request), false);

  const destructivePlan = { ...dossier(), operations: [...dossier().operations, { id: "deploy", kind: "deployment" as const, target: "staging", constraints: [], idempotencyKey: "deploy-once", description: "Deploy", recovery: "Rollback", evidence: "Receipt" }] };
  const destructiveRequest = { ...request, operationId: "deploy", kind: "deployment" as const, target: "staging", constraints: [], idempotencyKey: "deploy-once" };
  assert.equal(canAutomaticallyAuthorize(running("building", { dossier: destructivePlan }), destructiveRequest), true);
  const startedDestructive = running("building", { dossier: destructivePlan, operationReceipts: [{ operationId: "deploy", idempotencyKey: "deploy-once", status: "started", target: "staging", evidence: null, updatedAt: startedAt }] });
  assert.equal(canAutomaticallyAuthorize(startedDestructive, destructiveRequest), false);
  const destructive = running("building", { dossier: destructivePlan, operationReceipts: [{ operationId: "deploy", idempotencyKey: "deploy-once", status: "completed", target: "staging", evidence: "done", updatedAt: startedAt }] });
  assert.equal(canAutomaticallyAuthorize(destructive, destructiveRequest), false);

  const commitOperation = { id: "commit", kind: "git_commit" as const, target: "repository", constraints: [], idempotencyKey: "commit-once", description: "Commit", recovery: "Revert", evidence: "Commit ID" };
  const commitPlan = { ...dossier(), operations: [...dossier().operations, commitOperation] };
  const commitRequest = { ...request, operationId: "commit", kind: "git_commit" as const, target: "repository", constraints: [], idempotencyKey: "commit-once" };
  assert.equal(canAutomaticallyAuthorize(running("building", { dossier: commitPlan }), commitRequest), true);
  assert.equal(canAutomaticallyAuthorize(running("building", { dossier: commitPlan, operationReceipts: [{ operationId: "commit", idempotencyKey: "commit-once", status: "completed", target: "repository", evidence: "abc123", updatedAt: startedAt }] }), commitRequest), false);

  const genericOperation = { id: "external-command", kind: "command" as const, target: "approved system", constraints: [], receiptRequired: true, idempotencyKey: "command-once", description: "Mutate", recovery: "Restore", evidence: "System record" };
  const genericPlan = { ...dossier(), operations: [...dossier().operations, genericOperation] };
  const genericRequest = { ...request, operationId: "external-command", kind: "command" as const, target: "approved system", constraints: [], idempotencyKey: "command-once" };
  assert.equal(canAutomaticallyAuthorize(running("building", { dossier: genericPlan }), genericRequest), true);
  assert.equal(canAutomaticallyAuthorize(running("building", { dossier: genericPlan, operationReceipts: [{ operationId: "external-command", idempotencyKey: "command-once", status: "completed", target: "approved system", evidence: "record", updatedAt: startedAt }] }), genericRequest), false);

  const decision = { eventId: "authority-1", operationId: request.operationId, phaseRunId: request.phaseRunId, planRevision: 2, allowed: true, basis: "Exact envelope match", decidedAt: startedAt };
  const recorded = recordAuthorityDecision(current, decision);
  assert.equal(recorded.authorityDecisions?.length, 1);
  assert.deepEqual(recordAuthorityDecision(recorded, decision), recorded);
});

test("legacy plans retain compatibility without fabricated structured completion requirements", () => {
  const { revision: _revision, artifactRevision: _artifactRevision, ...legacyPlanning } = workflow("planning");
  const planned = applyWorkflowCheckpoint(legacyPlanning, checkpoint("plan", "ready", "# Legacy plan"));
  assert.equal(planned.phase, "awaitingPlanApproval");
  assert.equal(planned.dossier, undefined);
  const { revision: _reviewRevision, artifactRevision: _reviewArtifactRevision, ...legacyReviewWorkflow } = workflow("reviewing");
  const legacyReview = applyWorkflowCheckpoint(legacyReviewWorkflow, checkpoint("review", "passed"));
  assert.equal(legacyReview.phase, "readyToShip");
  assert.ok(fallbackWorkflowDossier().operations.some((operation) => operation.id === "workspace-write"));
});

test("research tool policy removes mutation tools and external tools outside disclosure authority", () => {
  const configured = ["read", "grep", "edit", "write", "bash", "web_search", "fetch_content", "piss_workflow_checkpoint", "piss_workflow_progress"];
  assert.deepEqual(activeResearchTools("local_only", configured), ["read", "grep", "piss_workflow_checkpoint", "piss_workflow_progress"]);
  assert.deepEqual(activeResearchTools("targeted_external", configured), ["read", "grep", "web_search", "fetch_content", "piss_workflow_checkpoint", "piss_workflow_progress"]);
  assert.equal(researchToolAllowed("required_external", "web_search"), true);
  assert.equal(researchToolAllowed("targeted_external", "edit"), false);
  assert.equal(researchToolAllowed("local_only", "web_search"), false);
});

test("workflow skills encode conversational planning, structured progress, and standing authority", async () => {
  const resource = (name: string) => readFile(new URL(`../workflow-resources/skills/piss-engineering-${name}/SKILL.md`, import.meta.url), "utf8");
  const [define, research, plan, build, verify, review, protocol] = await Promise.all([resource("define"), resource("research"), resource("plan"), resource("build"), resource("verify"), resource("review"), readFile(new URL("../workflow-resources/piss-workflow.ts", import.meta.url), "utf8")]);
  assert.match(define, /piss_workflow_draft/i);
  assert.match(define, /researchQuestions/i);
  assert.match(research, /Search-result snippets alone are not evidence/i);
  assert.match(research, /exact immutable 40-character commit SHA/i);
  assert.match(research, /mark externally dependent questions `unsupported`/i);
  assert.match(protocol, /PISS Research is read-only/i);
  assert.match(protocol, /setActiveTools/);
  assert.match(plan, /specification—not the first tracer—as the completion boundary/i);
  assert.match(plan, /one final interactive authority checkpoint/i);
  assert.match(plan, /dossier\.operations/i);
  assert.match(plan, /non-mutating readiness checks/i);
  assert.match(plan, /every commit, push, migration, deployment, or production write requires a stable `idempotencyKey`/i);
  assert.match(plan, /queued or transcript-backed carry-forward guidance/i);
  assert.match(plan, /appliedResearchFindingIds/);
  assert.match(plan, /Never request \*\*Approve & Run\*\* while applicable guidance remains unacknowledged/i);
  assert.match(protocol, /Plan must report all applicable current\/carry-forward IDs before requesting Approve & Run/i);
  assert.match(plan, /receiptRequired: true/i);
  assert.match(build, /do not checkpoint after only the tracer/i);
  assert.match(build, /piss_workflow_progress/i);
  assert.match(build, /piss_workflow_authority_request/i);
  assert.match(build, /Never invent alternate receipt keys/i);
  assert.match(verify, /all approved scope has evidence/i);
  assert.match(review, /every planned slice\/criterion has durable evidence/i);
});

test("workflow supervisors state blockers plainly for the operator", async () => {
  const supervisor = await readFile(new URL("../workflow-resources/skills/piss-engineering-supervisor/SKILL.md", import.meta.url), "utf8");
  assert.match(supervisor, /one short, plain-language sentence/i);
  assert.match(supervisor, /do not use unexplained acronyms/i);
  assert.match(supervisor, /Plan approval is standing operator authorization/i);
  assert.match(supervisor, /choose `resume_with_guidance`/i);
  assert.match(supervisor, /Never route Define, Research, or Plan into implementation Repair/i);
  assert.match(supervisor, /Research capability failure is not an implementation defect/i);
  assert.match(supervisor, /consultation ID.*workflow ID\/revision.*phase-run ID.*runtime generation/i);
});

test("autonomous phase classification remains explicit", () => {
  for (const phase of ["researching", "building", "verifying", "reviewing", "repairing"] as const) assert.equal(isAutonomousWorkflowPhase(phase), true);
  for (const phase of ["defining", "planning", "blocked", "readyToShip"] as const) assert.equal(isAutonomousWorkflowPhase(phase), false);
});
