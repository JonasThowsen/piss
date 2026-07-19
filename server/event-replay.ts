import type { SessionEvent } from "../shared/protocol.ts";

export function eventsAfter(events: readonly SessionEvent[], currentSequence: number, after: number): SessionEvent[] | undefined {
  if (!Number.isSafeInteger(after) || after < 0 || after > currentSequence) return;
  if (after === currentSequence) return [];
  const firstAvailable = events[0]?.sequence;
  if (firstAvailable === undefined || after < firstAvailable - 1) return;
  return events.filter((event) => event.sequence > after);
}
