import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserScreenshotArtifact, BrowserVideoArtifact, SessionArtifact } from "../../shared/domain.ts";

export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 60_000;
export const MAX_SESSION_ARTIFACT_BYTES = 250 * 1024 * 1024;
export const MAX_SESSION_ARTIFACTS = 100;
const VIDEO_DURATION_TOLERANCE_MS = 2_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP_ARTIFACT = /^\.piss-artifact-[0-9a-f-]{36}-[0-9a-f-]{36}\.tmp$/;
const PUBLISHED_ARTIFACT = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(png|webm)$/;
const sessionOperationTails = new Map<string, Promise<void>>();

export interface BrowserArtifactCandidate {
  readonly version: 1;
  readonly stagingName: string;
  readonly artifact: SessionArtifact;
}
export interface BrowserScreenshotCandidate extends BrowserArtifactCandidate {
  readonly artifact: BrowserScreenshotArtifact;
}
export interface BrowserVideoCandidate extends BrowserArtifactCandidate {
  readonly artifact: BrowserVideoArtifact;
}

export interface OpenedOwnedSessionArtifact {
  readonly handle: FileHandle;
  readonly kind: SessionArtifact["kind"];
  readonly mediaType: SessionArtifact["mediaType"];
  readonly byteCount: number;
  readonly extension: "png" | "webm";
}

function storageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function rootDirectory(stateDir: string): string { return join(stateDir, "browser-artifacts"); }
function sessionDirectory(stateDir: string, sessionId: string): string { return join(rootDirectory(stateDir), storageKey(sessionId)); }
function stagingRoot(stateDir: string): string { return join(stateDir, "browser-staging"); }
export function runtimeStagingDirectory(stateDir: string, sessionId: string, runtimeId: string): string {
  return join(stagingRoot(stateDir), storageKey(sessionId), storageKey(runtimeId));
}
function extensionFor(artifact: SessionArtifact): "png" | "webm" { return artifact.kind === "browser-video" ? "webm" : "png"; }
function artifactPath(stateDir: string, sessionId: string, artifactId: string, extension: "png" | "webm"): string {
  return join(sessionDirectory(stateDir, sessionId), `${artifactId}.${extension}`);
}

async function withSessionArtifactLock<T>(stateDir: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = sessionDirectory(stateDir, sessionId);
  const previous = sessionOperationTails.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  sessionOperationTails.set(key, settled);
  try { return await result; }
  finally { if (sessionOperationTails.get(key) === settled) sessionOperationTails.delete(key); }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.chmod(0o700); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function prepareRuntimeArtifactStaging(stateDir: string, sessionId: string, runtimeId: string): Promise<string> {
  const sessionRoot = join(stagingRoot(stateDir), storageKey(sessionId));
  const directory = runtimeStagingDirectory(stateDir, sessionId, runtimeId);
  await rm(sessionRoot, { recursive: true, force: true });
  await ensurePrivateDirectory(directory);
  return directory;
}
export async function removeRuntimeArtifactStaging(stateDir: string, sessionId: string, runtimeId: string): Promise<void> {
  await rm(runtimeStagingDirectory(stateDir, sessionId, runtimeId), { recursive: true, force: true });
}

function validateCandidate(candidate: BrowserArtifactCandidate): void {
  const artifact = candidate.artifact;
  const extension = extensionFor(artifact);
  if (candidate.version !== 1
    || artifact.kind === "browser-screenshot" && artifact.mediaType !== "image/png"
    || artifact.kind === "browser-video" && artifact.mediaType !== "video/webm") {
    throw new Error("Unsupported browser artifact descriptor");
  }
  if (!ARTIFACT_ID.test(artifact.id) || candidate.stagingName !== `${artifact.id}.${extension}`) {
    throw new Error("Browser artifact identity is invalid");
  }
  const maximum = artifact.kind === "browser-video" ? MAX_VIDEO_BYTES : MAX_SCREENSHOT_BYTES;
  if (!Number.isSafeInteger(artifact.byteCount) || artifact.byteCount < 1 || artifact.byteCount > maximum) {
    throw new Error(`Browser ${artifact.kind === "browser-video" ? "video" : "screenshot"} exceeds its size limit`);
  }
  if (!Number.isSafeInteger(artifact.width) || artifact.width < 1 || artifact.width > 16_384
    || !Number.isSafeInteger(artifact.height) || artifact.height < 1 || artifact.height > 65_535) {
    throw new Error("Browser artifact dimensions are invalid");
  }
  if (artifact.kind === "browser-video" && (!Number.isSafeInteger(artifact.durationMs)
    || artifact.durationMs < 1 || artifact.durationMs > MAX_VIDEO_DURATION_MS + VIDEO_DURATION_TOLERANCE_MS)) {
    throw new Error("Browser video duration is invalid");
  }
}

async function readValidatedPng(handle: FileHandle, candidate: BrowserScreenshotCandidate): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.size !== candidate.artifact.byteCount || metadata.size > MAX_SCREENSHOT_BYTES) {
    throw new Error("Browser screenshot file metadata does not match its descriptor");
  }
  const bytes = Buffer.alloc(24);
  const read = await handle.read(bytes, 0, bytes.length, 0);
  if (read.bytesRead < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Browser screenshot is not a valid PNG");
  }
  if (bytes.readUInt32BE(16) !== candidate.artifact.width || bytes.readUInt32BE(20) !== candidate.artifact.height) {
    throw new Error("Browser screenshot dimensions do not match its descriptor");
  }
}

