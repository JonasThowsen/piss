import type { OwnedSession } from "../../shared/domain.ts";
import type { TimelineItem } from "./timeline.ts";

export type OutboxItem = {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly imageCount?: number;
  readonly action: "prompt" | "steer" | "followUp";
  readonly submittedAfterSequence: number;
  readonly status: "sending" | "accepted" | "delivered" | "rejected";
  readonly settledAt?: number;
  readonly error?: string;
};

export function reconcileOutbox(
  items: ReadonlyArray<OutboxItem>,
  session: Pick<OwnedSession, "id" | "status">,
  timeline: ReadonlyArray<TimelineItem>,
): ReadonlyArray<OutboxItem> {
  const unmatchedUserMessages = timeline.filter((item): item is Extract<TimelineItem, { _tag: "message" }> => item._tag === "message" && item.role === "user");
  let changed = false;
  const next = items.map((item) => {
    if (item.sessionId !== session.id || item.status === "rejected") return item;
    const match = unmatchedUserMessages.findIndex((message) => message.sequence > item.submittedAfterSequence
      && message.text.trim() === item.text.trim()
      && message.imageCount === (item.imageCount ?? 0));
    if (item.status === "delivered") {
      if (match >= 0) unmatchedUserMessages.splice(match, 1);
      return item;
    }
    if (match >= 0) {
      unmatchedUserMessages.splice(match, 1);
      changed = true;
      return { ...item, status: "delivered" as const, settledAt: Date.now() };
    }
    if (item.status === "accepted" && (session.status === "stopped" || session.status === "crashed")) {
      changed = true;
      return { ...item, status: "rejected" as const, error: "Runtime ended before delivery was confirmed" };
    }
    return item;
  });
  return changed ? next : items;
}
