import type { OwnedSessionStatus } from "./domain.ts";

export const ATTENTION_STATE_LABELS: Readonly<Record<OwnedSessionStatus, string>> = {
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  blocked: "Needs input",
  finished: "Finished",
  stopping: "Stopping",
  stopped: "Stopped",
  crashed: "Crashed",
};

export type RuntimeTruthEvent =
  | "runtimeStarted"
  | "agentStarted"
  | "interactiveRequest"
  | "interactiveResolved"
  | "agentSettled"
  | "acknowledged"
  | "stopRequested"
  | "runtimeStopped"
  | "runtimeCrashed";

export function transitionAttentionState(current: OwnedSessionStatus, event: RuntimeTruthEvent): OwnedSessionStatus {
  if (event === "runtimeCrashed") return "crashed";
  if (event === "runtimeStopped") return "stopped";
  if (current === "stopping" || current === "stopped" || current === "crashed") return current;
  switch (event) {
    case "runtimeStarted": return "idle";
    case "agentStarted": return "working";
    case "interactiveRequest": return "blocked";
    case "interactiveResolved": return "working";
    case "agentSettled": return current === "blocked" ? "blocked" : "finished";
    case "acknowledged": return current === "finished" ? "idle" : current;
    case "stopRequested": return "stopping";
    default: return current;
  }
}

export function canAcceptPrompt(status: OwnedSessionStatus): boolean {
  return status === "idle" || status === "finished";
}

export function canConfigureSession(status: OwnedSessionStatus): boolean {
  return status === "idle" || status === "finished";
}

export function isWritableRuntime(status: OwnedSessionStatus): boolean {
  return status === "idle" || status === "finished" || status === "working" || status === "blocked";
}

export function isResumableSession(status: OwnedSessionStatus): boolean {
  return status === "stopped" || status === "crashed";
}
