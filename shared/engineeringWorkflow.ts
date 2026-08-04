import type {
  EngineeringWorkflow,
  EngineeringWorkflowAuthorityDecision,
  EngineeringWorkflowCheckpoint,
  EngineeringWorkflowDossier,
  EngineeringWorkflowExecutionCondition,
  EngineeringWorkflowGuidance,
  EngineeringWorkflowOperationReceipt,
  EngineeringWorkflowPhase,
  EngineeringWorkflowProgress,
  EngineeringWorkflowSupersededRevision,
} from "./domain.ts";
import { WORKFLOW_MUTATION_RECEIPT_CAPACITY, WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH, WORKFLOW_SUPERSEDED_REVISION_CAPACITY } from "./domain.ts";

export const ENGINEERING_WORKFLOW_PACK_VERSION = "engineering-v9";

const AUTONOMOUS_PHASES: ReadonlySet<EngineeringWorkflowPhase> = new Set([
  "building",
  "verifying",
  "reviewing",
  "repairing",
]);

const TERMINAL_PHASES: ReadonlySet<EngineeringWorkflowPhase> = new Set([
  "readyToShip",
  "accepted",
  "cancelled",
  "failed",
]);

const INHERENT_RECEIPT_OPERATION_KINDS = new Set(["git_commit", "git_push", "migration", "deployment", "production_write"]);
export const WORKFLOW_EVENT_RECEIPT_CAPACITY = 4_096;
export const WORKFLOW_TRANSIENT_RETRY_LIMIT = 2;

export function workflowOperationRequiresReceipt(operation: EngineeringWorkflowDossier["operations"][number] | undefined): boolean {
  return operation !== undefined && (operation.receiptRequired === true || operation.idempotencyKey !== undefined || INHERENT_RECEIPT_OPERATION_KINDS.has(operation.kind));
}

export function workflowDossierValidationError(dossier: EngineeringWorkflowDossier | undefined): string | null {
  if (!dossier) return "The plan did not include a structured autonomy dossier";
  if (dossier.operations.length === 0) return "The autonomy dossier must list every permitted operation";
  if (dossier.verificationRequirements.length === 0) return "The autonomy dossier must include verification requirements";
  if (dossier.recoveryRequirements.length === 0) return "The autonomy dossier must include recovery requirements";
  if (dossier.readiness.length === 0) return "The autonomy dossier must include non-mutating readiness results";
  const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;
  const criterionIds = dossier.criteria.map((item) => item.id);
  const sliceIds = dossier.slices.map((item) => item.id);
  const operationIds = dossier.operations.map((item) => item.id);
  const readinessIds = dossier.readiness.map((item) => item.id);
  const idempotencyKeys = dossier.operations.flatMap((item) => item.idempotencyKey ? [item.idempotencyKey] : []);
  if (!unique(criterionIds)) return "Acceptance criterion IDs must be unique";
  if (!unique(sliceIds)) return "Delivery slice IDs must be unique";
  if (!unique(operationIds)) return "Operation IDs must be unique";
  if (!unique(readinessIds)) return "Readiness result IDs must be unique";
  if (!unique(idempotencyKeys)) return "Operation idempotency keys must be unique";
  if (dossier.operations.some((operation) => workflowOperationRequiresReceipt(operation) && !operation.idempotencyKey)) return "Every receipt-required operation must declare its approved idempotency key";
  const criteria = new Set(criterionIds);
  const slices = new Set(sliceIds);
  const sliceIndexes = new Map(sliceIds.map((id, index) => [id, index]));
  const covered = new Set<string>();
  for (const [index, slice] of dossier.slices.entries()) {
    if (slice.criterionIds.length === 0) return `Slice ${slice.id} must cover at least one acceptance criterion`;
    if (!unique(slice.criterionIds) || slice.criterionIds.some((id) => !criteria.has(id))) return `Slice ${slice.id} refers to an unknown or duplicate acceptance criterion`;
    if (!unique(slice.dependencies) || slice.dependencies.some((id) => id === slice.id || !slices.has(id))) return `Slice ${slice.id} has an invalid dependency`;
    if (slice.dependencies.some((id) => (sliceIndexes.get(id) ?? Number.POSITIVE_INFINITY) >= index)) return `Slice ${slice.id} must appear after each dependency in delivery order`;
    for (const id of slice.criterionIds) covered.add(id);
  }
  if (criterionIds.some((id) => !covered.has(id))) return "Every acceptance criterion must be covered by a delivery slice";
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(dossier.slices.map((slice) => [slice.id, slice]));
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)?.dependencies.some(cyclic)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (sliceIds.some(cyclic)) return "Delivery slice dependencies must not contain a cycle";
  return null;
}

