import assert from "node:assert/strict";
import test from "node:test";
import { consumeUpdateActivation, requestUpdateActivation } from "../web/src/updateActivation.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("only an explicitly requested service-worker activation reloads its tab", () => {
  const initiatingTab = memoryStorage();
  const readingTab = memoryStorage();

  requestUpdateActivation(initiatingTab);

  assert.equal(consumeUpdateActivation(readingTab), false);
  assert.equal(consumeUpdateActivation(initiatingTab), true);
  assert.equal(consumeUpdateActivation(initiatingTab), false, "the reload intent is consumed once");
});
