import type { OwnedSession } from "../../shared/domain.ts";
import type { TimelineItem } from "./timeline.ts";

export type OutboxItem = {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly imageCount?: number;
  readonly action: "prompt" | "steer" | "followUp";
  readonly submittedAfterSequence: number;
  readonly status: "sending" | "queued" | "delivered" | "rejected";
  readonly settledAt?: number;
  readonly error?: string;
};

const DELIVERED_VISIBILITY_MS = 2_500;

export function markOutboxQueued(
  items: ReadonlyArray<OutboxItem>,
  id: string,
): ReadonlyArray<OutboxItem> {
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== id || item.status !== "sending") return item;
    changed = true;
    return { ...item, status: "queued" as const };
  });
  return changed ? next : items;
}

export function pruneDeliveredOutbox(
  items: ReadonlyArray<OutboxItem>,
  currentTime: number,
): ReadonlyArray<OutboxItem> {
  const next = items.filter((item) => item.status !== "delivered"
    || item.settledAt === undefined
    || item.settledAt + DELIVERED_VISIBILITY_MS > currentTime);
  return next.length === items.length ? items : next;
}

export function nextDeliveredOutboxExpiration(items: ReadonlyArray<OutboxItem>): number | undefined {
  const expirations = items.flatMap((item) => item.status === "delivered" && item.settledAt !== undefined
    ? [item.settledAt + DELIVERED_VISIBILITY_MS]
    : []);
  return expirations.length > 0 ? Math.min(...expirations) : undefined;
}

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
    if (item.status === "queued" && (session.status === "stopped" || session.status === "crashed")) {
      changed = true;
      return { ...item, status: "rejected" as const, error: "Runtime ended before delivery was confirmed" };
    }
    return item;
  });
  return changed ? next : items;
}
