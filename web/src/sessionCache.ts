import * as Schema from "effect/Schema";
import { OwnedSession, type OwnedSession as OwnedSessionType } from "../../shared/domain.ts";

const DATABASE_NAME = "piss-session-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";
const MAX_CACHED_SESSIONS = 20;

interface CachedSessionRecord {
  readonly id: string;
  readonly cachedAt: number;
  readonly session: unknown;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open the session cache"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("cachedAt", "cachedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Session cache request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Session cache transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Session cache transaction was aborted"));
  });
}

export async function readCachedSession(sessionId: string): Promise<OwnedSessionType | undefined> {
  if (!("indexedDB" in globalThis)) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestResult(transaction.objectStore(STORE_NAME).get(sessionId)) as CachedSessionRecord | undefined;
    await transactionComplete(transaction);
    if (!record) return;
    return Schema.decodeUnknownSync(OwnedSession)(record.session);
  } catch {
    await removeCachedSession(sessionId).catch(() => undefined);
    return;
  } finally {
    database.close();
  }
}

export async function writeCachedSession(session: OwnedSessionType): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const validated = Schema.decodeUnknownSync(OwnedSession)(session);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put({ id: validated.id, cachedAt: Date.now(), session: validated } satisfies CachedSessionRecord);
    const records = await requestResult(store.index("cachedAt").getAll()) as CachedSessionRecord[];
    for (const record of records.slice(0, Math.max(0, records.length - MAX_CACHED_SESSIONS))) store.delete(record.id);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function removeCachedSession(sessionId: string): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(sessionId);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
