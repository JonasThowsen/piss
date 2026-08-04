import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const WorkspaceName = NonEmptyString.check(Schema.isMaxLength(120), Schema.isPattern(/^[^\0]+$/));
export const WorkspaceRoot = NonEmptyString.check(Schema.isMaxLength(16 * 1024), Schema.isPattern(/^[^\0]+$/));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WorkspaceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspaceSeed = Schema.Struct({
  name: WorkspaceName,
  root: WorkspaceRoot,
  trustProjectResources: Schema.Boolean,
});
export type WorkspaceSeed = typeof WorkspaceSeed.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  root: Schema.String,
  trustProjectResources: Schema.Boolean,
  createdAt: Schema.String,
  sessionCount: NonNegativeInt,
  activeSessionCount: NonNegativeInt,
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceList = Schema.Array(Workspace);

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  apiVersion: Schema.Literal(1),
  architecture: Schema.Literal("effect-v4"),
});
export type Health = typeof Health.Type;

export const NotificationCapabilityResponse = Schema.Struct({
  supported: Schema.Boolean,
  vapidPublicKey: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))),
});
export type NotificationCapabilityResponse = typeof NotificationCapabilityResponse.Type;

export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024), Schema.isPattern(/^https:\/\//)),
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
    auth: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  }),
});
export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

export const PushSubscriptionMutation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("subscribe"), subscription: PushSubscriptionInput }),
  Schema.Struct({ action: Schema.Literal("unsubscribe"), endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)) }),
]);
export type PushSubscriptionMutation = typeof PushSubscriptionMutation.Type;

export const WorkspaceListResponse = Schema.Struct({
  workspaces: WorkspaceList,
});
export type WorkspaceListResponse = typeof WorkspaceListResponse.Type;

export const DirectoryCandidate = Schema.Struct({
  path: WorkspaceRoot,
  name: WorkspaceName,
  root: WorkspaceRoot,
  relativePath: Schema.String,
});
export type DirectoryCandidate = typeof DirectoryCandidate.Type;

export const DirectorySearchResponse = Schema.Struct({
  candidates: Schema.Array(DirectoryCandidate),
});
export type DirectorySearchResponse = typeof DirectorySearchResponse.Type;

export const CreateWorkspaceInput = Schema.Struct({
  name: WorkspaceName,
  path: WorkspaceRoot,
  createDirectory: Schema.Boolean,
  directoryName: Schema.optional(WorkspaceName),
  trustProjectResources: Schema.Boolean,
});
export type CreateWorkspaceInput = typeof CreateWorkspaceInput.Type;

export const CreateWorkspaceResponse = Schema.Struct({
  workspace: Workspace,
});
export type CreateWorkspaceResponse = typeof CreateWorkspaceResponse.Type;

export const RenameWorkspaceInput = Schema.Struct({ name: WorkspaceName });
export type RenameWorkspaceInput = typeof RenameWorkspaceInput.Type;

export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

export const AvailableModel = Schema.Struct({
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  reasoning: Schema.Boolean,
  thinkingLevels: Schema.Array(ThinkingLevel).check(Schema.isMaxLength(7)),
});
export type AvailableModel = typeof AvailableModel.Type;

export const OwnedSessionStatus = Schema.Literals([
  "starting",
  "working",
  "idle",
  "blocked",
  "finished",
  "stopping",
  "stopped",
  "crashed",
]);
export type OwnedSessionStatus = typeof OwnedSessionStatus.Type;

export const InteractiveRequestMethod = Schema.Literals(["select", "confirm", "input", "editor"]);
export type InteractiveRequestMethod = typeof InteractiveRequestMethod.Type;

export const InteractiveRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  method: InteractiveRequestMethod,
  title: Schema.String.check(Schema.isMaxLength(16 * 1024)),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  options: Schema.optional(Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  placeholder: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024))),
  prefill: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
  timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60 * 60 * 1000))),
  receivedAt: Schema.String,
});
export type InteractiveRequest = typeof InteractiveRequest.Type;

export const OwnedSessionEvent = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  sequence: NonNegativeInt,
  type: Schema.String,
  timestamp: Schema.String,
  data: Schema.Unknown,
});
export type OwnedSessionEvent = typeof OwnedSessionEvent.Type;

export const SessionArtifactId = Schema.String.check(
  Schema.isMinLength(36),
  Schema.isMaxLength(36),
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export type SessionArtifactId = typeof SessionArtifactId.Type;

const BrowserArtifactBase = {
  id: SessionArtifactId,
  width: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_384)),
  height: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65_535)),
  pageUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  pageTitle: Schema.String.check(Schema.isMaxLength(4 * 1024)),
  label: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  createdAt: Schema.String,
};

