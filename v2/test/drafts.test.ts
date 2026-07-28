import assert from "node:assert/strict";
import test from "node:test";
import { draftStorageKey, pruneDrafts, readDraft, removeDraft, writeDraft } from "../web/src/drafts.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("persists, restores, and removes bounded V2 session drafts", () => {
  const storage = memoryStorage();
  writeDraft("session-1", "keep this", "followUp", storage);
  assert.deepEqual(readDraft("session-1", storage), {
    text: "keep this",
    delivery: "followUp",
    updatedAt: readDraft("session-1", storage)?.updatedAt,
  });
  removeDraft("session-1", storage);
  assert.equal(readDraft("session-1", storage), undefined);
});

test("drops expired or malformed V2 drafts", () => {
  const storage = memoryStorage();
  storage.setItem("piss:v2:draft:expired", JSON.stringify({ text: "old", delivery: "steer", updatedAt: 0 }));
  storage.setItem("piss:v2:draft:malformed", JSON.stringify({ text: 42 }));
  storage.setItem("unrelated", "keep");
  pruneDrafts(storage);
  assert.equal(readDraft("expired", storage), undefined);
  assert.equal(readDraft("malformed", storage), undefined);
  assert.equal(storage.getItem(draftStorageKey("expired")), null);
  assert.equal(storage.getItem(draftStorageKey("malformed")), null);
  assert.equal(storage.getItem("unrelated"), "keep");
});
