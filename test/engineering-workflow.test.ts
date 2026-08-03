import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { EngineeringWorkflow, EngineeringWorkflowCheckpoint, EngineeringWorkflowPhase } from "../shared/domain.ts";
import { applyWorkflowCheckpoint, isAutonomousWorkflowPhase, workflowBadgePhaseLabel, workflowNeedsApproval } from "../shared/engineeringWorkflow.ts";

const startedAt = "2026-04-15T10:00:00.000Z";

function workflow(phase: EngineeringWorkflow["phase"] = "defining"): EngineeringWorkflow {
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
    createdAt: startedAt,
    updatedAt: startedAt,
    error: null,
  };
}

function checkpoint(stage: EngineeringWorkflowCheckpoint["stage"], outcome: EngineeringWorkflowCheckpoint["outcome"], artifact: string | null = null): EngineeringWorkflowCheckpoint {
  return {
    stage,
    outcome,
    summary: `${stage} ${outcome}`,
    artifact,
    toolCallId: `${stage}-tool`,
    sequence: 12,
    receivedAt: "2026-04-15T10:01:00.000Z",
  };
}

test("workflow badge labels cover active phases and exclude terminal phases", () => {
  const expected = new Map<EngineeringWorkflowPhase, string>([
    ["defining", "DEFINE"],
    ["awaitingSpecApproval", "SPEC APPROVAL"],
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

test("engineering workflow gates specification and plan before autonomous execution", () => {
  const spec = applyWorkflowCheckpoint(workflow(), checkpoint("define", "ready", "# Specification"));
  assert.equal(spec.phase, "awaitingSpecApproval");
  assert.equal(spec.specification, "# Specification");
  assert.equal(workflowNeedsApproval(spec.phase), true);

  const plan = applyWorkflowCheckpoint({ ...spec, phase: "planning" }, checkpoint("plan", "ready", "# Complete delivery plan"));
  assert.equal(plan.phase, "awaitingPlanApproval");
  assert.equal(plan.plan, "# Complete delivery plan");
  assert.equal(workflowNeedsApproval(plan.phase), true);
});

test("engineering workflow loops build, verify, review, and bounded repair", () => {
  const built = applyWorkflowCheckpoint(workflow("building"), checkpoint("build", "passed"));
  assert.equal(built.phase, "verifying");
  assert.equal(isAutonomousWorkflowPhase(built.phase), true);

  const failed = applyWorkflowCheckpoint(built, checkpoint("verify", "failed"));
  assert.equal(failed.phase, "repairing");
  assert.equal(failed.repairAttempts, 1);

  const repaired = applyWorkflowCheckpoint(failed, checkpoint("build", "passed"));
  const verified = applyWorkflowCheckpoint(repaired, checkpoint("verify", "passed"));
  const reviewed = applyWorkflowCheckpoint(verified, checkpoint("review", "passed"));
  assert.equal(reviewed.phase, "readyToShip");

  const exhausted = applyWorkflowCheckpoint(
    { ...workflow("reviewing"), repairAttempts: 2 },
    checkpoint("review", "failed"),
  );
  assert.equal(exhausted.phase, "failed");
  assert.match(exhausted.error ?? "", /budget exhausted/i);
});

test("out-of-order workflow checkpoints block instead of skipping gates", () => {
  const result = applyWorkflowCheckpoint(workflow("defining"), checkpoint("build", "passed"));
  assert.equal(result.phase, "blocked");
  assert.equal(result.blockedFromPhase, "defining");
  assert.match(result.error ?? "", /invalid/i);
});

test("workflow skills treat the specification as the completion boundary rather than the first tracer", async () => {
  const resource = (name: string) => readFile(new URL(`../workflow-resources/skills/piss-engineering-${name}/SKILL.md`, import.meta.url), "utf8");
  const [plan, build, verify, review] = await Promise.all([resource("plan"), resource("build"), resource("verify"), resource("review")]);

  assert.match(plan, /specification—not the first tracer—as the workflow's completion boundary/i);
  assert.match(plan, /coverage map/i);
  assert.match(plan, /final interactive authority checkpoint/i);
  assert.match(plan, /Autonomy envelope/i);
  assert.match(plan, /non-mutating readiness checks/i);
  assert.match(plan, /one consolidated Plan blocker/i);
  assert.match(build, /do not call the build checkpoint after only the first tracer/i);
  assert.match(build, /standing operator authorization/i);
  assert.match(verify, /all approved scope has passing evidence/i);
  assert.match(verify, /Do not request another confirmation/i);
  assert.match(review, /entire approved specification is covered/i);
  assert.match(review, /do not stop to ask the operator to reconfirm/i);
  assert.doesNotMatch([plan, build, verify, review].join("\n"), /one-task plan/i);
});

test("workflow supervisors state blockers plainly for the operator", async () => {
  const supervisor = await readFile(new URL("../workflow-resources/skills/piss-engineering-supervisor/SKILL.md", import.meta.url), "utf8");

  assert.match(supervisor, /one short, plain-language sentence/i);
  assert.match(supervisor, /do not use unexplained acronyms/i);
  assert.match(supervisor, /keep technical detail and citations in `summary` and `basis`/i);
  assert.match(supervisor, /Plan approval is standing operator authorization/i);
  assert.match(supervisor, /choose `resume_with_guidance`/i);
});
