import type { AgentStatus } from "../shared/protocol.ts";

export function assistantOutcome(message: unknown): AgentStatus | undefined {
  if (!message || typeof message !== "object") return;
  const candidate = message as { role?: unknown; stopReason?: unknown };
  if (candidate.role !== "assistant") return;
  return candidate.stopReason === undefined || candidate.stopReason === "stop" ? "finished" : "blocked";
}

export function statusFromEntries(entries: readonly unknown[], fallbackTimestamp: number): { status: AgentStatus; changedAt: number } {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || !("message" in entry)) continue;
    const message = entry.message as { timestamp?: unknown };
    const status = assistantOutcome(message);
    if (status) return { status, changedAt: typeof message.timestamp === "number" ? message.timestamp : fallbackTimestamp };
  }
  return { status: "idle", changedAt: fallbackTimestamp };
}
