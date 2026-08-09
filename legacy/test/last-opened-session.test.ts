import assert from "node:assert/strict";
import test from "node:test";
import { readLastOpenedSession, readSessionOpenHistory, writeLastOpenedSession } from "../web/src/lastOpenedSession.ts";

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

test("opening sessions preserves both the latest session and per-session recency", () => {
  const storage = memoryStorage();

  writeLastOpenedSession("session-a", storage, 100);
  const history = writeLastOpenedSession("session-b", storage, 200);

  assert.equal(readLastOpenedSession(storage), "session-b");
  assert.deepEqual(history, { "session-b": 200, "session-a": 100 });
  assert.deepEqual(readSessionOpenHistory(storage), history);
});

test("reopening a session updates its recency without duplicating it", () => {
  const storage = memoryStorage();

  writeLastOpenedSession("session-a", storage, 100);
  writeLastOpenedSession("session-b", storage, 200);
  const history = writeLastOpenedSession("session-a", storage, 300);

  assert.deepEqual(history, { "session-a": 300, "session-b": 200 });
});

test("invalid session history is ignored", () => {
  const storage = memoryStorage({
    "piss:session-open-history": JSON.stringify({ valid: 10, bad: "recent", negative: -1 }),
  });

  assert.deepEqual(readSessionOpenHistory(storage), { valid: 10 });
});
