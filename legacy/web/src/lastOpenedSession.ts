const LAST_OPENED_SESSION_KEY = "piss:last-opened-session";
const SESSION_OPEN_HISTORY_KEY = "piss:session-open-history";
const MAX_SESSION_ID_LENGTH = 512;
const MAX_SESSION_HISTORY_LENGTH = 200;

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SessionOpenHistory = Readonly<Record<string, number>>;

export function readSessionOpenHistory(storage: SessionStorage = localStorage): SessionOpenHistory {
  try {
    const value: unknown = JSON.parse(storage.getItem(SESSION_OPEN_HISTORY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([sessionId, openedAt]) => sessionId.length > 0
        && sessionId.length <= MAX_SESSION_ID_LENGTH
        && typeof openedAt === "number"
        && Number.isFinite(openedAt)
        && openedAt >= 0)
      .sort((left, right) => (right[1] as number) - (left[1] as number))
      .slice(0, MAX_SESSION_HISTORY_LENGTH));
  } catch {
    return {};
  }
}

export function readLastOpenedSession(storage: SessionStorage = localStorage): string | undefined {
  try {
    const sessionId = storage.getItem(LAST_OPENED_SESSION_KEY);
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
      if (sessionId) storage.removeItem(LAST_OPENED_SESSION_KEY);
      return;
    }
    return sessionId;
  } catch {
    return;
  }
}

export function writeLastOpenedSession(
  sessionId: string | undefined,
  storage: SessionStorage = localStorage,
  openedAt = Date.now(),
): SessionOpenHistory {
  const history = readSessionOpenHistory(storage);
  try {
    if (!sessionId) {
      storage.removeItem(LAST_OPENED_SESSION_KEY);
      return history;
    }
    storage.setItem(LAST_OPENED_SESSION_KEY, sessionId);
    const nextHistory = Object.fromEntries([
      [sessionId, openedAt],
      ...Object.entries(history).filter(([id]) => id !== sessionId),
    ].slice(0, MAX_SESSION_HISTORY_LENGTH));
    storage.setItem(SESSION_OPEN_HISTORY_KEY, JSON.stringify(nextHistory));
    return nextHistory;
  } catch {
    // Storage may be unavailable or full in private browsing modes.
    return history;
  }
}
