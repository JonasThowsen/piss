import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as Schema from "effect/Schema";
import { OwnedSessionEvent } from "../../shared/domain.ts";

const MAX_TIMELINE_BYTES = 10 * 1024 * 1024;
const MAX_TIMELINE_EVENTS = 750;

const PersistedTimeline = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  events: Schema.Array(OwnedSessionEvent).check(Schema.isMaxLength(MAX_TIMELINE_EVENTS)),
});
const decodeTimeline = Schema.decodeUnknownSync(PersistedTimeline);

export interface OwnedSessionTimeline {
  readonly sequence: number;
  readonly events: ReadonlyArray<OwnedSessionEvent>;
}

function timelinePath(directory: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${key}.json`);
}

async function readBounded(handle: FileHandle): Promise<string> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new Error("Owned-session timeline must be a regular file");
  if (metadata.size > MAX_TIMELINE_BYTES) throw new Error("Owned-session timeline exceeds its size limit");
  const buffer = Buffer.allocUnsafe(Number(metadata.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

export async function loadOwnedSessionTimeline(directory: string, sessionId: string): Promise<OwnedSessionTimeline> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  let handle: FileHandle | undefined;
  try {
    handle = await open(timelinePath(directory, sessionId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const timeline = decodeTimeline(JSON.parse(await readBounded(handle)));
    if (timeline.sessionId !== sessionId) throw new Error("Owned-session timeline identity does not match its file");
    const latestEventSequence = timeline.events.at(-1)?.sequence ?? 0;
    if (timeline.sequence < latestEventSequence) throw new Error("Owned-session timeline sequence is behind its events");
    return { sequence: timeline.sequence, events: timeline.events };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return { sequence: 0, events: [] };
    }
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = timelinePath(directory, sessionId);
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
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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

export async function removeOwnedSessionTimeline(directory: string, sessionId: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Owned-session timeline directory must be absolute");
  await rm(timelinePath(directory, sessionId), { force: true });
}