export const BrowserScreenshotArtifact = Schema.Struct({
  ...BrowserArtifactBase,
  kind: Schema.Literal("browser-screenshot"),
  mediaType: Schema.Literal("image/png"),
  byteCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10 * 1024 * 1024)),
});
export type BrowserScreenshotArtifact = typeof BrowserScreenshotArtifact.Type;

export const BrowserVideoArtifact = Schema.Struct({
  ...BrowserArtifactBase,
  kind: Schema.Literal("browser-video"),
  mediaType: Schema.Literal("video/webm"),
  byteCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50 * 1024 * 1024)),
  durationMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(62_000)),
});
export type BrowserVideoArtifact = typeof BrowserVideoArtifact.Type;

export const SessionArtifact = Schema.Union([BrowserScreenshotArtifact, BrowserVideoArtifact]);
export type SessionArtifact = typeof SessionArtifact.Type;

export const BrowserArtifactCreatedData = Schema.Struct({ artifact: SessionArtifact });
export type BrowserArtifactCreatedData = typeof BrowserArtifactCreatedData.Type;

export const SessionUsage = Schema.Struct({
  userMessages: NonNegativeInt,
  assistantMessages: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolResults: NonNegativeInt,
  totalMessages: NonNegativeInt,
  tokens: Schema.Struct({
    input: NonNegativeInt,
    output: NonNegativeInt,
    cacheRead: NonNegativeInt,
    cacheWrite: NonNegativeInt,
    total: NonNegativeInt,
  }),
  cost: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  contextUsage: Schema.NullOr(Schema.Struct({
    tokens: Schema.NullOr(NonNegativeInt),
    contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
    percent: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  })),
  updatedAt: Schema.String,
});
export type SessionUsage = typeof SessionUsage.Type;

export const CompactionState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "succeeded", "failed"]),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  tokensBefore: Schema.NullOr(NonNegativeInt),
  estimatedTokensAfter: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  updatedAt: Schema.NullOr(Schema.String),
});
export type CompactionState = typeof CompactionState.Type;

export const EngineeringWorkflowPhase = Schema.Literals([
  "defining",
  "awaitingSpecApproval",
  "planning",
  "awaitingPlanApproval",
  "building",
  "verifying",
  "reviewing",
  "repairing",
  "readyToShip",
  "accepted",
  "blocked",
  "cancelled",
  "failed",
]);
export type EngineeringWorkflowPhase = typeof EngineeringWorkflowPhase.Type;

export const EngineeringWorkflowExecutionCondition = Schema.Literals([
  "working",
  "waiting_internal",
  "waiting_user",
  "retrying",
  "supervising",
  "blocked",
  "complete",
]);
export type EngineeringWorkflowExecutionCondition = typeof EngineeringWorkflowExecutionCondition.Type;

export const EngineeringWorkflowCriterion = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
});
export type EngineeringWorkflowCriterion = typeof EngineeringWorkflowCriterion.Type;

export const EngineeringWorkflowSlice = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  criterionIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(200)),
  dependencies: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(100)),
});
export type EngineeringWorkflowSlice = typeof EngineeringWorkflowSlice.Type;

export const EngineeringWorkflowOperation = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  kind: Schema.Literals([
    "workspace_read",
    "workspace_write",
    "command",
    "browser_verify",
    "git_commit",
    "git_push",
    "migration",
    "deployment",
    "production_read",
    "production_write",
  ]),
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  constraints: Schema.optional(Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  ).check(Schema.isMaxLength(100))),
  receiptRequired: Schema.optional(Schema.Boolean),
  idempotencyKey: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  recovery: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  evidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
});
export type EngineeringWorkflowOperation = typeof EngineeringWorkflowOperation.Type;

export const EngineeringWorkflowReadinessCheck = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  status: Schema.Literals(["passed", "unresolved", "outside"]),
  detail: Schema.String.check(Schema.isMaxLength(8 * 1024)),
});
export type EngineeringWorkflowReadinessCheck = typeof EngineeringWorkflowReadinessCheck.Type;

