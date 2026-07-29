import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as Schema from "effect/Schema";
import { OwnedSessionEvent } from "../../shared/domain.ts";

const MAX_TIMELINE_BYTES = 10 * 1024 * 1024;
const MAX_TIMELINE_EVENTS = 750;
const EVENTS_PER_CHUNK = 16;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_SIZE = 200;

const PersistedTimeline = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  events: Schema.Array(OwnedSessionEvent).check(Schema.isMaxLength(MAX_TIMELINE_EVENTS)),
});
const PersistedChunk = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  firstSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  lastSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  events: Schema.Array(OwnedSessionEvent).check(Schema.isMinLength(1), Schema.isMaxLength(EVENTS_PER_CHUNK)),
});
const PersistedOutput = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
  value: Schema.Unknown,
});
const decodeTimeline = Schema.decodeUnknownSync(PersistedTimeline);
const decodeChunk = Schema.decodeUnknownSync(PersistedChunk);
const decodeOutput = Schema.decodeUnknownSync(PersistedOutput);

export interface OwnedSessionTimeline {
  readonly sequence: number;
  readonly events: ReadonlyArray<OwnedSessionEvent>;
}

export interface OwnedSessionTimelinePage {
  readonly events: ReadonlyArray<OwnedSessionEvent>;
  readonly hasMore: boolean;
  readonly nextBeforeSequence: number | null;
}

function storageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timelinePath(directory: string, sessionId: string): string {
  return join(directory, `${storageKey(sessionId)}.json`);
}

function sessionDirectory(directory: string, sessionId: string): string {
  return join(directory, storageKey(sessionId));
}

function chunkStart(sequence: number): number {
  return Math.floor((sequence - 1) / EVENTS_PER_CHUNK) * EVENTS_PER_CHUNK + 1;
}

function chunkPath(directory: string, sessionId: string, sequence: number): string {
  return join(sessionDirectory(directory, sessionId), `events-${String(chunkStart(sequence)).padStart(16, "0")}.json`);
}

function outputPath(directory: string, sessionId: string, ref: string): string {
  return join(sessionDirectory(directory, sessionId), `output-${storageKey(ref)}.json`);
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<string> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new Error("Owned-session projection must be a regular file");
  if (metadata.size > maximumBytes) throw new Error("Owned-session projection exceeds its size limit");
  const buffer = Buffer.allocUnsafe(Number(metadata.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

async function readJsonFile(path: string, maximumBytes: number): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return JSON.parse(await readBounded(handle, maximumBytes));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("Owned-session projection directory must be a directory");
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function ensureSessionDirectory(directory: string, sessionId: string): Promise<string> {
  await ensureDirectory(directory);
  const target = sessionDirectory(directory, sessionId);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
  return target;
}

async function atomicWrite(destination: string, encoded: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    const directoryHandle = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

function withStableIds(sessionId: string, events: ReadonlyArray<OwnedSessionEvent>): Array<OwnedSessionEvent> {
  return events.map((event) => event.id ? event : { ...event, id: `${sessionId}:${event.sequence}` });
}

function validatedChunk(sessionId: string, expectedStart: number, value: unknown): Array<OwnedSessionEvent> {
  const chunk = decodeChunk(value);
  const events = withStableIds(sessionId, chunk.events);
  if (chunk.sessionId !== sessionId || chunk.firstSequence !== expectedStart) {
    throw new Error("Owned-session history chunk identity does not match its file");
  }
  if (chunk.lastSequence !== events.at(-1)?.sequence || events.some((event, index) =>
    chunkStart(event.sequence) !== expectedStart || index > 0 && event.sequence <= events[index - 1]!.sequence
  )) {
    throw new Error("Owned-session history chunk sequence metadata is invalid");
  }
  return events;
}

export async function loadOwnedSessionTimeline(directory: string, sessionId: string): Promise<OwnedSessionTimeline> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  let compact: OwnedSessionTimeline = { sequence: 0, events: [] };
  try {
    const timeline = decodeTimeline(await readJsonFile(timelinePath(directory, sessionId), MAX_TIMELINE_BYTES));
    if (timeline.sessionId !== sessionId) throw new Error("Owned-session timeline identity does not match its file");
    const events = withStableIds(sessionId, timeline.events);
    const latestEventSequence = events.at(-1)?.sequence ?? 0;
    if (timeline.sequence < latestEventSequence) throw new Error("Owned-session timeline sequence is behind its events");
    compact = { sequence: timeline.sequence, events };
  } catch (cause) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const latestHistory = await loadOwnedSessionTimelinePage(directory, sessionId, undefined, 1);
  return {
    sequence: Math.max(compact.sequence, latestHistory.events.at(-1)?.sequence ?? 0),
    events: compact.events,
  };
}

export async function persistOwnedSessionTimeline(
  directory: string,
  sessionId: string,
  timeline: OwnedSessionTimeline,
): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  const state = decodeTimeline({ version: 1, sessionId, sequence: timeline.sequence, events: timeline.events });
  const encoded = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(encoded) > MAX_TIMELINE_BYTES) throw new Error("Owned-session timeline would exceed its size limit");
  await ensureDirectory(directory);
  await atomicWrite(timelinePath(directory, sessionId), encoded);
}

export async function appendOwnedSessionTimelineEvent(
  directory: string,
  sessionId: string,
  event: OwnedSessionEvent,
): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("Owned-session event sequence is invalid");
  await ensureSessionDirectory(directory, sessionId);
  const destination = chunkPath(directory, sessionId, event.sequence);
  let events: Array<OwnedSessionEvent> = [];
  try {
    events = validatedChunk(sessionId, chunkStart(event.sequence), await readJsonFile(destination, MAX_CHUNK_BYTES));
  } catch (cause) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const existing = events.find((candidate) => candidate.sequence === event.sequence);
  if (existing) {
    if (existing.id === event.id) return;
    throw new Error("Owned-session history contains a conflicting sequence");
  }
  events.push(event);
  events.sort((left, right) => left.sequence - right.sequence);
  const state = decodeChunk({
    version: 1,
    sessionId,
    firstSequence: chunkStart(event.sequence),
    lastSequence: events.at(-1)!.sequence,
    events,
  });
  const encoded = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(encoded) > MAX_CHUNK_BYTES) throw new Error("Owned-session history chunk would exceed its size limit");
  await atomicWrite(destination, encoded);
}

