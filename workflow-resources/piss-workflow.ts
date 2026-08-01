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
}
