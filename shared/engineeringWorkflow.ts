import type {
  EngineeringWorkflow,
  EngineeringWorkflowCheckpoint,
  EngineeringWorkflowPhase,
} from "./domain.ts";

export const ENGINEERING_WORKFLOW_PACK_VERSION = "engineering-v7";

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

export function isAutonomousWorkflowPhase(phase: EngineeringWorkflowPhase): boolean {
  return AUTONOMOUS_PHASES.has(phase);
}

export function isTerminalWorkflowPhase(phase: EngineeringWorkflowPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function workflowNeedsApproval(phase: EngineeringWorkflowPhase): boolean {
  return phase === "awaitingSpecApproval" || phase === "awaitingPlanApproval";
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

export function applyWorkflowCheckpoint(
  workflow: EngineeringWorkflow,
  checkpoint: EngineeringWorkflowCheckpoint,
): EngineeringWorkflow {
  const updatedAt = checkpoint.receivedAt;
  if (expectedCheckpointStage(workflow.phase) !== checkpoint.stage) {
    return {
      ...workflow,
      phase: "blocked",
      blockedFromPhase: workflow.phase,
      checkpoint,
      updatedAt,
      error: `The ${checkpoint.stage} checkpoint is invalid while the workflow is ${workflow.phase}`,
    };
  }
  if (checkpoint.outcome === "blocked") {
    return {
      ...workflow,
      phase: "blocked",
      blockedFromPhase: workflow.phase,
      checkpoint,
      updatedAt,
      error: checkpoint.summary,
    };
  }
  if (checkpoint.stage === "define") {
    return checkpoint.outcome === "ready"
      ? { ...workflow, phase: "awaitingSpecApproval", specification: checkpoint.artifact, checkpoint, blockedFromPhase: null, updatedAt, error: null }
      : { ...workflow, phase: "blocked", blockedFromPhase: "defining", checkpoint, updatedAt, error: checkpoint.summary };
  }
  if (checkpoint.stage === "plan") {
    return checkpoint.outcome === "ready"
      ? { ...workflow, phase: "awaitingPlanApproval", plan: checkpoint.artifact, checkpoint, blockedFromPhase: null, updatedAt, error: null }
      : { ...workflow, phase: "blocked", blockedFromPhase: "planning", checkpoint, updatedAt, error: checkpoint.summary };
  }
  if (checkpoint.outcome === "failed") {
    const repairAttempts = workflow.repairAttempts + 1;
    return repairAttempts > workflow.maxRepairAttempts
      ? { ...workflow, phase: "failed", repairAttempts, checkpoint, blockedFromPhase: null, updatedAt, error: `Repair budget exhausted: ${checkpoint.summary}` }
      : { ...workflow, phase: "repairing", repairAttempts, checkpoint, blockedFromPhase: null, updatedAt, error: checkpoint.summary };
  }
  if (checkpoint.outcome !== "passed") {
    return { ...workflow, phase: "blocked", blockedFromPhase: workflow.phase, checkpoint, updatedAt, error: checkpoint.summary };
  }
  const phase: EngineeringWorkflowPhase = checkpoint.stage === "build"
    ? "verifying"
    : checkpoint.stage === "verify"
      ? "reviewing"
      : "readyToShip";
  return { ...workflow, phase, checkpoint, blockedFromPhase: null, updatedAt, error: null };
}

export function workflowBadgePhaseLabel(phase: EngineeringWorkflowPhase): string | undefined {
  if (isTerminalWorkflowPhase(phase)) return undefined;
  switch (phase) {
    case "defining": return "DEFINE";
    case "awaitingSpecApproval": return "SPEC APPROVAL";
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
    case "awaitingSpecApproval": return "Spec approval";
    case "planning": return "Planning";
    case "awaitingPlanApproval": return "Plan approval";
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