type ProbeResult = { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };

async function probeWebm(handle: FileHandle, ffprobePath: string): Promise<ProbeResult> {
  if (!ffprobePath) throw new Error("Browser video probe is not configured");
  return await new Promise<ProbeResult>((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
      "-of", "json", "/proc/self/fd/3",
    ], { stdio: ["ignore", "pipe", "pipe", handle.fd] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cause) reject(cause);
      else {
        try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as ProbeResult); }
        catch (parseCause) { reject(new Error("Browser video probe returned invalid metadata", { cause: parseCause })); }
      }
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Browser video probe output exceeded its limit"));
      } else target.push(chunk);
    };
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    child.once("error", finish);
    child.once("close", (code) => code === 0 ? finish() : finish(new Error("Browser video probe rejected the media")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Browser video probe timed out"));
    }, 5_000);
    timer.unref();
  });
}

async function readValidatedWebm(handle: FileHandle, candidate: BrowserVideoCandidate, ffprobePath: string): Promise<void> {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== candidate.artifact.byteCount || before.size > MAX_VIDEO_BYTES) {
    throw new Error("Browser video file metadata does not match its descriptor");
  }
  const header = Buffer.alloc(Math.min(4096, before.size));
  const read = await handle.read(header, 0, header.length, 0);
  if (read.bytesRead < 16 || !header.subarray(0, 4).equals(EBML_SIGNATURE) || !header.subarray(0, read.bytesRead).includes(Buffer.from("webm"))) {
    throw new Error("Browser video is not a valid WebM");
  }
  const probed = await probeWebm(handle, ffprobePath);
  const streams = probed.streams ?? [];
  const video = streams[0];
  const durationMs = Math.round(Number(probed.format?.duration) * 1000);
  if (!probed.format?.format_name?.split(",").includes("webm") || streams.length !== 1
    || video?.codec_type !== "video" || video.codec_name !== "vp8") {
    throw new Error("Browser video must contain exactly one VP8 WebM stream");
  }
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > MAX_VIDEO_DURATION_MS + VIDEO_DURATION_TOLERANCE_MS) {
    throw new Error("Browser video duration exceeds its limit");
  }
  if (video.width !== candidate.artifact.width || video.height !== candidate.artifact.height
    || Math.abs(durationMs - candidate.artifact.durationMs) > 1_000) {
    throw new Error("Browser video metadata does not match its descriptor");
  }
  const after = await handle.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error("Browser video changed during validation");
  }
}

async function sessionUsage(directory: string): Promise<{ count: number; bytes: number }> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return { count: 0, bytes: 0 };
    throw cause;
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (TEMP_ARTIFACT.test(entry)) { await rm(join(directory, entry), { force: true }); continue; }
    if (!PUBLISHED_ARTIFACT.test(entry)) continue;
    const handle = await open(join(directory, entry), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) continue;
      count += 1;
      bytes += metadata.size;
    } finally { await handle.close(); }
  }
  return { count, bytes };
}

async function copyExact(source: FileHandle, output: FileHandle, byteCount: number): Promise<void> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < byteCount) {
    const length = Math.min(buffer.length, byteCount - position);
    const read = await source.read(buffer, 0, length, position);
    if (read.bytesRead !== length) throw new Error("Browser artifact changed while publishing");
    await output.write(buffer.subarray(0, length));
    position += length;
  }
}

