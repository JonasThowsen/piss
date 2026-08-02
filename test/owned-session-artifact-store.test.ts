import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync, watch } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  adoptBrowserArtifact,
  adoptBrowserScreenshot,
  loadOwnedSessionArtifact,
  openOwnedSessionArtifact,
  prepareRuntimeArtifactStaging,
  removeOwnedSessionArtifacts,
  type BrowserScreenshotCandidate,
  type BrowserVideoCandidate,
} from "../server/runtimes/OwnedSessionArtifactStore.ts";

const execFileAsync = promisify(execFile);

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

test("adopts a validated VP8 WebM without loading it into JSON transport", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-video-artifact-"));
  const id = randomUUID();
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-video", "runtime-video");
    const path = join(staging, `${id}.webm`);
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-an", "-c:v", "libvpx", "-b:v", "200k", "-y", path]);
    const byteCount = statSync(path).size;
    const video: BrowserVideoCandidate = {
      version: 1,
      stagingName: `${id}.webm`,
      artifact: {
        id, kind: "browser-video", mediaType: "video/webm", byteCount,
        width: 320, height: 240, durationMs: 1_000,
        pageUrl: "http://127.0.0.1:3000/", pageTitle: "Fixture",
        label: "Motion", createdAt: "2026-04-15T10:00:00.000Z",
      },
    };
    const adopted = await adoptBrowserArtifact(stateDir, "session-video", "runtime-video", video, process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe");
    assert.equal(adopted.kind, "browser-video");
    const opened = await openOwnedSessionArtifact(stateDir, "session-video", id);
    try {
      assert.equal(opened.mediaType, "video/webm");
      assert.equal(opened.byteCount, byteCount);
    } finally { await opened.handle.close(); }
    await assert.rejects(loadOwnedSessionArtifact(stateDir, "session-video", id), /not found/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("rejects symlinked, malformed, and descriptor-mismatched WebM candidates", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-video-artifact-reject-"));
  const id = randomUUID();
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-video", "runtime-video");
    const outside = join(stateDir, "outside.webm");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-an", "-c:v", "libvpx", "-b:v", "200k", "-y", outside]);
    const validBytes = statSync(outside).size;
    const candidateFor = (byteCount: number, durationMs = 1_000): BrowserVideoCandidate => ({
      version: 1, stagingName: `${id}.webm`,
      artifact: { id, kind: "browser-video", mediaType: "video/webm", byteCount, width: 320, height: 240, durationMs, pageUrl: "http://127.0.0.1:3000/", pageTitle: "Fixture", createdAt: "2026-04-15T10:00:00.000Z" },
    });
    await symlink(outside, join(staging, `${id}.webm`));
    await assert.rejects(adoptBrowserArtifact(stateDir, "session-video", "runtime-video", candidateFor(validBytes)));
    assert.deepEqual(await readdir(staging), []);
    await writeFile(join(staging, `${id}.webm`), "not-webm");
    await assert.rejects(adoptBrowserArtifact(stateDir, "session-video", "runtime-video", candidateFor(8)), /valid WebM/);
    assert.deepEqual(await readdir(staging), []);
    await copyFile(outside, join(staging, `${id}.webm`));
    await assert.rejects(adoptBrowserArtifact(stateDir, "session-video", "runtime-video", candidateFor(validBytes, 3_000)), /metadata/);
    assert.deepEqual(await readdir(staging), []);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("publishes only the private copy when runtime staging mutates during probe", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-video-artifact-mutation-"));
  const id = randomUUID();
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, "session-video", "runtime-video");
    const source = join(staging, `${id}.webm`);
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-an", "-c:v", "libvpx", "-b:v", "200k", "-y", source]);
    const byteCount = statSync(source).size;
    const probe = join(stateDir, "mutating-ffprobe");
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    await writeFile(probe, `#!/bin/sh\nprintf not-webm > ${quote(source)}\nexec ${quote(process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe")} "$@"\n`);
    await chmod(probe, 0o755);
    const video: BrowserVideoCandidate = {
      version: 1, stagingName: `${id}.webm`,
      artifact: { id, kind: "browser-video", mediaType: "video/webm", byteCount, width: 320, height: 240, durationMs: 1_000, pageUrl: "http://127.0.0.1:3000/", pageTitle: "Fixture", createdAt: "2026-04-15T10:00:00.000Z" },
    };
    await adoptBrowserArtifact(stateDir, "session-video", "runtime-video", video, probe);
    assert.deepEqual(await readdir(staging), []);
    const opened = await openOwnedSessionArtifact(stateDir, "session-video", id);
    try {
      const signature = Buffer.alloc(4);
      await opened.handle.read(signature, 0, 4, 0);
      assert.equal(signature.toString("hex"), "1a45dfa3");
    } finally { await opened.handle.close(); }
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
    assert.deepEqual(await readdir(staging), []);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("publishes only a complete final artifact and leaves no temporary files", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "piss-artifact-atomic-"));
  const sessionId = "session-a";
  const id = randomUUID();
  try {
    const staging = await prepareRuntimeArtifactStaging(stateDir, sessionId, "runtime-a");
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    png().copy(bytes);
    await writeFile(join(staging, `${id}.png`), bytes);
    const directory = join(stateDir, "browser-artifacts", createHash("sha256").update(sessionId).digest("hex"));
    await mkdir(directory, { recursive: true });
    const destinationName = `${id}.png`;
    const observedSize = new Promise<number>((resolve, reject) => {
      const watcher = watch(directory, (event, filename) => {
        if (event !== "rename" || filename !== destinationName) return;
        try {
          const size = statSync(join(directory, destinationName)).size;
          watcher.close();
          resolve(size);
        } catch (cause) {
          watcher.close();
          reject(cause);
        }
      });
    });
    await adoptBrowserScreenshot(stateDir, sessionId, "runtime-a", candidate(id, bytes.length));
    assert.equal(await observedSize, bytes.length);
    assert.deepEqual(await readdir(directory), [destinationName]);

    await writeFile(join(staging, destinationName), bytes);
    await assert.rejects(adoptBrowserScreenshot(stateDir, sessionId, "runtime-a", candidate(id, bytes.length)), /exist/i);
    assert.deepEqual(await readdir(staging), []);
    assert.deepEqual(await readdir(directory), [destinationName]);
    assert.deepEqual(await loadOwnedSessionArtifact(stateDir, sessionId, id), bytes);
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
