import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Schema from "effect/Schema";
import { loadOwnedSessions, MAX_PROCESSED_WORKFLOW_START_MUTATION_IDS, persistOwnedSessions, type PersistedOwnedSession } from "../server/runtimes/OwnedSessionStore.ts";
import { WorkspaceId } from "../shared/domain.ts";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("store-test-deadbeef");

function record(): PersistedOwnedSession {
  return {
    id: "session-1",
    runtimeId: "runtime-1",
    workspaceId,
    name: "Durable session",
    status: "stopped",
    resumeAfterRestart: true,
    resumeRunAfterRestart: true,
    piSessionId: "pi-session-1",
    sessionFile: "/tmp/session.jsonl",
    sessionFileIdentity: { device: "1", inode: "2" },
    workspaceIdentity: { device: "3", inode: "4" },
    model: null,
    thinkingLevel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:01.000Z",
    error: null,
    interactiveRequests: [],
    acceptedCommandIds: ["command-1"],
    processedWorkflowStartMutationIds: ["workflow-start-1"],
  };
}

test("persists versioned owned-session metadata atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-owned-store-"));
  const path = join(directory, "owned-sessions.json");
  try {
    await persistOwnedSessions(path, [record()]);
    const encoded = JSON.parse(await readFile(path, "utf8")) as { version: number };
    assert.equal(encoded.version, 1);
    assert.deepEqual(await loadOwnedSessions(path), [record()]);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects workflow-start receipt overflow rather than evicting replay protection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-owned-store-start-receipts-"));
  const path = join(directory, "owned-sessions.json");
  try {
    const atCapacity = {
      ...record(),
      processedWorkflowStartMutationIds: Array.from({ length: MAX_PROCESSED_WORKFLOW_START_MUTATION_IDS }, (_, index) => `start-${index}`),
    };
    await persistOwnedSessions(path, [atCapacity]);
    assert.equal((await loadOwnedSessions(path))[0]?.processedWorkflowStartMutationIds?.[0], "start-0");
    await assert.rejects(persistOwnedSessions(path, [{
      ...atCapacity,
      processedWorkflowStartMutationIds: [...atCapacity.processedWorkflowStartMutationIds, "start-overflow"],
    }]), /processedWorkflowStartMutationIds|length|256/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects corrupt and symlinked owned-session metadata without following it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-owned-store-invalid-"));
  const corrupt = join(directory, "corrupt.json");
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  try {
    await writeFile(corrupt, '{"version":1,"sessions":[', { mode: 0o600 });
    await assert.rejects(loadOwnedSessions(corrupt));
    await persistOwnedSessions(target, [record()]);
    await symlink(target, link);
    await assert.rejects(loadOwnedSessions(link));
    assert.deepEqual(await loadOwnedSessions(join(directory, "missing.json")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