export async function loadOwnedSessionTimelinePage(
  directory: string,
  sessionId: string,
  beforeSequence: number | undefined,
  requestedLimit: number,
): Promise<OwnedSessionTimelinePage> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requestedLimit)));
  const target = sessionDirectory(directory, sessionId);
  let names: string[];
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const historyEntries = entries.filter((entry) => /^events-\d{16}\.json$/u.test(entry.name));
    if (historyEntries.some((entry) => !entry.isFile())) throw new Error("Owned-session history chunks must be regular files");
    names = historyEntries.map((entry) => entry.name).sort().reverse();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return { events: [], hasMore: false, nextBeforeSequence: null };
    }
    throw cause;
  }
  const collected: OwnedSessionEvent[] = [];
  const cursor = beforeSequence ?? Number.MAX_SAFE_INTEGER;
  for (const name of names) {
    const expectedStart = Number(/^events-(\d{16})\.json$/u.exec(name)?.[1]);
    const events = validatedChunk(sessionId, expectedStart, await readJsonFile(join(target, name), MAX_CHUNK_BYTES));
    for (const event of events.toReversed()) {
      if (event.sequence < cursor) collected.push(event);
      if (collected.length > limit) break;
    }
    if (collected.length > limit) break;
  }
  const hasMore = collected.length > limit;
  const events = collected.slice(0, limit).reverse();
  return {
    events,
    hasMore,
    nextBeforeSequence: events.at(0)?.sequence ?? null,
  };
}

export async function persistOwnedSessionToolOutput(
  directory: string,
  sessionId: string,
  ref: string,
  value: unknown,
): Promise<{ readonly byteCount: number }> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  const valueEncoded = JSON.stringify(value);
  const byteCount = Buffer.byteLength(valueEncoded);
  if (byteCount > MAX_OUTPUT_BYTES) throw new Error("Owned-session tool output exceeds its size limit");
  const state = decodeOutput({ version: 1, sessionId, ref, byteCount, value });
  const encoded = `${JSON.stringify(state)}\n`;
  await ensureSessionDirectory(directory, sessionId);
  await atomicWrite(outputPath(directory, sessionId, ref), encoded);
  return { byteCount };
}

export async function loadOwnedSessionToolOutput(
  directory: string,
  sessionId: string,
  ref: string,
): Promise<{ readonly byteCount: number; readonly value: unknown }> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  const output = decodeOutput(await readJsonFile(outputPath(directory, sessionId, ref), MAX_OUTPUT_BYTES + 4 * 1024));
  if (output.sessionId !== sessionId || output.ref !== ref) throw new Error("Owned-session tool output identity does not match its file");
  if (Buffer.byteLength(JSON.stringify(output.value)) !== output.byteCount) throw new Error("Owned-session tool output byte count does not match its content");
  return { byteCount: output.byteCount, value: output.value };
}

export async function removeOwnedSessionTimeline(directory: string, sessionId: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  await rm(timelinePath(directory, sessionId), { force: true });
  await rm(sessionDirectory(directory, sessionId), { recursive: true, force: true });
}
