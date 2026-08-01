import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptBrowserScreenshot,
  loadOwnedSessionArtifact,
  prepareRuntimeArtifactStaging,
  removeOwnedSessionArtifacts,
  type BrowserScreenshotCandidate,
} from "../server/runtimes/OwnedSessionArtifactStore.ts";

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function candidate(id: string, byteCount: number): BrowserScreenshotCandidate {
  return {
    version: 1,
    stagingName: `${id}.png`,
    artifact: {
      id,
      kind: "browser-screenshot",
      mediaType: "image/png",
      byteCount,
      width: 2,
      height: 3,
      pageUrl: "http://127.0.0.1:3000/",
      pageTitle: "Fixture",
      label: "Final state",
      createdAt: "2026-04-15T10:00:00.000Z",
    },
  };
}

test("adopts only the current runtime's validated PNG and removes it with the session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-artifact-"));
  const id = "2c240f9a-6091-49a9-bcfa-0c49e6e3aa41";
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-a", "runtime-a");
    const bytes = png();
    await writeFile(join(staging, `${id}.png`), bytes);
    const artifact = await adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, bytes.length));
    assert.equal(artifact.id, id);
    assert.deepEqual(await loadOwnedSessionArtifact(stateDir, "session-a", id), bytes);
    await assert.rejects(loadOwnedSessionArtifact(stateDir, "session-b", id));
    await assert.rejects(adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, bytes.length)), /ENOENT|exist/i);

    await removeOwnedSessionArtifacts(stateDir, "session-a");
    await assert.rejects(loadOwnedSessionArtifact(stateDir, "session-a", id));
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("serializes concurrent adoption at the bounded per-session screenshot quota", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-artifact-quota-"));
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-a", "runtime-a");
    const bytes = png();
    const ids = Array.from({ length: 101 }, () => randomUUID());
    await Promise.all(ids.map((id) => writeFile(join(staging, `${id}.png`), bytes)));
    const results = await Promise.allSettled(ids.map((id) => adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, bytes.length))));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 100);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]?.reason), /quota/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("session removal waits for queued adoptions and leaves no resurrected artifact", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-artifact-remove-race-"));
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-a", "runtime-a");
    const bytes = png();
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(ids.map((id) => writeFile(join(staging, `${id}.png`), bytes)));
    const adoptions = ids.map((id) => adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, bytes.length)));
    const removal = removeOwnedSessionArtifacts(stateDir, "session-a");
    await Promise.all([...adoptions, removal]);
    for (const id of ids) await assert.rejects(loadOwnedSessionArtifact(stateDir, "session-a", id));
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("rejects symlinked, malformed, and mismatched screenshot candidates", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-artifact-reject-"));
  const id = "663dd98b-a517-48f6-a85d-639ae76077e9";
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-a", "runtime-a");
    const outside = join(stateDir, "outside.png");
    await writeFile(outside, png());
    await symlink(outside, join(staging, `${id}.png`));
    await assert.rejects(adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, 24)));

    await rm(join(staging, `${id}.png`), { force: true });
    await writeFile(join(staging, `${id}.png`), Buffer.from("not a png"));
    await assert.rejects(adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, 9)), /valid PNG/);

    await writeFile(join(staging, `${id}.png`), png());
    await assert.rejects(adoptBrowserScreenshot(stateDir, "session-a", "runtime-a", candidate(id, 23)), /metadata/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