export const EngineeringWorkflowDossier = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000_000)),
  criteria: Schema.Array(EngineeringWorkflowCriterion).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  slices: Schema.Array(EngineeringWorkflowSlice).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  verificationRequirements: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))).check(Schema.isMaxLength(100)),
  operations: Schema.Array(EngineeringWorkflowOperation).check(Schema.isMaxLength(200)),
  recoveryRequirements: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))).check(Schema.isMaxLength(100)),
  exclusions: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))).check(Schema.isMaxLength(100)),
  readiness: Schema.Array(EngineeringWorkflowReadinessCheck).check(Schema.isMaxLength(100)),
  unresolved: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))).check(Schema.isMaxLength(100)),
});
export type EngineeringWorkflowDossier = typeof EngineeringWorkflowDossier.Type;

export const EngineeringWorkflowPhaseRun = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  phase: EngineeringWorkflowPhase,
  attempt: NonNegativeInt,
  planRevision: NonNegativeInt,
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  startedAt: Schema.String,
});
export type EngineeringWorkflowPhaseRun = typeof EngineeringWorkflowPhaseRun.Type;

export const EngineeringWorkflowEvidence = Schema.Struct({
  criterionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  eventSequence: Schema.optional(NonNegativeInt),
});
export type EngineeringWorkflowEvidence = typeof EngineeringWorkflowEvidence.Type;

export const WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH = 4 * 1024;

export const EngineeringWorkflowProgress = Schema.Struct({
  currentSliceId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  activity: Schema.String.check(Schema.isMaxLength(8 * 1024)),
  completedSliceIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(100)),
  passedCriterionIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(200)),
  evidence: Schema.Array(EngineeringWorkflowEvidence).check(Schema.isMaxLength(200)),
  verificationStep: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4 * 1024))),
  reviewStep: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4 * 1024))),
  retryAttempt: NonNegativeInt,
  maxTransientRetries: NonNegativeInt,
  condition: EngineeringWorkflowExecutionCondition,
  nextAction: Schema.String.check(Schema.isMaxLength(WORKFLOW_PROGRESS_NEXT_ACTION_MAX_LENGTH)),
  lastCheckpointSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16 * 1024))),
  lastActivityAt: Schema.String,
});
export type EngineeringWorkflowProgress = typeof EngineeringWorkflowProgress.Type;

export const WORKFLOW_SUPERSEDED_REVISION_CAPACITY = 32;
export const WORKFLOW_MUTATION_RECEIPT_CAPACITY = 256;

export const EngineeringWorkflowSupersededRevision = Schema.Struct({
  planRevision: NonNegativeInt,
  completedSliceIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(100)),
  passedCriterionIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(200)),
  evidence: Schema.Array(EngineeringWorkflowEvidence).check(Schema.isMaxLength(200)),
  supersededAt: Schema.String,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8 * 1024)),
});
export type EngineeringWorkflowSupersededRevision = typeof EngineeringWorkflowSupersededRevision.Type;

export const EngineeringWorkflowGuidance = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
  status: Schema.Literals(["queued", "delivered", "applied"]),
  planRevision: NonNegativeInt,
  applicationPlanRevision: Schema.optional(NonNegativeInt),
  submittedRuntimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  submittedAt: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
  appliedAt: Schema.NullOr(Schema.String),
});
export type EngineeringWorkflowGuidance = typeof EngineeringWorkflowGuidance.Type;

export const EngineeringWorkflowAuthorityDecision = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  phaseRunId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  planRevision: NonNegativeInt,
  allowed: Schema.Boolean,
  basis: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8 * 1024)),
  decidedAt: Schema.String,
  source: Schema.optional(Schema.Literal("piss_workflow_authority_request")),
  correlationId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  runtimeId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  kind: Schema.optional(Schema.Literals([
    "workspace_read",
    "workspace_write",
    "command",
    "browser_verify",
    "git_commit",
    "git_push",
    "migration",
    "deployment",
    "production_read",
    "production_write",
  ])),
  target: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024))),
  constraints: Schema.optional(Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024)),
  ).check(Schema.isMaxLength(100))),
  idempotencyKey: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export type EngineeringWorkflowAuthorityDecision = typeof EngineeringWorkflowAuthorityDecision.Type;

export const EngineeringWorkflowOperationReceipt = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: Schema.Literals(["planned", "started", "completed", "reconciliation_required"]),
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  evidence: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8 * 1024))),
  updatedAt: Schema.String,
});
export type EngineeringWorkflowOperationReceipt = typeof EngineeringWorkflowOperationReceipt.Type;

