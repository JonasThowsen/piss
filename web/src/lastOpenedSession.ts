const LAST_OPENED_SESSION_KEY = "piss:last-opened-session";
const MAX_SESSION_ID_LENGTH = 512;

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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

export function writeLastOpenedSession(sessionId: string | undefined, storage: SessionStorage = localStorage): void {
  try {
    if (sessionId) storage.setItem(LAST_OPENED_SESSION_KEY, sessionId);
    else storage.removeItem(LAST_OPENED_SESSION_KEY);
  } catch {
    // Storage may be unavailable or full in private browsing modes.
  }
}
