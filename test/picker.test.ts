import assert from "node:assert/strict";
import test from "node:test";
import { fuzzySubsequenceMatcher, searchPickerItems, type PickerMatcher } from "../web/src/picker.ts";
import { sessionPickerItems } from "../web/src/sessionPicker.ts";

const workspaces = [
  { id: "erp", name: "ERP", root: "/code/erp" },
  { id: "payments", name: "Payments", root: "/code/payments" },
];

const sessions = [
  { id: "auth", workspaceId: "erp", name: "Authentication refactor", branch: "feat/passkeys", status: "working" as const, lastActivityAt: "2026-01-02T00:00:00.000Z" },
  { id: "invoice", workspaceId: "payments", name: "Invoice migration", branch: "fix/ledger", status: "finished" as const, lastActivityAt: "2026-01-03T00:00:00.000Z" },
];

test("session picker source stays separate from fuzzy ranking", () => {
  const items = sessionPickerItems(sessions, workspaces);

  assert.deepEqual(items[0]?.action, { _tag: "SelectSession", sessionId: "auth" });
  assert.equal(items[0]?.description, "ERP · feat/passkeys");
  assert.equal(items[1]?.meta, "Finished");
  assert.deepEqual(searchPickerItems(items, "pay inv").map((match) => match.item.action.sessionId), ["invoice"]);
  assert.deepEqual(searchPickerItems(items, "auth pass").map((match) => match.item.action.sessionId), ["auth"]);
});

test("fuzzy search ranks strong label matches and uses recency only as a tie-breaker", () => {
  const items = sessionPickerItems(sessions, workspaces);

  assert.equal(fuzzySubsequenceMatcher("atn", "Authentication refactor") !== undefined, true);
  assert.equal(searchPickerItems(items, "auth")[0]?.item.action.sessionId, "auth");
  assert.deepEqual(searchPickerItems(items, "").map((match) => match.item.action.sessionId), ["invoice", "auth"]);
  assert.deepEqual(searchPickerItems(items, "missing").map((match) => match.item.action.sessionId), []);
});

test("picker matcher is replaceable without changing picker items", () => {
  const exactMatcher: PickerMatcher = (query, candidate) => candidate === query ? 1 : undefined;
  const items = sessionPickerItems(sessions, workspaces);

  assert.deepEqual(searchPickerItems(items, "ERP", exactMatcher).map((match) => match.item.action.sessionId), ["auth"]);
  assert.deepEqual(searchPickerItems(items, "erp", exactMatcher), []);
});
