import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendOwnedSessionTimelineEvent,
  loadOwnedSessionTimeline,
  loadOwnedSessionTimelinePage,
  loadOwnedSessionToolOutput,
  persistOwnedSessionTimeline,
  persistOwnedSessionToolOutput,
  removeOwnedSessionTimeline,
} from "../server/runtimes/OwnedSessionTimelineStore.ts";

const event = {
  sequence: 7,
  type: "tool_execution_end",
  timestamp: "2026-01-01T00:00:00.000Z",
  data: { toolCallId: "call-1", toolName: "bash", result: "done" },
};

test("persists and removes an owned-session timeline atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "piss-timeline-store-"));
  const directory = join(root, "timelines");
  try {
    await persistOwnedSessionTimeline(directory, "session-1", { sequence: 7, events: [event] });
    assert.deepEqual(await loadOwnedSessionTimeline(directory, "session-1"), { sequence: 7, events: [{ ...event, id: "session-1:7" }] });
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    await removeOwnedSessionTimeline(directory, "session-1");
    assert.deepEqual(await loadOwnedSessionTimeline(directory, "session-1"), { sequence: 0, events: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pages complete projection history without gaps across store reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "piss-timeline-history-"));
  const directory = join(root, "timelines");
  try {
    for (let sequence = 1; sequence <= 45; sequence += 1) {
      await appendOwnedSessionTimelineEvent(directory, "session-pages", {
        id: `session-pages:${sequence}`,
        sequence,
        type: "message_end",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { message: { role: "assistant", content: `event ${sequence}` } },
      });
    }
    const restored = await loadOwnedSessionTimeline(directory, "session-pages");
    assert.equal(restored.sequence, 45, "durable history prevents sequence reuse when the compact snapshot lags");

    const latest = await loadOwnedSessionTimelinePage(directory, "session-pages", undefined, 10);
    assert.deepEqual(latest.events.map((item) => item.sequence), [36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
    assert.equal(latest.hasMore, true);
    assert.equal(latest.nextBeforeSequence, 36);

    const earlier = await loadOwnedSessionTimelinePage(directory, "session-pages", latest.nextBeforeSequence ?? undefined, 10);
    assert.deepEqual(earlier.events.map((item) => item.sequence), [26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    assert.equal(new Set([...earlier.events, ...latest.events].map((item) => item.id)).size, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores huge unicode tool output separately and removes it with the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "piss-tool-output-"));
  const directory = join(root, "timelines");
  const value = { content: [{ type: "text", text: "🧪漢字".repeat(250_000) }] };
  try {
    const stored = await persistOwnedSessionToolOutput(directory, "session-output", "stable-output-ref", value);
    assert.ok(stored.byteCount > 2 * 1024 * 1024);
    assert.deepEqual(await loadOwnedSessionToolOutput(directory, "session-output", "stable-output-ref"), {
      byteCount: stored.byteCount,
      value,
    });
    await removeOwnedSessionTimeline(directory, "session-output");
    await assert.rejects(loadOwnedSessionToolOutput(directory, "session-output", "stable-output-ref"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects corrupt and symlinked history chunks and detached outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "piss-history-invalid-"));
  const directory = join(root, "timelines");
  try {
    await appendOwnedSessionTimelineEvent(directory, "session-invalid-history", { ...event, id: "session-invalid-history:7" });
    const [sessionEntry] = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.ok(sessionEntry);
    const projectionDirectory = join(directory, sessionEntry.name);
    const [chunk] = (await readdir(projectionDirectory)).filter((name) => name.startsWith("events-"));
    assert.ok(chunk);
    await writeFile(join(projectionDirectory, chunk), '{"version":1', { mode: 0o600 });
    await assert.rejects(loadOwnedSessionTimelinePage(directory, "session-invalid-history", undefined, 10));

    await persistOwnedSessionToolOutput(directory, "session-invalid-history", "output-invalid", { content: "safe" });
    const [output] = (await readdir(projectionDirectory)).filter((name) => name.startsWith("output-"));
    assert.ok(output);
    await rm(join(projectionDirectory, output));
    const target = join(root, "external-output.json");
    await writeFile(target, JSON.stringify({ version: 1, sessionId: "session-invalid-history", ref: "output-invalid", byteCount: 18, value: { content: "safe" } }));
    await symlink(target, join(projectionDirectory, output));
    await assert.rejects(loadOwnedSessionToolOutput(directory, "session-invalid-history", "output-invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects corrupt and symlinked owned-session timelines", async () => {
  const root = await mkdtemp(join(tmpdir(), "piss-timeline-store-invalid-"));
  const directory = join(root, "timelines");
  try {
    await persistOwnedSessionTimeline(directory, "session-corrupt", { sequence: 7, events: [event] });
    const [file] = await readdir(directory);
    assert.ok(file);
    await writeFile(join(directory, file), '{"version":1', { mode: 0o600 });
    await assert.rejects(loadOwnedSessionTimeline(directory, "session-corrupt"));

    await rm(join(directory, file), { force: true });
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, sessionId: "session-corrupt", sequence: 0, events: [] }), { mode: 0o600 });
    await symlink(target, join(directory, file));
    await assert.rejects(loadOwnedSessionTimeline(directory, "session-corrupt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
