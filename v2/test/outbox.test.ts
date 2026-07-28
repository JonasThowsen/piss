import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOutbox, type OutboxItem } from "../web/src/outbox.ts";
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
  const existing = [item("first", "delivered"), item("second", "accepted")];
  const reconciled = reconcileOutbox(existing, { id: "session-1", status: "finished" }, [message]);
  assert.equal(reconciled, existing);
  assert.deepEqual(reconciled.map(({ status }) => status), ["delivered", "accepted"]);
});

test("distinct user events confirm distinct identical commands", () => {
  const reconciled = reconcileOutbox(
    [item("first", "accepted"), item("second", "accepted")],
    { id: "session-1", status: "finished" },
    [message, { ...message, key: "message-2", sequence: 2 }],
  );
  assert.deepEqual(reconciled.map(({ status }) => status), ["delivered", "delivered"]);
});