export const EngineeringWorkflowCheckpoint = Schema.Struct({
  stage: Schema.Literals(["define", "plan", "build", "verify", "review"]),
  outcome: Schema.Literals(["ready", "passed", "failed", "blocked"]),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  artifact: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  toolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sequence: NonNegativeInt,
  receivedAt: Schema.String,
  eventId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  phaseRunId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  planRevision: Schema.optional(NonNegativeInt),
  runtimeId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  dossier: Schema.optional(EngineeringWorkflowDossier),
  appliedGuidanceIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(64))),
});
export type EngineeringWorkflowCheckpoint = typeof EngineeringWorkflowCheckpoint.Type;

export const EngineeringWorkflowSupervisorAdvice = Schema.Struct({
  eventId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  consultationId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  phaseRunId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  planRevision: Schema.optional(NonNegativeInt),
  workflowRevision: Schema.optional(NonNegativeInt),
  runtimeId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  action: Schema.Literals(["resume_with_guidance", "retry_transient", "enter_repair", "human_authority_required", "unsafe_stop"]),
  problem: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  guidance: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  basis: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  receivedAt: Schema.String,
});
export type EngineeringWorkflowSupervisorAdvice = typeof EngineeringWorkflowSupervisorAdvice.Type;

export const EngineeringWorkflowSupervisor = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  status: Schema.Literals(["idle", "consulting"]),
  consultations: NonNegativeInt,
  blockerFingerprint: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  repeatedBlockerCount: NonNegativeInt,
  pendingGuidance: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  lastAdvice: Schema.NullOr(EngineeringWorkflowSupervisorAdvice),
  activeConsultationId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)))),
  consultationPhaseRunId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)))),
  consultationPlanRevision: Schema.optional(NonNegativeInt),
  consultationWorkflowRevision: Schema.optional(NonNegativeInt),
});
export type EngineeringWorkflowSupervisor = typeof EngineeringWorkflowSupervisor.Type;

export const EngineeringWorkflowExecutionAuthority = Schema.Struct({
  mode: Schema.Literal("approved_plan"),
  grantedAt: Schema.String,
  planRevision: Schema.optional(NonNegativeInt),
  artifactDigest: Schema.optional(Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128))),
});
export type EngineeringWorkflowExecutionAuthority = typeof EngineeringWorkflowExecutionAuthority.Type;

export const EngineeringWorkflow = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  phase: EngineeringWorkflowPhase,
  objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
  repairAttempts: NonNegativeInt,
  maxRepairAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  specification: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  plan: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  checkpoint: Schema.NullOr(EngineeringWorkflowCheckpoint),
  blockedFromPhase: Schema.NullOr(EngineeringWorkflowPhase),
  queuedIntervention: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024))),
  supervisor: Schema.optional(EngineeringWorkflowSupervisor),
  executionAuthority: Schema.optional(EngineeringWorkflowExecutionAuthority),
  revision: Schema.optional(NonNegativeInt),
  artifactRevision: Schema.optional(NonNegativeInt),
  dossier: Schema.optional(EngineeringWorkflowDossier),
  phaseRun: Schema.optional(EngineeringWorkflowPhaseRun),
  progress: Schema.optional(EngineeringWorkflowProgress),
  guidance: Schema.optional(Schema.Array(EngineeringWorkflowGuidance).check(Schema.isMaxLength(64))),
  authorityDecisions: Schema.optional(Schema.Array(EngineeringWorkflowAuthorityDecision).check(Schema.isMaxLength(200))),
  operationReceipts: Schema.optional(Schema.Array(EngineeringWorkflowOperationReceipt).check(Schema.isMaxLength(200))),
  processedEventIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(4_096))),
  processedMutationIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(Schema.isMaxLength(WORKFLOW_MUTATION_RECEIPT_CAPACITY))),
  cancellationMutationId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  reconciledTimelineSequence: Schema.optional(NonNegativeInt),
  supersededRevisions: Schema.optional(Schema.Array(EngineeringWorkflowSupersededRevision).check(Schema.isMaxLength(WORKFLOW_SUPERSEDED_REVISION_CAPACITY))),
  openQuestions: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))).check(Schema.isMaxLength(20))),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
});
export type EngineeringWorkflow = typeof EngineeringWorkflow.Type;

export const EngineeringWorkflowSummary = Schema.Struct({
  id: Schema.String,
  phase: EngineeringWorkflowPhase,
  repairAttempts: NonNegativeInt,
  maxRepairAttempts: NonNegativeInt,
  updatedAt: Schema.String,
});
export type EngineeringWorkflowSummary = typeof EngineeringWorkflowSummary.Type;

