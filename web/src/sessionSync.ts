import type { OwnedSession, OwnedSessionEvent } from "../../shared/domain.ts";
import { mergeSessionEvents } from "./timeline.ts";

export type SessionTransport = "connecting" | "live" | "fallback" | "offline";

export interface SessionSyncState {
  readonly sessionId?: string;
  readonly session?: OwnedSession;
  readonly cursor: number;
  readonly revision: number;
  readonly serverConfirmed: boolean;
  readonly runtimeGenerationConfirmed: boolean;
  readonly transport: SessionTransport;
  readonly streamValidated: boolean;
  readonly deleted: boolean;
  readonly visible: boolean;
  readonly reconnectAttempts: number;
  readonly lastSnapshotAt?: number;
  readonly mutationEpoch: number;
}

export interface SessionSyncRequest {
  readonly revision: number;
  readonly cursor: number;
  readonly runtimeId?: string;
}

export type SessionSyncInput =
  | { readonly type: "select"; readonly sessionId?: string }
  | { readonly type: "cachedSnapshot"; readonly session: OwnedSession }
  | { readonly type: "serverSnapshot"; readonly session: OwnedSession; readonly cursor: number; readonly receivedAt: number }
  | { readonly type: "snapshotReset"; readonly session: OwnedSession; readonly cursor: number; readonly receivedAt: number }
  | { readonly type: "sseDelta"; readonly session: OwnedSession; readonly cursor: number }
  | { readonly type: "httpIncremental"; readonly session: OwnedSession; readonly request: SessionSyncRequest }
  | { readonly type: "historicalPage"; readonly events: ReadonlyArray<OwnedSessionEvent> }
  | { readonly type: "runtimeGenerationChanged"; readonly session: OwnedSession; readonly cursor: number }
  | { readonly type: "streamValidated" }
  | { readonly type: "streamFailed" }
  | { readonly type: "heartbeatTimeout" }
  | { readonly type: "networkDisconnected" }
  | { readonly type: "networkReconnected" }
  | { readonly type: "visibilityRestored" }
  | { readonly type: "visibilityHidden" }
  | { readonly type: "sessionDeleted" };

export function initialSessionSyncState(sessionId?: string): SessionSyncState {
  return {
    ...(sessionId ? { sessionId } : {}),
    cursor: 0,
    revision: 0,
    serverConfirmed: false,
    runtimeGenerationConfirmed: false,
    transport: "connecting",
    streamValidated: false,
    deleted: false,
    visible: true,
    reconnectAttempts: 0,
    mutationEpoch: 0,
  };
}

function latestSequence(session: OwnedSession): number {
  return session.events.at(-1)?.sequence ?? 0;
}

function sameSession(state: SessionSyncState, session: OwnedSession): boolean {
  return state.sessionId === undefined || state.sessionId === session.id;
}

function mergeSession(current: OwnedSession | undefined, incoming: OwnedSession, replace: boolean): OwnedSession {
  if (!current || replace) return incoming;
  return { ...incoming, events: mergeSessionEvents(current.events, incoming.events) };
}

function mergeAuthoritativeSnapshotPreservingMissingEvents(current: OwnedSession, incoming: OwnedSession): OwnedSession {
  const authoritativeSequences = new Set(incoming.events.map((event) => event.sequence));
  const candidates = [
    ...current.events.filter((event) => !authoritativeSequences.has(event.sequence)),
    ...incoming.events,
  ].toSorted((left, right) => left.sequence - right.sequence);
  return { ...incoming, events: mergeSessionEvents([], candidates) };
}

function acceptServerState(
  state: SessionSyncState,
  session: OwnedSession,
  cursor: number,
  replace: boolean,
  snapshotAt?: number,
): SessionSyncState {
  if (!sameSession(state, session) || state.deleted) return state;
  const runtimeChanged = state.session !== undefined && state.session.runtimeId !== session.runtimeId;
  const staleCursor = cursor < state.cursor;
  const staleTimestamp = cursor === state.cursor && state.session !== undefined && Date.parse(session.lastActivityAt) < Date.parse(state.session.lastActivityAt);
  const staleWorkflowRevision = state.session?.workflow?.id === session.workflow?.id
    && (session.workflow?.revision ?? 0) < (state.session?.workflow?.revision ?? 0);
  if ((staleCursor || staleTimestamp || staleWorkflowRevision) && state.session) {
    if (runtimeChanged) return state;
    const events = mergeSessionEvents(session.events, state.session.events);
    if (events.length === state.session.events.length) return state;
    return { ...state, session: { ...state.session, events }, revision: state.revision + 1 };
  }
  // A same-generation reset at the cursor we already rendered may refresh
  // metadata, but it cannot prove that locally cached events at that cursor no
  // longer exist. Keep those immutable events to avoid a completed response
  // flickering away during cache-to-server hydration.
  const preserveEvents = replace && cursor === state.cursor && state.session !== undefined && !runtimeChanged;
  const next = preserveEvents
    ? mergeAuthoritativeSnapshotPreservingMissingEvents(state.session!, session)
    : mergeSession(state.session, session, replace);
  return {
    ...state,
    sessionId: session.id,
    session: next,
    cursor: Math.max(cursor, latestSequence(next), state.cursor),
    revision: state.revision + 1,
    serverConfirmed: true,
    runtimeGenerationConfirmed: true,
    deleted: false,
    ...(snapshotAt === undefined ? {} : { lastSnapshotAt: snapshotAt }),
    mutationEpoch: state.mutationEpoch + (runtimeChanged ? 1 : 0),
  };
}