async function adoptBrowserArtifactUnlocked(
  stateDir: string,
  sessionId: string,
  runtimeId: string,
  candidate: BrowserArtifactCandidate,
  ffprobePath: string,
): Promise<SessionArtifact> {
  validateCandidate(candidate);
  const stagingDirectory = runtimeStagingDirectory(stateDir, sessionId, runtimeId);
  const sourcePath = join(stagingDirectory, candidate.stagingName);
  let source: FileHandle | undefined;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const sourceMetadata = await source.stat();
    if (!sourceMetadata.isFile() || sourceMetadata.size !== candidate.artifact.byteCount) {
      throw new Error("Browser artifact file metadata does not match its descriptor");
    }

    const destinationDirectory = sessionDirectory(stateDir, sessionId);
    await ensurePrivateDirectory(destinationDirectory);
    const usage = await sessionUsage(destinationDirectory);
    if (usage.count >= MAX_SESSION_ARTIFACTS || usage.bytes + candidate.artifact.byteCount > MAX_SESSION_ARTIFACT_BYTES) {
      throw new Error("Browser artifact session quota exceeded");
    }

    const extension = extensionFor(candidate.artifact);
    const destination = artifactPath(stateDir, sessionId, candidate.artifact.id, extension);
    const temporary = join(destinationDirectory, `.piss-artifact-${candidate.artifact.id}-${randomUUID()}.tmp`);
    const output = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await copyExact(source, output, candidate.artifact.byteCount);
      const sourceAfterCopy = await source.stat();
      if (sourceAfterCopy.size !== sourceMetadata.size || sourceAfterCopy.ino !== sourceMetadata.ino) {
        throw new Error("Browser artifact changed while publishing");
      }
      await output.sync();

      // Validate the private temporary inode that will be linked into storage,
      // not the runtime-owned staging inode that remains writable during handoff.
      if (candidate.artifact.kind === "browser-video") await readValidatedWebm(output, candidate as BrowserVideoCandidate, ffprobePath);
      else await readValidatedPng(output, candidate as BrowserScreenshotCandidate);

      let published = false;
      try {
        await link(temporary, destination);
        published = true;
        await syncDirectory(destinationDirectory);
        await rm(temporary);
        await syncDirectory(destinationDirectory);
      } catch (cause) {
        if (published) {
          await rm(destination, { force: true }).catch(() => undefined);
          await syncDirectory(destinationDirectory).catch(() => undefined);
        }
        throw cause;
      }
    } finally {
      await output.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return candidate.artifact;
  } finally {
    await source?.close().catch(() => undefined);
    // A descriptor is a one-shot handoff. Rejected media must not accumulate
    // in runtime staging or be retried after its validation context is gone.
    await rm(sourcePath, { force: true }).catch(() => undefined);
  }
}

export function adoptBrowserArtifact(
  stateDir: string,
  sessionId: string,
  runtimeId: string,
  candidate: BrowserArtifactCandidate,
  ffprobePath = process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe",
): Promise<SessionArtifact> {
  return withSessionArtifactLock(stateDir, sessionId, () => adoptBrowserArtifactUnlocked(stateDir, sessionId, runtimeId, candidate, ffprobePath));
}

export function discardRuntimeBrowserVideo(stateDir: string, sessionId: string, runtimeId: string, recordingId: string): Promise<void> {
  if (!ARTIFACT_ID.test(recordingId)) return Promise.reject(new Error("Browser recording identity is invalid"));
  return withSessionArtifactLock(stateDir, sessionId, async () => {
    const directory = await open(runtimeStagingDirectory(stateDir, sessionId, runtimeId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      // Pin the validated runtime directory before unlinking the derived name.
      // This cannot follow a swapped parent directory or a final symlink.
      await rm(`/proc/self/fd/${directory.fd}/${recordingId}.webm`, { force: true });
    } finally { await directory.close(); }
  });
}

export function adoptBrowserScreenshot(stateDir: string, sessionId: string, runtimeId: string, candidate: BrowserScreenshotCandidate): Promise<SessionArtifact> {
  return adoptBrowserArtifact(stateDir, sessionId, runtimeId, candidate);
}

export async function openOwnedSessionArtifact(stateDir: string, sessionId: string, artifactId: string): Promise<OpenedOwnedSessionArtifact> {
  if (!ARTIFACT_ID.test(artifactId)) throw new Error("Artifact not found");
  for (const extension of ["png", "webm"] as const) {
    let handle: FileHandle;
    try { handle = await open(artifactPath(stateDir, sessionId, artifactId, extension), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    try {
      const metadata = await handle.stat();
      const maximum = extension === "png" ? MAX_SCREENSHOT_BYTES : MAX_VIDEO_BYTES;
      const signature = Buffer.alloc(extension === "png" ? 8 : 4);
      const read = await handle.read(signature, 0, signature.length, 0);
      const valid = extension === "png" ? signature.equals(PNG_SIGNATURE) : signature.equals(EBML_SIGNATURE);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum || read.bytesRead !== signature.length || !valid) throw new Error("Artifact not found");
      return {
        handle,
        kind: extension === "png" ? "browser-screenshot" : "browser-video",
        mediaType: extension === "png" ? "image/png" : "video/webm",
        byteCount: metadata.size,
        extension,
      };
    } catch (cause) { await handle.close(); throw cause; }
  }
  throw new Error("Artifact not found");
}

export async function loadOwnedSessionArtifact(stateDir: string, sessionId: string, artifactId: string): Promise<Buffer> {
  const opened = await openOwnedSessionArtifact(stateDir, sessionId, artifactId);
  try {
    if (opened.kind !== "browser-screenshot") throw new Error("Artifact not found");
    return await opened.handle.readFile();
  } finally { await opened.handle.close(); }
}

export function removeOwnedSessionArtifacts(stateDir: string, sessionId: string): Promise<void> {
  return withSessionArtifactLock(stateDir, sessionId, async () => {
    await Promise.all([
      rm(sessionDirectory(stateDir, sessionId), { recursive: true, force: true }),
      rm(join(stagingRoot(stateDir), storageKey(sessionId)), { recursive: true, force: true }),
    ]);
  });
}