export const OwnedSession = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  workspaceId: WorkspaceId,
  name: WorkspaceName,
  branch: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  status: OwnedSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  piSessionId: Schema.NullOr(Schema.String),
  sessionFile: Schema.NullOr(Schema.String),
  model: Schema.NullOr(AvailableModel),
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  usage: Schema.NullOr(SessionUsage),
  autoCompactionEnabled: Schema.NullOr(Schema.Boolean),
  pendingMessageCount: NonNegativeInt,
  compaction: CompactionState,
  workflow: Schema.NullOr(EngineeringWorkflow).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  lastActivityAt: Schema.String,
  events: Schema.Array(OwnedSessionEvent),
  interactiveRequests: Schema.Array(InteractiveRequest).check(Schema.isMaxLength(8)),
  error: Schema.NullOr(Schema.String),
});
export type OwnedSession = typeof OwnedSession.Type;

export const OwnedSessionSummary = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  workspaceId: WorkspaceId,
  name: WorkspaceName,
  branch: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  status: OwnedSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  piSessionId: Schema.NullOr(Schema.String),
  sessionFile: Schema.NullOr(Schema.String),
  model: Schema.NullOr(AvailableModel),
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  workflow: Schema.NullOr(EngineeringWorkflowSummary).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  lastActivityAt: Schema.String,
  eventCount: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type OwnedSessionSummary = typeof OwnedSessionSummary.Type;

export const OwnedSessionListResponse = Schema.Struct({
  sessions: Schema.Array(OwnedSessionSummary),
});
export type OwnedSessionListResponse = typeof OwnedSessionListResponse.Type;

export const OwnedSessionDetailResponse = Schema.Struct({
  session: OwnedSession,
});
export type OwnedSessionDetailResponse = typeof OwnedSessionDetailResponse.Type;

export const OwnedSessionStreamResponse = Schema.Struct({
  session: OwnedSession,
  reset: Schema.Boolean,
});
export type OwnedSessionStreamResponse = typeof OwnedSessionStreamResponse.Type;

export const OwnedSessionTimelinePageResponse = Schema.Struct({
  events: Schema.Array(OwnedSessionEvent).check(Schema.isMaxLength(200)),
  hasMore: Schema.Boolean,
  nextBeforeSequence: Schema.NullOr(NonNegativeInt),
});
export type OwnedSessionTimelinePageResponse = typeof OwnedSessionTimelinePageResponse.Type;

export const OwnedSessionToolOutputResponse = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  byteCount: NonNegativeInt,
  value: Schema.Unknown,
});
export type OwnedSessionToolOutputResponse = typeof OwnedSessionToolOutputResponse.Type;

export const CreateOwnedSessionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  name: Schema.String.check(Schema.isMaxLength(120), Schema.isPattern(/^[^\0]*$/)),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(512 * 1024))),
});
export type CreateOwnedSessionInput = typeof CreateOwnedSessionInput.Type;

export const ImportOwnedSessionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  name: Schema.String.check(Schema.isMaxLength(120), Schema.isPattern(/^[^\0]*$/)),
  sessionFile: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
});
export type ImportOwnedSessionInput = typeof ImportOwnedSessionInput.Type;

export const RenameOwnedSessionInput = Schema.Struct({
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  name: WorkspaceName,
});
export type RenameOwnedSessionInput = typeof RenameOwnedSessionInput.Type;

export const CreateOwnedSessionResponse = Schema.Struct({
  session: OwnedSession,
});
export type CreateOwnedSessionResponse = typeof CreateOwnedSessionResponse.Type;

export const AvailableModelListResponse = Schema.Struct({
  models: Schema.Array(AvailableModel).check(Schema.isMaxLength(2_000)),
});
export type AvailableModelListResponse = typeof AvailableModelListResponse.Type;

export const PiSlashCommandSource = Schema.Literals(["extension", "prompt", "skill"]);
export type PiSlashCommandSource = typeof PiSlashCommandSource.Type;

export const PiSlashCommandScope = Schema.Literals(["user", "project", "temporary"]);
export type PiSlashCommandScope = typeof PiSlashCommandScope.Type;

export const PiSlashCommand = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024), Schema.isPattern(/^[^\s/]+$/)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(16 * 1_024))),
  source: PiSlashCommandSource,
  scope: Schema.NullOr(PiSlashCommandScope),
});
export type PiSlashCommand = typeof PiSlashCommand.Type;

