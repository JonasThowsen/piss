import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const checkpoint = Type.Object({
  workflowId: Type.String({ minLength: 1, maxLength: 128, description: "The exact PISS workflow ID from the phase prompt" }),
  stage: StringEnum(["define", "plan", "build", "verify", "review"] as const),
  outcome: StringEnum(["ready", "passed", "failed", "blocked"] as const),
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Concise evidence-based phase result" }),
  artifact: Type.Optional(Type.String({ maxLength: 64 * 1024, description: "Specification or plan Markdown for approval phases" })),
});

const supervisorAdvice = Type.Object({
  workflowId: Type.String({ minLength: 1, maxLength: 128, description: "The exact blocked workflow ID supplied by PISS" }),
  action: StringEnum(["resume_with_guidance", "retry_transient", "enter_repair", "human_authority_required", "unsafe_stop"] as const),
  problem: Type.String({ minLength: 1, maxLength: 512, description: "One plain-language sentence telling the user what is preventing progress. Avoid unexplained labels, acronyms, and internal gate names." }),
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Technical adjudication for the worker and expandable details" }),
  guidance: Type.Optional(Type.String({ maxLength: 64 * 1024, description: "Concrete worker guidance for an automatic recovery action" })),
  basis: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Approved specification, plan, evidence, or authority boundary supporting the decision" }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "piss_workflow_checkpoint",
    label: "Workflow checkpoint",
    description: "Report the requested PISS engineering workflow phase result. Only call this when a PISS workflow prompt supplies an exact workflow ID and checkpoint contract.",
    parameters: checkpoint,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Reported ${params.stage} checkpoint: ${params.outcome}` }],
        details: params,
        terminate: true,
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