export function sessionSyncRequest(state: SessionSyncState): SessionSyncRequest {
  return {
    revision: state.revision,
    cursor: state.cursor,
    ...(state.session ? { runtimeId: state.session.runtimeId } : {}),
  };
}

export function reduceSessionSync(state: SessionSyncState, input: SessionSyncInput): SessionSyncState {
  switch (input.type) {
    case "select":
      return input.sessionId === state.sessionId ? state : initialSessionSyncState(input.sessionId);
    case "cachedSnapshot":
      if (!sameSession(state, input.session) || state.serverConfirmed || state.deleted || state.session) return state;
      return {
        ...state,
        sessionId: input.session.id,
        session: input.session,
        cursor: latestSequence(input.session),
        revision: state.revision + 1,
        runtimeGenerationConfirmed: false,
      };
    case "serverSnapshot":
      return acceptServerState(state, input.session, input.cursor, false, input.receivedAt);
    case "snapshotReset":
      return acceptServerState(state, input.session, input.cursor, true, input.receivedAt);
    case "sseDelta":
      return acceptServerState(state, input.session, input.cursor, false);
    case "httpIncremental": { // A response started before newer authority cannot rewrite metadata.
      const incomingSequence = latestSequence(input.session);
      if (input.request.revision < state.revision && incomingSequence <= state.cursor) return state;
      if (input.request.runtimeId && state.session && input.request.runtimeId !== state.session.runtimeId && incomingSequence <= state.cursor) return state;
      return acceptServerState(state, input.session, Math.max(input.request.cursor, incomingSequence), false);
    }
    case "historicalPage": {
      if (!state.session || input.events.length === 0 || state.deleted) return state;
      const events = new Map<number, OwnedSessionEvent>();
      for (const event of [...input.events, ...state.session.events]) events.set(event.sequence, event);
      return {
        ...state,
        session: { ...state.session, events: [...events.values()].sort((left, right) => left.sequence - right.sequence) },
        revision: state.revision + 1,
      };
    }
    case "runtimeGenerationChanged":
      return acceptServerState(state, input.session, input.cursor, false);
    case "streamValidated":
      if (!state.serverConfirmed) return state;
      return { ...state, transport: "live", streamValidated: true, reconnectAttempts: 0 };
    case "streamFailed":
    case "heartbeatTimeout":
      return { ...state, transport: "fallback", streamValidated: false, reconnectAttempts: state.reconnectAttempts + 1 };
    case "networkDisconnected":
      return { ...state, transport: "offline", streamValidated: false };
    case "networkReconnected":
      return { ...state, transport: "connecting", streamValidated: false, reconnectAttempts: state.reconnectAttempts + 1 };
    case "visibilityRestored":
      return { ...state, visible: true, transport: state.transport === "offline" ? "offline" : "connecting", streamValidated: false };
    case "visibilityHidden":
      return { ...state, visible: false };
    case "sessionDeleted":
      return {
        ...state,
        session: undefined,
        deleted: true,
        serverConfirmed: true,
        runtimeGenerationConfirmed: false,
        transport: "fallback",
        streamValidated: false,
        revision: state.revision + 1,
        mutationEpoch: state.mutationEpoch + 1,
      };
  }
}

export function sessionForFastSwitchCache(state: SessionSyncState): OwnedSession | undefined {
  const status = state.session?.status;
  return state.serverConfirmed && state.runtimeGenerationConfirmed && status !== "starting" && status !== "stopping"
    ? state.session
    : undefined;
}

export function sessionForSettledCache(state: SessionSyncState): OwnedSession | undefined {
  const session = sessionForFastSwitchCache(state);
  return session?.status === "working" ? undefined : session;
}

export function shouldPollSession(state: SessionSyncState): boolean {
  return state.visible && !state.deleted && state.transport !== "live";
}
