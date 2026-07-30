import assert from "node:assert/strict";
import test from "node:test";
import { markOutboxQueued, nextDeliveredOutboxExpiration, pruneDeliveredOutbox, reconcileOutbox, type OutboxItem } from "../web/src/outbox.ts";
import type { TimelineItem } from "../web/src/timeline.ts";

const item = (id: string, status: OutboxItem["status"]): OutboxItem => ({
  id,
  sessionId: "session-1",
  text: "same command",
  action: "prompt",
  submittedAfterSequence: 0,
  status,
});

const message: TimelineItem = {
  _tag: "message",
  key: "message-1",
  sequence: 1,
  role: "user",
  text: "same command",
  imageCount: 0,
};

test("one user event confirms at most one identical outbox command", () => {
  const existing = [item("first", "delivered"), item("second", "queued")];
  const reconciled = reconcileOutbox(existing, { id: "session-1", status: "finished" }, [message]);
  assert.equal(reconciled, existing);
  assert.deepEqual(reconciled.map(({ status }) => status), ["delivered", "queued"]);
});

test("distinct user events confirm distinct identical commands", () => {
  const reconciled = reconcileOutbox(
    [item("first", "queued"), item("second", "queued")],
    { id: "session-1", status: "finished" },
    [message, { ...message, key: "message-2", sequence: 2 }],
  );
  assert.deepEqual(reconciled.map(({ status }) => status), ["delivered", "delivered"]);
});

test("an HTTP acknowledgement cannot downgrade a message already confirmed by the timeline", () => {
  const delivered = reconcileOutbox(
    [item("racing", "sending")],
    { id: "session-1", status: "working" },
    [message],
  );
  assert.equal(delivered[0]?.status, "delivered");
  assert.equal(markOutboxQueued(delivered, "racing"), delivered);
});

test("queued messages remain visible until their user event reaches the timeline", () => {
  const queued = { ...item("queued", "queued"), settledAt: 1 };
  const items = [queued];

  assert.equal(reconcileOutbox(items, { id: "session-1", status: "working" }, []), items);
  assert.equal(nextDeliveredOutboxExpiration(items), undefined);
  assert.equal(pruneDeliveredOutbox(items, 60_000), items);

  const delivered = reconcileOutbox(items, { id: "session-1", status: "working" }, [message]);
  assert.equal(delivered[0]?.status, "delivered");
  assert.notEqual(nextDeliveredOutboxExpiration(delivered), undefined);
});