export type WorkflowProgressEvent = {
  readonly eventId: string;
  readonly phaseRunId?: string;
  readonly planRevision?: number;
  readonly runtimeId?: string;
  readonly activity: string;
  readonly currentSliceId?: string | null;
  readonly completedSliceIds?: ReadonlyArray<string>;
  readonly passedCriterionIds?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<{ readonly criterionId: string; readonly summary: string; readonly eventSequence?: number }>;
  readonly verificationStep?: string | null;
  readonly reviewStep?: string | null;
  readonly condition?: EngineeringWorkflowExecutionCondition;
  readonly nextAction?: string;
  readonly retryAttempt?: number;
  readonly maxTransientRetries?: number;
  readonly appliedGuidanceIds?: ReadonlyArray<string>;
  readonly receipt?: EngineeringWorkflowOperationReceipt;
  readonly receivedAt: string;
};

export type WorkflowGuidanceDeliveryEvent = {
  readonly eventId: string;
  readonly guidanceId: string;
  readonly commandId: string;
  readonly planRevision: number;
  readonly deliveredAt: string;
};

export type WorkflowIncompleteBoundary = {
  readonly sliceId: string | null;
  readonly criterionId: string | null;
};

export function isAutonomousWorkflowPhase(phase: EngineeringWorkflowPhase): boolean {
  return AUTONOMOUS_PHASES.has(phase);
}

