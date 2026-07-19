import type { AgentStatus, SessionInfo } from "../../shared/protocol.ts";

export type DisplaySessionStatus = AgentStatus | "offline";

export const BLOCKED_AFTER_MS = 2 * 60 * 1000;
export const FINISHED_FOR_MS = 10 * 60 * 1000;

export function displaySessionStatus(session: SessionInfo, now = Date.now()): DisplaySessionStatus {
  if (session.state === "offline") return "offline";
  if (session.state === "streaming") {
    return now - session.lastActivity >= BLOCKED_AFTER_MS ? "blocked" : "working";
  }
  if (session.status === "blocked") return "blocked";
  if (session.status === "finished") {
    const changedAt = session.statusChangedAt ?? session.lastActivity;
    return now - changedAt < FINISHED_FOR_MS ? "finished" : "idle";
  }
  return "idle";
}
