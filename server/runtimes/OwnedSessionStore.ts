import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import * as Schema from "effect/Schema";
import { AvailableModel, CompactionState, InteractiveRequest, OwnedSessionStatus, SessionUsage, ThinkingLevel, WorkspaceId } from "../../shared/domain.ts";

const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PERSISTED_SESSIONS = 100;
const MAX_ACCEPTED_COMMAND_IDS = 128;

const Identity = Schema.Struct({
  device: Schema.String.check(Schema.isPattern(/^\d+$/)),
  inode: Schema.String.check(Schema.isPattern(/^\d+$/)),
});

export const PersistedOwnedSession = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  runtimeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  workspaceId: WorkspaceId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  branch: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)))),
  status: OwnedSessionStatus,
  resumeAfterRestart: Schema.optional(Schema.Boolean),
  piSessionId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  sessionFile: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16 * 1024))),
  sessionFileIdentity: Schema.NullOr(Identity),
  workspaceIdentity: Identity,
  model: Schema.NullOr(AvailableModel),
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  usage: Schema.optional(Schema.NullOr(SessionUsage)),
  autoCompactionEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  pendingMessageCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  compaction: Schema.optional(CompactionState),
  createdAt: Schema.String,
  lastActivityAt: Schema.String,
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  interactiveRequests: Schema.optional(Schema.Array(InteractiveRequest).check(Schema.isMaxLength(8))),
  acceptedCommandIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ).check(Schema.isMaxLength(MAX_ACCEPTED_COMMAND_IDS)),
});
export type PersistedOwnedSession = typeof PersistedOwnedSession.Type;

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(PersistedOwnedSession).check(Schema.isMaxLength(MAX_PERSISTED_SESSIONS)),
});
const decodeState = Schema.decodeUnknownSync(PersistedState);

async function readBounded(handle: FileHandle): Promise<string> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new Error("Owned-session metadata must be a regular file");
  if (metadata.size > MAX_STORAGE_BYTES) throw new Error("Owned-session metadata exceeds its size limit");
  const buffer = Buffer.allocUnsafe(Number(metadata.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

export async function loadOwnedSessions(path: string): Promise<ReadonlyArray<PersistedOwnedSession>> {
  if (!isAbsolute(path)) throw new Error("Owned-session metadata path must be absolute");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const state = decodeState(JSON.parse(await readBounded(handle)));
    const ids = new Set<string>();
    for (const session of state.sessions) {
      if (ids.has(session.id)) throw new Error(`Duplicate persisted owned-session ID ${session.id}`);
      ids.add(session.id);
      if (session.sessionFile !== null && !isAbsolute(session.sessionFile)) {
        throw new Error("Persisted Pi session paths must be absolute");
      }
    }
    return state.sessions;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function persistOwnedSessions(path: string, sessions: ReadonlyArray<PersistedOwnedSession>): Promise<void> {
  if (sessions.length > MAX_PERSISTED_SESSIONS) throw new Error("Owned-session count exceeds its limit");
  // Decode our own output before touching disk so programmer errors cannot replace
  // the last known-good state file.
  const state = decodeState({ version: 1, sessions });
  const encoded = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw new Error("Owned-session metadata would exceed its size limit");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}