export const PiSlashCommandListResponse = Schema.Struct({
  commands: Schema.Array(PiSlashCommand).check(Schema.isMaxLength(2_000)),
});
export type PiSlashCommandListResponse = typeof PiSlashCommandListResponse.Type;

export const FileMention = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
  kind: Schema.Literals(["file", "directory"]),
});
export type FileMention = typeof FileMention.Type;

export const FileMentionSearchResponse = Schema.Struct({
  mentions: Schema.Array(FileMention).check(Schema.isMaxLength(20)),
});
export type FileMentionSearchResponse = typeof FileMentionSearchResponse.Type;

const GitStatusCode = Schema.Literals([" ", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);
const ReviewPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16 * 1024),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/),
);

export const ReviewFile = Schema.Struct({
  path: ReviewPath,
  indexStatus: GitStatusCode,
  worktreeStatus: GitStatusCode,
  patch: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
});
export type ReviewFile = typeof ReviewFile.Type;

export const ReviewSnapshot = Schema.Struct({
  generatedAt: NonNegativeInt,
  files: Schema.Array(ReviewFile).check(Schema.isMaxLength(100)),
  truncated: Schema.Boolean,
  totalFiles: NonNegativeInt,
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;

export const ReviewSnapshotResponse = Schema.Struct({ review: ReviewSnapshot });
export type ReviewSnapshotResponse = typeof ReviewSnapshotResponse.Type;

export const SessionConfigurationAction = Schema.Literals(["setModel", "setThinkingLevel", "compact", "setAutoCompaction"]);
export type SessionConfigurationAction = typeof SessionConfigurationAction.Type;

export const SessionConfigurationInput = Schema.Struct({
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  action: SessionConfigurationAction,
  provider: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  modelId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  level: Schema.optional(ThinkingLevel),
  enabled: Schema.optional(Schema.Boolean),
});
export type SessionConfigurationInput = typeof SessionConfigurationInput.Type;

export const OwnedSessionCommandAction = Schema.Literals(["prompt", "steer", "followUp", "abort", "stop"]);
export type OwnedSessionCommandAction = typeof OwnedSessionCommandAction.Type;

export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = typeof ImageMediaType.Type;

export const ImageInput = Schema.Struct({
  mediaType: ImageMediaType,
  data: NonEmptyString.check(Schema.isMaxLength(14 * 1024 * 1024)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^[^\0]*$/))),
});
export type ImageInput = typeof ImageInput.Type;

export const OwnedSessionCommandInput = Schema.Struct({
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  commandId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  action: OwnedSessionCommandAction,
  text: Schema.optional(NonEmptyString.check(Schema.isMaxLength(512 * 1024))),
  images: Schema.optional(Schema.Array(ImageInput).check(Schema.isMaxLength(4))),
});
export type OwnedSessionCommandInput = typeof OwnedSessionCommandInput.Type;

export const InteractiveResponseInput = Schema.Struct({
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  cancelled: Schema.optional(Schema.Boolean),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
  confirmed: Schema.optional(Schema.Boolean),
});
export type InteractiveResponseInput = typeof InteractiveResponseInput.Type;

export const ResumeOwnedSessionInput = Schema.Struct({
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type ResumeOwnedSessionInput = typeof ResumeOwnedSessionInput.Type;

const EngineeringWorkflowMutationGuard = {
  workflowId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  mutationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  expectedRevision: NonNegativeInt,
  expectedPhase: EngineeringWorkflowPhase,
  expectedPhaseRunId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
};

export const EngineeringWorkflowMutationInput = Schema.Union([
  Schema.Struct({
    runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    mutationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    action: Schema.Literal("start"),
    objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
    maxRepairAttempts: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))),
  }),
  Schema.Struct({
    runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ...EngineeringWorkflowMutationGuard,
    action: Schema.Literals(["approve", "accept", "cancel"]),
  }),
  Schema.Struct({
    runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ...EngineeringWorkflowMutationGuard,
    action: Schema.Literal("resume"),
    feedback: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024))),
  }),
  Schema.Struct({
    runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ...EngineeringWorkflowMutationGuard,
    action: Schema.Literal("continueRepairs"),
    additionalRepairAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  }),
  Schema.Struct({
    runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ...EngineeringWorkflowMutationGuard,
    action: Schema.Literals(["revise", "intervene"]),
    feedback: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
    scopeChange: Schema.optional(Schema.Boolean),
  }),
]);
export type EngineeringWorkflowMutationInput = typeof EngineeringWorkflowMutationInput.Type;
