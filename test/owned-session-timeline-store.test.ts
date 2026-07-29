import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadOwnedSessionTimeline,
  persistOwnedSessionTimeline,
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
    assert.deepEqual(await loadOwnedSessionTimeline(directory, "session-1"), { sequence: 7, events: [event] });
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    await removeOwnedSessionTimeline(directory, "session-1");
    assert.deepEqual(await loadOwnedSessionTimeline(directory, "session-1"), { sequence: 0, events: [] });
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
