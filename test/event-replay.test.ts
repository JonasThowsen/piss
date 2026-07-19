import assert from "node:assert/strict";
import test from "node:test";
import { eventsAfter } from "../server/event-replay.ts";
import type { SessionEvent } from "../shared/protocol.ts";

function event(sequence: number): SessionEvent {
  return { sequence, runtimeId: "runtime", event: "message.updated", data: {}, timestamp: sequence };
}

test("replays events newer than an available cursor", () => {
  assert.deepEqual(eventsAfter([event(3), event(4), event(5)], 5, 3)?.map((item) => item.sequence), [4, 5]);
  assert.deepEqual(eventsAfter([event(3), event(4), event(5)], 5, 2)?.map((item) => item.sequence), [3, 4, 5]);
  assert.deepEqual(eventsAfter([event(3), event(4), event(5)], 5, 5), []);
});

test("requires a snapshot when the cursor is invalid or older than the buffer", () => {
  assert.equal(eventsAfter([event(4), event(5)], 5, 2), undefined);
  assert.equal(eventsAfter([], 5, 2), undefined);
  assert.equal(eventsAfter([event(4), event(5)], 5, 6), undefined);
});
