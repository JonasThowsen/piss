import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const boundedId = () => Type.String({ minLength: 1, maxLength: 128 });
const boundedText = (maxLength = 4 * 1024) => Type.String({ maxLength });

const criterion = Type.Object({ id: boundedId(), title: Type.String({ minLength: 1, maxLength: 4 * 1024 }) });
const slice = Type.Object({
  id: boundedId(),
  title: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  criterionIds: Type.Array(boundedId(), { maxItems: 200 }),
  dependencies: Type.Array(boundedId(), { maxItems: 100 }),
});
const operation = Type.Object({
  id: boundedId(),
  kind: StringEnum(["workspace_read", "workspace_write", "command", "browser_verify", "git_commit", "git_push", "migration", "deployment", "production_read", "production_write"] as const),
  target: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 })),
  receiptRequired: Type.Optional(Type.Boolean({ description: "Require a durable started/completed receipt and restart reconciliation for this operation" })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  description: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  recovery: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  evidence: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
});
const readiness = Type.Object({
  id: boundedId(),
  label: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  status: StringEnum(["passed", "unresolved", "outside"] as const),
  detail: boundedText(8 * 1024),
});
const dossier = Type.Object({
  revision: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  criteria: Type.Array(criterion, { minItems: 1, maxItems: 200 }),
  slices: Type.Array(slice, { minItems: 1, maxItems: 100 }),
  verificationRequirements: Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 }),
  operations: Type.Array(operation, { maxItems: 200 }),
  recoveryRequirements: Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 }),
  exclusions: Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 }),
  readiness: Type.Array(readiness, { maxItems: 100 }),
  unresolved: Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 }),
});

const workflowEventIdentity = {
  workflowId: Type.String({ minLength: 1, maxLength: 128, description: "The exact PISS workflow ID from the phase prompt" }),
  eventId: Type.Optional(boundedId()),
  phaseRunId: boundedId(),
  planRevision: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  runtimeId: boundedId(),
};

const checkpoint = Type.Object({
  ...workflowEventIdentity,
  stage: StringEnum(["define", "plan", "build", "verify", "review"] as const),
  outcome: StringEnum(["ready", "passed", "failed", "blocked"] as const),
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Concise evidence-based phase result" }),
  artifact: Type.Optional(Type.String({ maxLength: 64 * 1024, description: "Latest specification or complete plan Markdown" })),
  dossier: Type.Optional(dossier),
  appliedGuidanceIds: Type.Optional(Type.Array(boundedId(), { maxItems: 64 })),
});

const progress = Type.Object({
  ...workflowEventIdentity,
  activity: Type.String({ minLength: 1, maxLength: 8 * 1024 }),
  currentSliceId: Type.Optional(Type.Union([boundedId(), Type.Null()])),
  completedSliceIds: Type.Optional(Type.Array(boundedId(), { maxItems: 100 })),
  passedCriterionIds: Type.Optional(Type.Array(boundedId(), { maxItems: 200 })),
  evidence: Type.Optional(Type.Array(Type.Object({
    criterionId: boundedId(),
    summary: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  }), { maxItems: 200 })),
  verificationStep: Type.Optional(Type.Union([boundedText(), Type.Null()])),
  reviewStep: Type.Optional(Type.Union([boundedText(), Type.Null()])),
  condition: Type.Optional(StringEnum(["working", "waiting_internal", "waiting_user", "retrying", "supervising", "blocked", "complete"] as const)),
  nextAction: Type.Optional(boundedText()),
  retryAttempt: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  maxTransientRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  appliedGuidanceIds: Type.Optional(Type.Array(boundedId(), { maxItems: 64 })),
  receipt: Type.Optional(Type.Object({
    operationId: boundedId(),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
    status: StringEnum(["planned", "started", "completed", "reconciliation_required"] as const),
    target: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
    evidence: Type.Optional(boundedText(8 * 1024)),
  })),
});

const draft = Type.Object({
  ...workflowEventIdentity,
  stage: StringEnum(["define", "plan"] as const),
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  specification: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  plan: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 20 })),
  dossier: Type.Optional(dossier),
});

const authorityConfirmationTitle = (toolCallId: string, title: string) => `[PISS authority:${toolCallId}] ${title}`;

const authorityRequest = Type.Object({
  workflowId: boundedId(),
  phaseRunId: boundedId(),
  planRevision: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  operationId: boundedId(),
  kind: StringEnum(["workspace_read", "workspace_write", "command", "browser_verify", "git_commit", "git_push", "migration", "deployment", "production_read", "production_write"] as const),
  target: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  constraints: Type.Array(Type.String({ minLength: 1, maxLength: 4 * 1024 }), { maxItems: 100 }),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  runtimeId: boundedId(),
  title: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
  message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
});

const supervisorAdvice = Type.Object({
  workflowId: Type.String({ minLength: 1, maxLength: 128, description: "The exact blocked workflow ID supplied by PISS" }),
  eventId: boundedId(),
  consultationId: boundedId(),
  phaseRunId: boundedId(),
  planRevision: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  workflowRevision: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  runtimeId: boundedId(),
  action: StringEnum(["resume_with_guidance", "retry_transient", "enter_repair", "human_authority_required", "unsafe_stop"] as const),
  problem: Type.String({ minLength: 1, maxLength: 512, description: "One plain-language sentence telling the user what is preventing progress." }),
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  guidance: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  basis: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "piss_workflow_checkpoint",
    label: "Workflow checkpoint",
    description: "Report the requested PISS engineering workflow phase result. Include the exact phase-run identity supplied by PISS and structured plan dossier when planning.",
    parameters: checkpoint,
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: `Reported ${params.stage} checkpoint: ${params.outcome}` }],
        details: { ...params, eventId: params.eventId ?? `checkpoint:${toolCallId}` },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "piss_workflow_progress",
    label: "Workflow progress",
    description: "Persist factual slice, criterion, verification, guidance, retry, or operation-receipt progress without ending the phase.",
    parameters: progress,
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: `Progress recorded: ${params.activity}` }],
        details: { ...params, eventId: params.eventId ?? `progress:${toolCallId}` },
      };
    },
  });

  pi.registerTool({
    name: "piss_workflow_draft",
    label: "Workflow draft",
    description: "Publish the latest specification or plan and focused clarification questions without ending Define or Plan.",
    parameters: draft,
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: params.questions?.length ? "Draft and clarification questions published" : "Workflow draft published" }],
        details: { ...params, eventId: params.eventId ?? `draft:${toolCallId}` },
      };
    },
  });

  pi.registerTool({
    name: "piss_workflow_authority_request",
    label: "Workflow authority check",
    description: "Request an internal confirmation for one structured operation. PISS automatically resolves it only when it exactly matches the approved autonomy envelope.",
    parameters: authorityRequest,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const confirmed = await ctx.ui.confirm(authorityConfirmationTitle(toolCallId, params.title), params.message);
      return {
        content: [{ type: "text", text: confirmed ? "Approved operation confirmed by the PISS authority envelope" : "Operation was not authorized" }],
        details: { ...params, confirmed },
      };
    },
  });

  pi.registerTool({
    name: "piss_workflow_supervisor_advice",
    label: "Workflow supervisor advice",
    description: "Adjudicate a blocked PISS engineering workflow. Only call this from the dedicated supervisor prompt with its exact workflow ID.",
    parameters: supervisorAdvice,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Reported supervisor decision: ${params.action}` }],
        details: params,
        terminate: true,
      };
    },
  });
}
