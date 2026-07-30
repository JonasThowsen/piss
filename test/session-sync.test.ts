import assert from "node:assert/strict";
import test from "node:test";
import type { OwnedSession, OwnedSessionEvent } from "../shared/domain.ts";
import {
  initialSessionSyncState,
  reduceSessionSync,
  sessionForSettledCache,
  sessionSyncRequest,
  shouldPollSession,
  type SessionSyncInput,
  type SessionSyncState,
} from "../web/src/sessionSync.ts";

function event(sequence: number): OwnedSessionEvent {
  return { id: `session-1:${sequence}`, sequence, type: "message_end", timestamp: `2026-01-01T00:00:0${sequence}.000Z`, data: { message: { role: "assistant", content: `event ${sequence}` } } };
}

function session(events: ReadonlyArray<OwnedSessionEvent>, overrides: Partial<OwnedSession> = {}): OwnedSession {
  return {
    id: "session-1",
    runtimeId: "runtime-1",
    workspaceId: "workspace-1" as OwnedSession["workspaceId"],
    name: "Session",
    branch: null,
    status: "idle",
    pid: 123,
    piSessionId: "pi-1",
    sessionFile: "/redacted/session.jsonl",
    model: null,
    thinkingLevel: null,
    usage: null,
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    compaction: { status: "idle", reason: null, tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: events.at(-1)?.timestamp ?? "2026-01-01T00:00:00.000Z",
    events,
    interactiveRequests: [],
    error: null,
    ...overrides,
  };
}

function apply(inputs: ReadonlyArray<SessionSyncInput>): SessionSyncState {
  return inputs.reduce(reduceSessionSync, initialSessionSyncState("session-1"));
}

function projection(state: SessionSyncState) {
  return {
    runtimeId: state.session?.runtimeId,
    status: state.session?.status,
    sequences: state.session?.events.map((item) => item.sequence),
    cursor: state.cursor,
    confirmed: state.runtimeGenerationConfirmed,
  };
}

test("snapshot and delta permutations converge without gaps", () => {
  const snapshot: SessionSyncInput = { type: "serverSnapshot", session: session([event(1)]), cursor: 1, receivedAt: 1 };
  const delta: SessionSyncInput = { type: "sseDelta", session: session([event(2)], { status: "working" }), cursor: 2 };
  const duplicate: SessionSyncInput = { ...delta, type: "sseDelta" };
  const reset: SessionSyncInput = { type: "snapshotReset", session: session([event(1)]), cursor: 1, receivedAt: 2 };

  const expected = projection(apply([snapshot, delta, duplicate, reset]));
  for (const inputs of [
    [reset, snapshot, delta, duplicate],
    [delta, snapshot, reset, duplicate],
    [snapshot, duplicate, reset, delta],
  ]) {
    assert.deepEqual(projection(apply(inputs)), expected);
  }
  assert.deepEqual(expected.sequences, [1, 2]);
  assert.equal(expected.status, "working");
});

test("cached and stale HTTP responses cannot overwrite newer server state", () => {
  const initial = reduceSessionSync(initialSessionSyncState("session-1"), {
    type: "cachedSnapshot",
    session: session([event(1)], { runtimeId: "runtime-old", status: "stopped" }),
  });
  const request = sessionSyncRequest(initial);
  const live = reduceSessionSync(initial, {
    type: "sseDelta",
    session: session([event(1), event(2)], { status: "working" }),
    cursor: 2,
  });
  const stale = reduceSessionSync(live, {
    type: "httpIncremental",
    request,
    session: session([], { runtimeId: "runtime-old", status: "stopped", lastActivityAt: "2026-01-01T00:00:01.000Z" }),
  });
  const lateCache = reduceSessionSync(stale, { type: "cachedSnapshot", session: session([event(1)], { status: "crashed" }) });
  assert.deepEqual(projection(lateCache), projection(live));
});

test("same-cursor hydration cannot discard a cached final response", () => {
  let state = reduceSessionSync(initialSessionSyncState("session-1"), {
    type: "cachedSnapshot",
    session: session([event(1), event(2)], { status: "finished" }),
  });
  const authoritativeEvent = { ...event(1), timestamp: "2026-01-01T00:00:09.000Z", data: { message: { role: "assistant", content: "authoritative event 1" } } };
  state = reduceSessionSync(state, {
    type: "snapshotReset",
    session: session([authoritativeEvent], { status: "idle", lastActivityAt: "2026-01-01T00:00:09.000Z" }),
    cursor: 2,
    receivedAt: 2,
  });

  assert.deepEqual(state.session?.events.map((item) => item.sequence), [1, 2]);
  assert.equal(state.session?.events[0]?.timestamp, authoritativeEvent.timestamp, "server events replace cached events at the same sequence");
  assert.equal(state.session?.status, "idle", "newer server metadata still wins");
  assert.equal(state.serverConfirmed, true);
});

test("snapshot reset replaces at its authoritative cursor and duplicates are harmless", () => {
  let state = apply([{ type: "serverSnapshot", session: session([event(1), event(2)]), cursor: 2, receivedAt: 1 }]);
  state = reduceSessionSync(state, { type: "snapshotReset", session: session([event(7)], { lastActivityAt: "2026-01-01T00:00:07.000Z" }), cursor: 7, receivedAt: 2 });
  const duplicate = reduceSessionSync(state, { type: "sseDelta", session: session([event(7)]), cursor: 7 });
  assert.deepEqual(state.session?.events.map((item) => item.sequence), [7]);
  assert.deepEqual(duplicate.session?.events.map((item) => item.sequence), [7]);
});

test("runtime generation replacement invalidates unsafe mutations", () => {
  const current = apply([{ type: "serverSnapshot", session: session([event(1)]), cursor: 1, receivedAt: 1 }]);
  const changed = reduceSessionSync(current, {
    type: "runtimeGenerationChanged",
    session: session([event(2)], { runtimeId: "runtime-2", status: "working" }),
    cursor: 2,
  });
  assert.equal(changed.runtimeGenerationConfirmed, true);
  assert.equal(changed.mutationEpoch, current.mutationEpoch + 1);
  assert.equal(changed.session?.runtimeId, "runtime-2");
});

test("transport becomes live only after authoritative data and controls polling", () => {
  let state = initialSessionSyncState("session-1");
  state = reduceSessionSync(state, { type: "streamValidated" });
  assert.equal(state.transport, "connecting");
  assert.equal(shouldPollSession(state), true);
  state = reduceSessionSync(state, { type: "serverSnapshot", session: session([event(1)]), cursor: 1, receivedAt: 1 });
  state = reduceSessionSync(state, { type: "streamValidated" });
  assert.equal(state.transport, "live");
  assert.equal(shouldPollSession(state), false);
  state = reduceSessionSync(state, { type: "heartbeatTimeout" });
  assert.equal(state.transport, "fallback");
  assert.equal(shouldPollSession(state), true);
  assert.ok(sessionForSettledCache(state));
  state = reduceSessionSync(state, { type: "sessionDeleted" });
  assert.equal(state.session, undefined);
  assert.equal(state.mutationEpoch, 1);
});
