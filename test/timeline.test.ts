import assert from "node:assert/strict";
import test from "node:test";
import type { OwnedSessionEvent } from "../shared/domain.ts";
import { eventTimeline, mergeSessionEvents } from "../web/src/timeline.ts";

function event(sequence: number, type: string, data: unknown): OwnedSessionEvent {
  return { sequence, type, data, timestamp: new Date(sequence * 1_000).toISOString() };
}

test("projects completed and streaming Pi messages without duplicate assistant text", () => {
  const completed = eventTimeline([
    event(1, "message_end", { message: { role: "user", content: [{ type: "text", text: "Build it" }] } }),
    event(2, "message_start", { message: { role: "assistant", content: [] } }),
    event(3, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "Working" } }),
    event(4, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }),
  ]);
  assert.deepEqual(completed.map((item) => item._tag === "message" ? [item.role, item.text, item.live ?? false] : []), [
    ["user", "Build it", false],
    ["assistant", "Working", false],
  ]);

  const streaming = eventTimeline([
    event(1, "message_start", { message: { role: "assistant", content: [] } }),
    event(2, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "Still " } }),
    event(3, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "working" } }),
  ]);
  assert.deepEqual(streaming[0], {
    _tag: "message",
    key: "live-1",
    sequence: 3,
    role: "assistant",
    text: "Still working",
    imageCount: 0,
    live: true,
  });
});

test("keeps image-only user messages visible without retaining image bytes", () => {
  const timeline = eventTimeline([
    event(1, "message_end", { message: { role: "user", content: [{ type: "image", mimeType: "image/png" }] } }),
  ]);
  assert.deepEqual(timeline[0], {
    _tag: "message",
    key: "message-1",
    sequence: 1,
    role: "user",
    text: "",
    imageCount: 1,
  });
});

test("merges incremental polling responses and coalesces completed activity", () => {
  const current = [
    event(1, "message_start", { message: { role: "assistant", content: [] } }),
    event(2, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "Working" } }),
    event(3, "tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }),
    event(4, "tool_execution_update", { toolCallId: "call-1", toolName: "bash", partialResult: "running" }),
  ];
  const merged = mergeSessionEvents(current, [
    event(5, "tool_execution_end", { toolCallId: "call-1", toolName: "bash", result: "passed", isError: false }),
    event(6, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  ]);

  assert.deepEqual(merged.map((item) => [item.sequence, item.type]), [
    [5, "tool_execution_end"],
    [6, "message_end"],
  ]);
  assert.deepEqual(mergeSessionEvents(merged, merged), merged, "duplicate full responses are harmless");
});

test("renders compaction and retry lifecycle as settled timeline states", () => {
  const timeline = eventTimeline([
    event(1, "compaction_start", { reason: "overflow" }),
    event(2, "compaction_end", { reason: "overflow", result: { tokensBefore: 198000, estimatedTokensAfter: 24000 }, aborted: false, willRetry: true }),
    event(3, "auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 2000 }),
    event(4, "auto_retry_end", { success: true, attempt: 1 }),
  ]);

  assert.deepEqual(timeline, [
    { _tag: "status", key: "compaction-1", label: "Context compacted", detail: "198,000 → 24,000 estimated tokens", tone: "success" },
    { _tag: "status", key: "retry-3", label: "Provider recovered", detail: "The session continued automatically", tone: "success" },
  ]);
});

test("correlates native tool lifecycle and keeps readable accumulated output", () => {
  const running = eventTimeline([
    event(1, "tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }),
    event(2, "tool_execution_update", { toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one\ntwo" }] } }),
  ]);
  assert.deepEqual(running[0], {
    _tag: "tool",
    key: "call-1",
    name: "bash",
    detail: "one\ntwo",
    error: false,
    state: "running",
  });

  const completed = eventTimeline([
    ...[
      event(1, "tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }),
      event(2, "tool_execution_update", { toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } }),
    ],
    event(3, "tool_execution_end", { toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "all tests passed" }] }, isError: false }),
  ]);
  assert.deepEqual(completed[0], {
    _tag: "tool",
    key: "call-1",
    name: "bash",
    detail: "all tests passed",
    error: false,
    state: "done",
  });

  const bounded = eventTimeline([
    event(9, "tool_execution_update", { toolCallId: "call-old", toolName: "bash", partialResult: { content: [{ type: "text", text: "retained output" }] } }),
    event(10, "tool_execution_end", { toolCallId: "call-old", toolName: "bash", result: { content: [{ type: "text", text: "complete" }] }, isError: false }),
  ]);
  assert.deepEqual(bounded[0], {
    _tag: "tool",
    key: "call-old",
    name: "bash",
    detail: "complete",
    error: false,
    state: "done",
  });
});
