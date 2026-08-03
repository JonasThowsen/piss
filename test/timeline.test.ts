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

test("projects streaming and completed Pi thinking as inspectable activity", () => {
  const streaming = eventTimeline([
    event(1, "message_start", { message: { role: "assistant", content: [] } }),
    event(2, "message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting the " } }),
    event(3, "message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "workflow state" } }),
  ]);
  assert.deepEqual(streaming, [{
    _tag: "thinking",
    key: "thinking-live-1",
    sequence: 3,
    text: "Inspecting the workflow state",
    live: true,
  }]);

  const completed = eventTimeline([
    ...[
      event(1, "message_start", { message: { role: "assistant", content: [] } }),
      event(2, "message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting the workflow state" } }),
    ],
    event(3, "message_end", { message: { role: "assistant", content: [
      { type: "thinking", thinking: "Inspecting the workflow state" },
      { type: "text", text: "I found the implementation path." },
    ] } }),
  ]);
  assert.deepEqual(completed, [
    { _tag: "thinking", key: "thinking-3", sequence: 3, text: "Inspecting the workflow state" },
    { _tag: "message", key: "message-3", sequence: 3, role: "assistant", text: "I found the implementation path.", imageCount: 0 },
  ]);
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
  assert.deepEqual(
    mergeSessionEvents(merged, [...current, ...merged]),
    merged,
    "an overlapping response cannot resurrect superseded tool activity",
  );
});

test("coalesces repeated tool lifecycles without discarding settled results", () => {
  const merged = mergeSessionEvents([], [
    event(1, "tool_execution_start", { toolCallId: "reused", toolName: "bash" }),
    event(2, "tool_execution_update", { toolCallId: "reused", partialResult: "first" }),
    event(3, "tool_execution_end", { toolCallId: "reused", result: "settled" }),
    event(4, "tool_execution_start", { toolCallId: "reused", toolName: "bash" }),
    event(5, "tool_execution_update", { toolCallId: "reused", partialResult: "stale" }),
    event(6, "tool_execution_update", { toolCallId: "reused", partialResult: "current" }),
  ]);

  assert.deepEqual(merged.map((item) => [item.sequence, item.type]), [
    [3, "tool_execution_end"],
    [4, "tool_execution_start"],
    [6, "tool_execution_update"],
  ]);
});

test("merges a maximum-size completed history without blocking the UI thread", () => {
  const current = Array.from({ length: 20_000 }, (_, index) => event(index + 1, "tool_execution_end", {
    toolCallId: `call-${index}`,
    toolName: "bash",
    result: "done",
  }));
  const startedAt = performance.now();
  const merged = mergeSessionEvents(current, [event(20_001, "message_update", {
    assistantMessageEvent: { type: "text_delta", delta: "x" },
  })]);
  const elapsed = performance.now() - startedAt;

  assert.equal(merged.length, 20_000);
  assert.equal(merged.at(-1)?.sequence, 20_001);
  assert.ok(elapsed < 1_000, `maximum-size merge took ${elapsed.toFixed(1)}ms`);
});

test("projects supervisor consultation as one settled workflow status", () => {
  const timeline = eventTimeline([
    event(5, "workflow_supervisor_consulting", { repeatedBlockerCount: 1 }),
    event(8, "workflow_supervisor_advice", {
      action: "resume_with_guidance",
      summary: "Use the approved deterministic recovery path",
      automaticRecovery: true,
    }),
  ]);

  assert.deepEqual(timeline, [{
    _tag: "status",
    key: "workflow-supervisor-5",
    sequence: 8,
    label: "Loop supervisor resumed workflow",
    detail: "Use the approved deterministic recovery path",
    tone: "success",
  }]);
});

test("projects durable browser screenshots as first-class timeline evidence", () => {
  const timeline = eventTimeline([
    event(7, "browser_artifact_created", {
      artifact: {
        id: "2c240f9a-6091-49a9-bcfa-0c49e6e3aa41",
        kind: "browser-screenshot",
        mediaType: "image/png",
        byteCount: 1024,
        width: 390,
        height: 844,
        pageUrl: "http://127.0.0.1:4000/settings",
        pageTitle: "Settings",
        label: "Mobile settings",
        createdAt: "2026-04-15T10:00:00.000Z",
      },
    }),
  ]);

  assert.deepEqual(timeline, [{
    _tag: "browser-image",
    key: "browser-artifact-7",
    sequence: 7,
    artifact: {
      id: "2c240f9a-6091-49a9-bcfa-0c49e6e3aa41",
      kind: "browser-screenshot",
      mediaType: "image/png",
      byteCount: 1024,
      width: 390,
      height: 844,
      pageUrl: "http://127.0.0.1:4000/settings",
      pageTitle: "Settings",
      label: "Mobile settings",
      createdAt: "2026-04-15T10:00:00.000Z",
    },
  }]);
});

test("projects durable browser videos separately from screenshots", () => {
  const timeline = eventTimeline([event(8, "browser_artifact_created", {
    artifact: {
      id: "663dd98b-a517-48f6-a85d-639ae76077e9",
      kind: "browser-video", mediaType: "video/webm", byteCount: 4096,
      width: 800, height: 600, durationMs: 1250,
      pageUrl: "http://127.0.0.1:4000/demo", pageTitle: "Demo", label: "Interaction",
      createdAt: "2026-04-15T10:00:00.000Z",
    },
  })]);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?._tag, "browser-video");
  if (timeline[0]?._tag === "browser-video") assert.equal(timeline[0].artifact.durationMs, 1250);
});

test("renders fire-and-forget extension notifications as durable output", () => {
  const timeline = eventTimeline([
    event(1, "extension_ui_request", { method: "notify", message: "MCP Server Status:\n\n✓ jomat: connected", notifyType: "info" }),
    event(2, "extension_ui_request", { method: "notify", message: "Authentication required", notifyType: "warning" }),
  ]);

  assert.deepEqual(timeline, [
    { _tag: "notice", key: "notice-1", sequence: 1, text: "MCP Server Status:\n\n✓ jomat: connected", tone: "info" },
    { _tag: "notice", key: "notice-2", sequence: 2, text: "Authentication required", tone: "warning" },
  ]);
});

test("renders compaction and retry lifecycle as settled timeline states", () => {
  const timeline = eventTimeline([
    event(1, "compaction_start", { reason: "overflow" }),
    event(2, "compaction_end", { reason: "overflow", result: { tokensBefore: 198000, estimatedTokensAfter: 24000 }, aborted: false, willRetry: true }),
    event(3, "auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 2000 }),
    event(4, "auto_retry_end", { success: true, attempt: 1 }),
  ]);

  assert.deepEqual(timeline, [
    { _tag: "status", key: "compaction-1", sequence: 2, label: "Context compacted", detail: "198,000 → 24,000 estimated tokens", tone: "success" },
    { _tag: "status", key: "retry-3", sequence: 4, label: "Provider recovered", detail: "The session continued automatically", tone: "success" },
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
    sequence: 1,
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
    sequence: 3,
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
    sequence: 10,
    name: "bash",
    detail: "complete",
    error: false,
    state: "done",
  });
});
