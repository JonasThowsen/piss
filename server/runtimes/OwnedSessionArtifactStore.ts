import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SessionArtifact } from "../../shared/domain.ts";

// TODO(tracer): Add bounded WebM adoption and HTTP range metadata after this
// screenshot-only production path has been verified in the packaged service.
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_BYTES = 250 * 1024 * 1024;
export const MAX_SESSION_ARTIFACTS = 100;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionOperationTails = new Map<string, Promise<void>>();

export interface BrowserScreenshotCandidate {
  readonly version: 1;
  readonly stagingName: string;
  readonly artifact: SessionArtifact;
}

function storageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rootDirectory(stateDir: string): string {
  return join(stateDir, "browser-artifacts");
}

function sessionDirectory(stateDir: string, sessionId: string): string {
  return join(rootDirectory(stateDir), storageKey(sessionId));
}

function stagingRoot(stateDir: string): string {
  return join(stateDir, "browser-staging");
}

export function runtimeStagingDirectory(stateDir: string, sessionId: string, runtimeId: string): string {
  return join(stagingRoot(stateDir), storageKey(sessionId), storageKey(runtimeId));
}

function artifactPath(stateDir: string, sessionId: string, artifactId: string): string {
  return join(sessionDirectory(stateDir, sessionId), `${artifactId}.png`);
}

async function withSessionArtifactLock<T>(stateDir: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = sessionDirectory(stateDir, sessionId);
  const previous = sessionOperationTails.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  sessionOperationTails.set(key, settled);
  try { return await result; }
  finally {
    if (sessionOperationTails.get(key) === settled) sessionOperationTails.delete(key);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.chmod(0o700); }
  finally { await handle.close(); }
}

export async function prepareRuntimeArtifactStaging(stateDir: string, sessionId: string, runtimeId: string): Promise<string> {
  const sessionRoot = join(stagingRoot(stateDir), storageKey(sessionId));
  const directory = runtimeStagingDirectory(stateDir, sessionId, runtimeId);
  // A session owns at most one runtime. Clearing the session staging root also
  // removes files left by an unexpected control-plane stop before a resume.
  await rm(sessionRoot, { recursive: true, force: true });
  await ensurePrivateDirectory(directory);
  return directory;
}

export async function removeRuntimeArtifactStaging(stateDir: string, sessionId: string, runtimeId: string): Promise<void> {
  await rm(runtimeStagingDirectory(stateDir, sessionId, runtimeId), { recursive: true, force: true });
}

function validateCandidate(candidate: BrowserScreenshotCandidate): void {
  if (candidate.version !== 1 || candidate.artifact.kind !== "browser-screenshot" || candidate.artifact.mediaType !== "image/png") {
    throw new Error("Unsupported browser artifact descriptor");
  }
  if (!ARTIFACT_ID.test(candidate.artifact.id) || candidate.stagingName !== `${candidate.artifact.id}.png`) {
    throw new Error("Browser artifact identity is invalid");
  }
  if (!Number.isSafeInteger(candidate.artifact.byteCount) || candidate.artifact.byteCount < 1 || candidate.artifact.byteCount > MAX_SCREENSHOT_BYTES) {
    throw new Error("Browser screenshot exceeds its size limit");
  }
  if (!Number.isSafeInteger(candidate.artifact.width) || candidate.artifact.width < 1 || candidate.artifact.width > 16_384
    || !Number.isSafeInteger(candidate.artifact.height) || candidate.artifact.height < 1 || candidate.artifact.height > 65_535) {
    throw new Error("Browser screenshot dimensions are invalid");
  }
}

async function readValidatedPng(handle: FileHandle, candidate: BrowserScreenshotCandidate): Promise<Buffer> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.size !== candidate.artifact.byteCount || metadata.size > MAX_SCREENSHOT_BYTES) {
    throw new Error("Browser screenshot file metadata does not match its descriptor");
  }
  const bytes = await handle.readFile();
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Browser screenshot is not a valid PNG");
  }
  if (bytes.readUInt32BE(16) !== candidate.artifact.width || bytes.readUInt32BE(20) !== candidate.artifact.height) {
    throw new Error("Browser screenshot dimensions do not match its descriptor");
  }
  return bytes;
}

async function sessionUsage(directory: string): Promise<{ count: number; bytes: number }> {
  let entries;
  try { entries = await readdir(directory); }
  catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return { count: 0, bytes: 0 };
    throw cause;
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!ARTIFACT_ID.test(entry.replace(/\.png$/, "")) || !entry.endsWith(".png")) continue;
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

async function adoptBrowserScreenshotUnlocked(
  stateDir: string,
  sessionId: string,
  runtimeId: string,
  candidate: BrowserScreenshotCandidate,
): Promise<SessionArtifact> {
  validateCandidate(candidate);
  const stagingDirectory = runtimeStagingDirectory(stateDir, sessionId, runtimeId);
  const source = await open(join(stagingDirectory, candidate.stagingName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try { bytes = await readValidatedPng(source, candidate); }
  finally { await source.close(); }

  const destinationDirectory = sessionDirectory(stateDir, sessionId);
  await ensurePrivateDirectory(destinationDirectory);
  const usage = await sessionUsage(destinationDirectory);
  if (usage.count >= MAX_SESSION_ARTIFACTS || usage.bytes + bytes.length > MAX_SESSION_ARTIFACT_BYTES) {
    throw new Error("Browser screenshot session quota exceeded");
  }

  const destination = artifactPath(stateDir, sessionId, candidate.artifact.id);
  const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (cause) {
    await output.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw cause;
  }
  await output.close();
  await rm(join(stagingDirectory, candidate.stagingName), { force: true });
  return candidate.artifact;
}

export function adoptBrowserScreenshot(
  stateDir: string,
  sessionId: string,
  runtimeId: string,
  candidate: BrowserScreenshotCandidate,
): Promise<SessionArtifact> {
  return withSessionArtifactLock(stateDir, sessionId, () => adoptBrowserScreenshotUnlocked(stateDir, sessionId, runtimeId, candidate));
}

export async function loadOwnedSessionArtifact(stateDir: string, sessionId: string, artifactId: string): Promise<Buffer> {
  if (!ARTIFACT_ID.test(artifactId)) throw new Error("Artifact not found");
  const handle = await open(artifactPath(stateDir, sessionId, artifactId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SCREENSHOT_BYTES) throw new Error("Artifact not found");
    const bytes = await handle.readFile();
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Artifact not found");
    return bytes;
  } finally { await handle.close(); }
}

export function removeOwnedSessionArtifacts(stateDir: string, sessionId: string): Promise<void> {
  return withSessionArtifactLock(stateDir, sessionId, async () => {
    await Promise.all([
      rm(sessionDirectory(stateDir, sessionId), { recursive: true, force: true }),
      rm(join(stagingRoot(stateDir), storageKey(sessionId)), { recursive: true, force: true }),
    ]);
  });
}