export function isTerminalWorkflowPhase(phase: EngineeringWorkflowPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function workflowNeedsApproval(phase: EngineeringWorkflowPhase): boolean {
  return phase === "awaitingPlanApproval";
}

export function workflowRevision(workflow: EngineeringWorkflow): number {
  return workflow.revision ?? 0;
}

export function workflowPlanRevision(workflow: EngineeringWorkflow): number {
  return Math.max(workflow.dossier?.revision ?? 0, workflow.artifactRevision ?? 0);
}

export function expectedCheckpointStage(phase: EngineeringWorkflowPhase): EngineeringWorkflowCheckpoint["stage"] | undefined {
  switch (phase) {
    case "defining":
    case "awaitingSpecApproval":
      return "define";
    case "planning":
    case "awaitingPlanApproval":
      return "plan";
    case "building":
    case "repairing":
      return "build";
    case "verifying":
      return "verify";
    case "reviewing":
      return "review";
    default:
      return undefined;
  }
}

export function fallbackWorkflowDossier(revision = 1): EngineeringWorkflowDossier {
  return {
    revision,
    criteria: [{ id: "complete-approved-specification", title: "Complete every acceptance criterion in the approved specification" }],
    slices: [{ id: "complete-approved-plan", title: "Execute the complete approved delivery plan", criterionIds: ["complete-approved-specification"], dependencies: [] }],
    verificationRequirements: ["Run the verification commands in the approved plan"],
    operations: [
      { id: "workspace-read", kind: "workspace_read", target: "approved workspace", description: "Inspect files required by the approved plan", recovery: "No rollback required", evidence: "Relevant inspection recorded in the timeline" },
      { id: "workspace-write", kind: "workspace_write", target: "approved workspace", description: "Edit files explicitly required by the approved plan", recovery: "Use targeted source rollback without discarding unrelated work", evidence: "Diff and focused checks" },
      { id: "verification-commands", kind: "command", target: "commands listed in the approved plan", description: "Run approved tests and builds", recovery: "Stop the command and retain failure output", evidence: "Command result in the timeline" },
      { id: "browser-verification", kind: "browser_verify", target: "loopback UI listed in the approved plan", description: "Exercise the approved local UI", recovery: "Close the managed browser", evidence: "Published browser artifact" },
    ],
    recoveryRequirements: ["Preserve unrelated work and reconcile completed operations before retry"],
    exclusions: ["Operations not explicitly included in the approved plan"],
    readiness: [{ id: "approved-environment", label: "Approved execution environment", status: "passed", detail: "The plan records its non-mutating readiness checks" }],
    unresolved: [],
  };
}

export function initialWorkflowProgress(
  at: string,
  condition: EngineeringWorkflowExecutionCondition = "working",
  dossier?: EngineeringWorkflowDossier,
): EngineeringWorkflowProgress {
  return {
    currentSliceId: dossier?.slices[0]?.id ?? null,
    activity: "Preparing the next workflow action",
    completedSliceIds: [],
    passedCriterionIds: [],
    evidence: [],
    verificationStep: null,
    reviewStep: null,
    retryAttempt: 0,
    maxTransientRetries: WORKFLOW_TRANSIENT_RETRY_LIMIT,
    condition,
    nextAction: "Continue the current workflow phase",
    lastCheckpointSummary: null,
    lastActivityAt: at,
  };
}

function processed(workflow: EngineeringWorkflow, eventId: string | undefined): boolean {
  return Boolean(eventId && workflow.processedEventIds?.includes(eventId));
}

export function workflowCanRecordEvent(workflow: EngineeringWorkflow, eventId: string | undefined, reserved = 1): boolean {
  if (!eventId || processed(workflow, eventId)) return true;
  return (workflow.processedEventIds?.length ?? 0) < WORKFLOW_EVENT_RECEIPT_CAPACITY - reserved;
}

function remember(workflow: EngineeringWorkflow, eventId: string | undefined): ReadonlyArray<string> | undefined {
  if (!eventId || processed(workflow, eventId)) return workflow.processedEventIds;
  return [...(workflow.processedEventIds ?? []), eventId];
}

export function workflowHasActiveCurrentPhaseRun(workflow: EngineeringWorkflow): boolean {
  return workflow.phaseRun?.phase === workflow.phase;
}

export function workflowEventMatchesCurrentRun(
  workflow: EngineeringWorkflow,
  event: { readonly phaseRunId?: string; readonly planRevision?: number; readonly runtimeId?: string },
): boolean {
  const run = workflow.phaseRun;
  if (run) {
    return workflowHasActiveCurrentPhaseRun(workflow)
      && event.phaseRunId === run.id
      && event.planRevision === run.planRevision
      && event.runtimeId === run.runtimeId;
  }
  return event.phaseRunId === undefined && event.planRevision === undefined && event.runtimeId === undefined;
}

function checkpointMatchesRun(workflow: EngineeringWorkflow, checkpoint: EngineeringWorkflowCheckpoint): boolean {
  return workflowEventMatchesCurrentRun(workflow, checkpoint);
}

function nextRevision(workflow: EngineeringWorkflow): number {
  return workflowRevision(workflow) + 1;
}

export function workflowGuidanceAppliesToCurrentPhase(
  workflow: EngineeringWorkflow,
  item: EngineeringWorkflowGuidance,
): boolean {
  const planRevision = workflowPlanRevision(workflow);
  const atPlanBoundary = workflow.phase === "planning" || workflow.phase === "awaitingPlanApproval";
  return item.planRevision === planRevision
    || atPlanBoundary && (
      item.applicationPlanRevision === planRevision
      || item.applicationPlanRevision === undefined && item.planRevision < planRevision
    );
}

export function workflowUnappliedGuidanceIdsForCurrentPhase(workflow: EngineeringWorkflow): ReadonlyArray<string> {
  return (workflow.guidance ?? [])
    .filter((item) => item.status !== "applied" && workflowGuidanceAppliesToCurrentPhase(workflow, item))
    .map((item) => item.id);
}

function boundedGuidanceIdSummary(ids: ReadonlyArray<string>): string {
  const previewLimit = 8;
  const preview = ids.slice(0, previewLimit).join(", ");
  const remaining = ids.length - Math.min(ids.length, previewLimit);
  const summary = `${ids.length} guidance item${ids.length === 1 ? "" : "s"}${preview ? ` (${preview}${remaining > 0 ? `, +${remaining} more` : ""})` : ""}`;
  // IDs are schema-bounded, so the preview is already well below this limit.
  // Keep the slice as a final invariant if those upstream bounds ever change.
  return summary.slice(0, WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH / 2);
}

export function reconcileWorkflowApprovalGuidance(
  workflow: EngineeringWorkflow,
  updatedAt: string,
): EngineeringWorkflow {
  if (workflow.phase !== "awaitingPlanApproval") return workflow;
  const unappliedIds = workflowUnappliedGuidanceIdsForCurrentPhase(workflow);
  if (unappliedIds.length === 0) return workflow;
  const guidanceSummary = boundedGuidanceIdSummary(unappliedIds);
  const { executionAuthority: _authority, phaseRun: _phaseRun, ...unapproved } = workflow;
  const progress = workflow.progress ?? initialWorkflowProgress(updatedAt, "waiting_internal", workflow.dossier);
  return {
    ...unapproved,
    phase: "planning",
    blockedFromPhase: null,
    revision: nextRevision(workflow),
    progress: {
      ...progress,
      condition: "waiting_internal",
      activity: "Final approval paused until persisted guidance is incorporated into the plan",
      nextAction: `Apply all ${guidanceSummary} in a replacement Plan checkpoint before Approve & Run; exact IDs remain in the guidance log`,
      lastActivityAt: updatedAt,
    },
    updatedAt,
    error: `Final approval requires Plan acknowledgement of ${guidanceSummary}`,
  };
}

function applicableGuidanceIds(workflow: EngineeringWorkflow, ids: ReadonlyArray<string> | undefined): boolean {
  if (!ids?.length) return true;
  const guidanceById = new Map((workflow.guidance ?? []).map((item) => [item.id, item]));
  return ids.every((id) => {
    const item = guidanceById.get(id);
    return item !== undefined
      && workflowGuidanceAppliesToCurrentPhase(workflow, item)
      && (item.status === "delivered" || item.status === "applied");
  });
}

function applyGuidanceIds(workflow: EngineeringWorkflow, ids: ReadonlyArray<string> | undefined, at: string) {
  if (!ids?.length || !workflow.guidance?.length) return workflow.guidance;
  const applied = new Set(ids);
  return workflow.guidance.map((item) => applied.has(item.id) && item.status === "delivered"
    ? { ...item, status: "applied" as const, appliedAt: at }
    : item);
}

export function appendBoundedWorkflowGuidance(
  guidance: ReadonlyArray<EngineeringWorkflowGuidance> | undefined,
  item: EngineeringWorkflowGuidance,
): ReadonlyArray<EngineeringWorkflowGuidance> | null {
  const existing = [...(guidance ?? [])];
  return existing.length < 64 ? [...existing, item] : null;
}

export function appendBoundedSupersededRevision(
  revisions: ReadonlyArray<EngineeringWorkflowSupersededRevision> | undefined,
  item: EngineeringWorkflowSupersededRevision,
): ReadonlyArray<EngineeringWorkflowSupersededRevision> | null {
  const existing = [...(revisions ?? [])];
  return existing.length < WORKFLOW_SUPERSEDED_REVISION_CAPACITY ? [...existing, item] : null;
}

function withCheckpointProgress(
  workflow: EngineeringWorkflow,
  checkpoint: EngineeringWorkflowCheckpoint,
  condition: EngineeringWorkflowExecutionCondition,
  nextAction: string,
): EngineeringWorkflowProgress {
  const progress = workflow.progress ?? initialWorkflowProgress(checkpoint.receivedAt, condition, workflow.dossier);
  return {
    ...progress,
    condition,
    nextAction,
    lastCheckpointSummary: checkpoint.summary,
    lastActivityAt: checkpoint.receivedAt,
  };
}

export function workflowFirstIncomplete(workflow: EngineeringWorkflow): WorkflowIncompleteBoundary | null {
  const dossier = workflow.dossier;
  if (!dossier) return null;
  const completed = new Set(workflow.progress?.completedSliceIds ?? []);
  const passed = new Set(workflow.progress?.passedCriterionIds ?? []);
  const evidenced = new Set((workflow.progress?.evidence ?? []).map((item) => item.criterionId));
  for (const slice of dossier.slices) {
    const criterionId = slice.criterionIds.find((id) => !passed.has(id) || !evidenced.has(id)) ?? null;
    if (!completed.has(slice.id) || criterionId) return { sliceId: slice.id, criterionId };
  }
  const criterionId = dossier.criteria.find((criterion) => !passed.has(criterion.id) || !evidenced.has(criterion.id))?.id ?? null;
  return criterionId ? { sliceId: null, criterionId } : null;
}

function unresolvedDestructiveReceipt(workflow: EngineeringWorkflow): EngineeringWorkflowOperationReceipt | undefined {
  return workflow.operationReceipts?.find((receipt) => {
    const operation = workflowOperation(workflow, receipt.operationId);
    return workflowOperationRequiresReceipt(operation)
      && (receipt.status === "started" || receipt.status === "reconciliation_required");
  });
}

function boundedMissingIds(label: string, ids: ReadonlyArray<string>): string {
  const shown = ids.slice(0, 8).join(", ");
  const remaining = ids.length - Math.min(ids.length, 8);
  return `${label}: ${shown}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

export function workflowCompletionError(workflow: EngineeringWorkflow): string | null {
  const dossier = workflow.dossier;
  if (!dossier) {
    return workflow.revision === undefined && workflow.artifactRevision === undefined
      ? null
      : "The structured autonomy dossier is missing";
  }
  const dossierError = workflowDossierValidationError(dossier);
  if (dossierError) return `The persisted autonomy dossier is invalid: ${dossierError}`;
  const unresolvedReceipt = unresolvedDestructiveReceipt(workflow);
  if (unresolvedReceipt) {
    return `Operation ${unresolvedReceipt.operationId} has unresolved ${unresolvedReceipt.status} receipt ${unresolvedReceipt.idempotencyKey}`;
  }
  const progress = workflow.progress;
  if (!progress) return "Structured workflow progress is missing";
  const completed = new Set(progress.completedSliceIds);
  const passed = new Set(progress.passedCriterionIds);
  const evidenced = new Set(progress.evidence.map((item) => item.criterionId));
  const missingSlices = dossier.slices.filter((slice) => !completed.has(slice.id)).map((slice) => slice.id);
  if (missingSlices.length > 0) return boundedMissingIds("Missing completed slices", missingSlices);
  const missingPassedCriteria = dossier.criteria.filter((criterion) => !passed.has(criterion.id)).map((criterion) => criterion.id);
  if (missingPassedCriteria.length > 0) return boundedMissingIds("Missing passed criteria", missingPassedCriteria);
  const missingEvidence = dossier.criteria.filter((criterion) => !evidenced.has(criterion.id)).map((criterion) => criterion.id);
  return missingEvidence.length > 0 ? boundedMissingIds("Missing criterion evidence", missingEvidence) : null;
}

export function workflowHasCompleteEvidence(workflow: EngineeringWorkflow): boolean {
  return workflowCompletionError(workflow) === null;
}

export function applyWorkflowCheckpoint(
  workflow: EngineeringWorkflow,
  checkpoint: EngineeringWorkflowCheckpoint,
): EngineeringWorkflow {
  const eventId = checkpoint.eventId ?? `checkpoint:${checkpoint.toolCallId}`;
  if (processed(workflow, eventId)) return workflow;
  if (!workflowCanRecordEvent(workflow, eventId, 0)) return workflow;
  if (!checkpointMatchesRun(workflow, checkpoint)) return workflow;
  if (expectedCheckpointStage(workflow.phase) !== checkpoint.stage) return workflow;
  if (!applicableGuidanceIds(workflow, checkpoint.appliedGuidanceIds)) return workflow;

  const updatedAt = checkpoint.receivedAt;
  const common = {
    checkpoint,
    processedEventIds: remember(workflow, eventId),
    guidance: applyGuidanceIds(workflow, checkpoint.appliedGuidanceIds, updatedAt),
    revision: nextRevision(workflow),
    updatedAt,
  };

  if (checkpoint.outcome === "blocked") {
    return {
      ...workflow,
      ...common,
      phase: "blocked",
      blockedFromPhase: workflow.phase,
      progress: withCheckpointProgress(workflow, checkpoint, "blocked", "Resolve the concrete blocker or accept supervisor recovery"),
      error: checkpoint.summary,
    };
  }

  if (checkpoint.stage === "define") {
    if (checkpoint.outcome !== "ready") {
      return {
        ...workflow,
        ...common,
        phase: "blocked",
        blockedFromPhase: "defining",
        progress: withCheckpointProgress(workflow, checkpoint, "blocked", "Revise the specification"),
        error: checkpoint.summary,
      };
    }
    return {
      ...workflow,
      ...common,
      phase: "planning",
      specification: checkpoint.artifact,
      artifactRevision: (workflow.artifactRevision ?? 0) + 1,
      blockedFromPhase: null,
      openQuestions: [],
      progress: withCheckpointProgress(workflow, checkpoint, "working", "Prepare the complete executable plan"),
      error: null,
    };
  }

  if (checkpoint.stage === "plan") {
    if (checkpoint.outcome !== "ready") {
      return {
        ...workflow,
        ...common,
        phase: "blocked",
        blockedFromPhase: "planning",
        progress: withCheckpointProgress(workflow, checkpoint, "blocked", "Resolve planning readiness before approval"),
        error: checkpoint.summary,
      };
    }
    const allocatedRevision = Math.max(1, workflow.phaseRun?.planRevision ?? workflowPlanRevision(workflow));
    const reportedDossier = checkpoint.dossier ?? workflow.dossier;
    const dossier = reportedDossier ? { ...reportedDossier, revision: allocatedRevision } : undefined;
    const dossierError = workflowDossierValidationError(dossier);
    const structuredWorkflow = workflow.revision !== undefined || workflow.artifactRevision !== undefined;
    const unresolved = Boolean(dossier && (dossier.unresolved.length > 0 || dossier.readiness.some((item) => item.status === "unresolved")));
    const reportedGuidanceIds = new Set(checkpoint.appliedGuidanceIds ?? []);
    const missingGuidanceIds = workflowUnappliedGuidanceIdsForCurrentPhase(workflow)
      .filter((id) => !reportedGuidanceIds.has(id));
    const guidanceError = missingGuidanceIds.length > 0
      ? `The replacement plan did not acknowledge applicable guidance: ${missingGuidanceIds.join(", ")}`
      : null;
    const planningError = structuredWorkflow
      ? dossierError ?? (unresolved ? "The plan has unresolved readiness requirements" : null) ?? guidanceError
      : (unresolved ? "The plan has unresolved readiness requirements" : null) ?? guidanceError;
    return {
      ...workflow,
      ...common,
      phase: planningError ? "blocked" : "awaitingPlanApproval",
      plan: checkpoint.artifact,
      dossier,
      artifactRevision: allocatedRevision,
      blockedFromPhase: planningError ? "planning" : null,
      openQuestions: [],
      progress: {
        ...initialWorkflowProgress(updatedAt, planningError ? "blocked" : "waiting_user", dossier),
        activity: planningError ? "The executable plan dossier is incomplete" : "Specification and plan are ready for final approval",
        nextAction: planningError ? "Repair the structured dossier and every readiness blocker" : "Review the autonomy envelope, then Approve & Run",
        lastCheckpointSummary: checkpoint.summary,
      },
      error: planningError,
    };
  }

  if (checkpoint.outcome === "failed") {
    if (workflow.repairAttempts >= workflow.maxRepairAttempts) {
      return {
        ...workflow,
        ...common,
        phase: "failed",
        blockedFromPhase: null,
        progress: withCheckpointProgress(workflow, checkpoint, "blocked", "Extend the repair budget or review the remaining findings"),
        error: `Repair budget exhausted: ${checkpoint.summary}`,
      };
    }
    const repairAttempts = workflow.repairAttempts + 1;
    return {
      ...workflow,
      ...common,
      phase: "repairing",
      repairAttempts,
      blockedFromPhase: null,
      progress: withCheckpointProgress(workflow, checkpoint, "working", `Run repair attempt ${repairAttempts} of ${workflow.maxRepairAttempts}`),
      error: checkpoint.summary,
    };
  }

  if (checkpoint.outcome !== "passed") return workflow;

  const unresolvedReceipt = unresolvedDestructiveReceipt(workflow);
  if (unresolvedReceipt) {
    const missing = `Operation ${unresolvedReceipt.operationId} has unresolved ${unresolvedReceipt.status} receipt ${unresolvedReceipt.idempotencyKey}`;
    return {
      ...workflow,
      ...common,
      phase: "blocked",
      blockedFromPhase: workflow.phase,
      progress: withCheckpointProgress(workflow, checkpoint, "blocked", "Reconcile the destructive operation against its system of record before continuing"),
      error: missing,
    };
  }

  if (checkpoint.stage === "review") {
    const completionError = workflowCompletionError(workflow);
    if (completionError) {
      return {
        ...workflow,
        ...common,
        phase: "blocked",
        blockedFromPhase: "reviewing",
        progress: withCheckpointProgress(workflow, checkpoint, "waiting_internal", "Reconcile the exact completion invariant before deciding whether implementation repair is required"),
        error: `Review reported success but the control plane rejected completion. ${completionError}`,
      };
    }
  }

  const phase: EngineeringWorkflowPhase = checkpoint.stage === "build"
    ? "verifying"
    : checkpoint.stage === "verify"
      ? "reviewing"
      : "readyToShip";
  return {
    ...workflow,
    ...common,
    phase,
    blockedFromPhase: null,
    progress: withCheckpointProgress(
      workflow,
      checkpoint,
      phase === "readyToShip" ? "complete" : "working",
      phase === "verifying" ? "Verify every approved criterion" : phase === "reviewing" ? "Review the complete diff and evidence" : "Review and accept the ready-to-ship result",
    ),
    error: null,
  };
}

type OperationReceiptMerge =
  | { readonly valid: true; readonly receipts: ReadonlyArray<EngineeringWorkflowOperationReceipt> | undefined }
  | { readonly valid: false };

function mergeOperationReceipt(
  workflow: EngineeringWorkflow,
  incoming: EngineeringWorkflowOperationReceipt,
): OperationReceiptMerge {
  const receipts = workflow.operationReceipts ?? [];
  const operation = workflowOperation(workflow, incoming.operationId);
  const receiptRequired = workflowOperationRequiresReceipt(operation);
  if (workflow.dossier && (!operation
    || !receiptRequired
    || operation.target !== incoming.target
    || !operation.idempotencyKey
    || operation.idempotencyKey !== incoming.idempotencyKey)) return { valid: false };
  if (receiptRequired && incoming.status === "completed" && !incoming.evidence?.trim()) return { valid: false };
  const existing = receipts.find((item) => item.operationId === incoming.operationId);
  if (!existing) {
    if ((workflow.dossier && receipts.length >= workflow.dossier.operations.length)
      || (receiptRequired && incoming.status !== "planned" && incoming.status !== "started")) return { valid: false };
    return { valid: true, receipts: [...receipts, incoming] };
  }
  if (existing.operationId !== incoming.operationId || existing.target !== incoming.target || existing.idempotencyKey !== incoming.idempotencyKey) return { valid: false };
  if (existing.status === "completed") {
    return incoming.status === "completed"
      ? { valid: true, receipts: workflow.operationReceipts }
      : { valid: false };
  }
  const allowed = existing.status === incoming.status
    || existing.status === "planned" && incoming.status === "started"
    || existing.status === "started" && (incoming.status === "completed" || incoming.status === "reconciliation_required")
    || existing.status === "reconciliation_required" && incoming.status === "completed";
  if (!allowed) return { valid: false };
  return { valid: true, receipts: [...receipts.filter((item) => item.operationId !== incoming.operationId), incoming] };
}

export function applyWorkflowProgress(workflow: EngineeringWorkflow, event: WorkflowProgressEvent): EngineeringWorkflow {
  if (processed(workflow, event.eventId) || isTerminalWorkflowPhase(workflow.phase)) return workflow;
  if (!workflowCanRecordEvent(workflow, event.eventId)) return workflow;
  if (!workflowEventMatchesCurrentRun(workflow, event)) return workflow;

  const receiptMerge = event.receipt ? mergeOperationReceipt(workflow, event.receipt) : { valid: true as const, receipts: workflow.operationReceipts };
  if (!receiptMerge.valid) return workflow;
  const dossier = workflow.dossier;
  if (dossier) {
    const sliceIds = new Set(dossier.slices.map((item) => item.id));
    const criterionIds = new Set(dossier.criteria.map((item) => item.id));
    const unknownSlice = event.currentSliceId !== undefined && event.currentSliceId !== null && !sliceIds.has(event.currentSliceId)
      || event.completedSliceIds?.some((id) => !sliceIds.has(id));
    const unknownCriterion = event.passedCriterionIds?.some((id) => !criterionIds.has(id))
      || event.evidence?.some((item) => !criterionIds.has(item.criterionId));
    if (unknownSlice || unknownCriterion || !applicableGuidanceIds(workflow, event.appliedGuidanceIds)) return workflow;
    const completed = new Set([...(workflow.progress?.completedSliceIds ?? []), ...(event.completedSliceIds ?? [])]);
    if (event.completedSliceIds?.some((id) => dossier.slices.find((slice) => slice.id === id)?.dependencies.some((dependency) => !completed.has(dependency)))) return workflow;
  }
  const current = workflow.progress ?? initialWorkflowProgress(event.receivedAt, "working", workflow.dossier);
  const completedSliceIds = [...new Set([...current.completedSliceIds, ...(event.completedSliceIds ?? [])])];
  const passedCriterionIds = [...new Set([...current.passedCriterionIds, ...(event.passedCriterionIds ?? [])])];
  const evidence = new Map(current.evidence.map((item) => [item.criterionId, item]));
  for (const item of event.evidence ?? []) evidence.set(item.criterionId, item);

  return {
    ...workflow,
    revision: nextRevision(workflow),
    processedEventIds: remember(workflow, event.eventId),
    guidance: applyGuidanceIds(workflow, event.appliedGuidanceIds, event.receivedAt),
    operationReceipts: receiptMerge.receipts,
    progress: {
      ...current,
      currentSliceId: event.currentSliceId === undefined ? current.currentSliceId : event.currentSliceId,
      activity: event.activity,
      completedSliceIds,
      passedCriterionIds,
      evidence: [...evidence.values()],
      verificationStep: event.verificationStep === undefined ? current.verificationStep : event.verificationStep,
      reviewStep: event.reviewStep === undefined ? current.reviewStep : event.reviewStep,
      retryAttempt: Math.min(event.retryAttempt ?? current.retryAttempt, WORKFLOW_TRANSIENT_RETRY_LIMIT),
      maxTransientRetries: WORKFLOW_TRANSIENT_RETRY_LIMIT,
      condition: event.condition ?? current.condition,
      nextAction: event.nextAction ?? current.nextAction,
      lastActivityAt: event.receivedAt,
    },
    updatedAt: event.receivedAt,
  };
}

export function recordWorkflowGuidanceDelivery(
  workflow: EngineeringWorkflow,
  event: WorkflowGuidanceDeliveryEvent,
): EngineeringWorkflow {
  if (processed(workflow, event.eventId) || isTerminalWorkflowPhase(workflow.phase)) return workflow;
  const guidance = workflow.guidance?.find((item) => item.id === event.guidanceId);
  if (!guidance || guidance.status !== "queued" || guidance.commandId !== event.commandId || guidance.planRevision !== event.planRevision) return workflow;
  if (!workflowCanRecordEvent(workflow, event.eventId)) return workflow;
  return {
    ...workflow,
    revision: nextRevision(workflow),
    processedEventIds: remember(workflow, event.eventId),
    guidance: workflow.guidance?.map((item) => item.id === event.guidanceId && item.status === "queued"
      ? { ...item, status: "delivered" as const, deliveredAt: event.deliveredAt }
      : item),
    updatedAt: event.deliveredAt,
  };
}

export function cancelEngineeringWorkflow(workflow: EngineeringWorkflow, cancelledAt: string): EngineeringWorkflow {
  if (isTerminalWorkflowPhase(workflow.phase)) return workflow;
  return {
    ...workflow,
    phase: "cancelled",
    blockedFromPhase: null,
    revision: nextRevision(workflow),
    progress: workflow.progress ? {
      ...workflow.progress,
      condition: "blocked",
      activity: "Workflow cancelled by the operator",
      nextAction: "No further workflow action will run",
      lastActivityAt: cancelledAt,
    } : workflow.progress,
    updatedAt: cancelledAt,
    error: null,
  };
}

export function workflowCanRecordMutation(workflow: EngineeringWorkflow, cancellation = false): boolean {
  return cancellation || (workflow.processedMutationIds?.length ?? 0) < WORKFLOW_MUTATION_RECEIPT_CAPACITY;
}

export function cancelEngineeringWorkflowWithReceipt(
  workflow: EngineeringWorkflow,
  mutationId: string,
  cancelledAt: string,
): EngineeringWorkflow {
  if (workflow.cancellationMutationId === mutationId || isTerminalWorkflowPhase(workflow.phase)) return workflow;
  const cancelled = cancelEngineeringWorkflow(workflow, cancelledAt);
  const receipts = workflow.processedMutationIds ?? [];
  return {
    ...cancelled,
    cancellationMutationId: mutationId,
    processedMutationIds: receipts.includes(mutationId) || receipts.length >= WORKFLOW_MUTATION_RECEIPT_CAPACITY
      ? receipts
      : [...receipts, mutationId],
  };
}

export function workflowOperation(workflow: EngineeringWorkflow, operationId: string) {
  return workflow.dossier?.operations.find((item) => item.id === operationId);
}

export function canAutomaticallyAuthorize(
  workflow: EngineeringWorkflow,
  request: {
    readonly workflowId: string;
    readonly operationId: string;
    readonly phaseRunId: string;
    readonly planRevision: number;
    readonly runtimeId: string;
    readonly kind: NonNullable<EngineeringWorkflow["dossier"]>["operations"][number]["kind"];
    readonly target: string;
    readonly constraints: ReadonlyArray<string>;
    readonly idempotencyKey?: string;
  },
): boolean {
  const operation = workflowOperation(workflow, request.operationId);
  const receiptRequired = workflowOperationRequiresReceipt(operation);
  const conflictingReceipt = receiptRequired && workflow.operationReceipts?.some((receipt) => receipt.operationId === request.operationId
    && (receipt.status === "completed" || receipt.status === "reconciliation_required" || receipt.idempotencyKey === request.idempotencyKey && receipt.status === "started"));
  return workflow.id === request.workflowId
    && isAutonomousWorkflowPhase(workflow.phase)
    && workflowHasActiveCurrentPhaseRun(workflow)
    && workflow.executionAuthority?.mode === "approved_plan"
    && (workflow.executionAuthority.planRevision ?? workflowPlanRevision(workflow)) === request.planRevision
    && workflow.phaseRun?.id === request.phaseRunId
    && workflow.phaseRun.runtimeId === request.runtimeId
    && operation?.kind === request.kind
    && operation.target === request.target
    && JSON.stringify(operation.constraints ?? []) === JSON.stringify(request.constraints)
    && (!receiptRequired || Boolean(request.idempotencyKey) && operation.idempotencyKey === request.idempotencyKey && !conflictingReceipt);
}

export function recordAuthorityDecision(
  workflow: EngineeringWorkflow,
  decision: EngineeringWorkflowAuthorityDecision,
): EngineeringWorkflow {
  if (processed(workflow, decision.eventId) || workflow.authorityDecisions?.some((item) => item.eventId === decision.eventId)) return workflow;
  if (!workflowCanRecordEvent(workflow, decision.eventId)) return workflow;
  return {
    ...workflow,
    revision: nextRevision(workflow),
    processedEventIds: remember(workflow, decision.eventId),
    authorityDecisions: [...(workflow.authorityDecisions ?? []), decision].slice(-200),
    updatedAt: decision.decidedAt,
  };
}

export function workflowBadgePhaseLabel(phase: EngineeringWorkflowPhase): string | undefined {
  if (isTerminalWorkflowPhase(phase)) return undefined;
  switch (phase) {
    case "defining": return "DEFINE";
    case "awaitingSpecApproval": return "SPEC READY";
    case "planning": return "PLAN";
    case "awaitingPlanApproval": return "PLAN APPROVAL";
    case "building": return "BUILD";
    case "verifying": return "VERIFY";
    case "reviewing": return "REVIEW";
    case "repairing": return "REPAIR";
    case "blocked": return "BLOCKED";
    case "readyToShip":
    case "cancelled":
    case "failed":
      return undefined;
  }
}

export function workflowPhaseLabel(phase: EngineeringWorkflowPhase): string {
  switch (phase) {
    case "defining": return "Defining";
    case "awaitingSpecApproval": return "Specification ready";
    case "planning": return "Planning";
    case "awaitingPlanApproval": return "Final approval";
    case "building": return "Building";
    case "verifying": return "Verifying";
    case "reviewing": return "Reviewing";
    case "repairing": return "Repairing";
    case "readyToShip": return "Ready to ship";
    case "accepted": return "Accepted";
    case "blocked": return "Blocked";
    case "cancelled": return "Cancelled";
    case "failed": return "Failed";
  }
}
