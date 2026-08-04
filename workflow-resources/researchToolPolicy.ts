export type ResearchToolPolicy = "local_only" | "targeted_external" | "required_external";

export const LOCAL_RESEARCH_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
  "piss_workflow_checkpoint",
  "piss_workflow_progress",
] as const;

export const EXTERNAL_RESEARCH_TOOL_NAMES = ["web_search", "fetch_content", "get_search_content"] as const;

const localResearchTools = new Set<string>(LOCAL_RESEARCH_TOOL_NAMES);
const externalResearchTools = new Set<string>(EXTERNAL_RESEARCH_TOOL_NAMES);

export function researchToolAllowed(policy: ResearchToolPolicy, toolName: string): boolean {
  return localResearchTools.has(toolName) || policy !== "local_only" && externalResearchTools.has(toolName);
}

export function activeResearchTools(policy: ResearchToolPolicy, activeTools: ReadonlyArray<string>): ReadonlyArray<string> {
  return activeTools.filter((name) => researchToolAllowed(policy, name));
}

export function activeExternalResearchTools(activeTools: ReadonlyArray<string>): ReadonlyArray<string> {
  return activeTools.filter((name) => externalResearchTools.has(name));
}
