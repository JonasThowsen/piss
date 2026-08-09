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

test("session picker orders attention states before fuzzy ranking", () => {
  const items = sessionPickerItems(sessions, workspaces);

  assert.deepEqual(items[0]?.action, { _tag: "SelectSession", sessionId: "invoice" });
  assert.equal(items[0]?.meta, "Finished");
  assert.equal(items[1]?.description, "ERP · feat/passkeys");
  assert.deepEqual(searchPickerItems(items, "pay inv").map((match) => match.item.action.sessionId), ["invoice"]);
  assert.deepEqual(searchPickerItems(items, "auth pass").map((match) => match.item.action.sessionId), ["auth"]);
});

test("sessions stay grouped by workspace and use opened recency instead of activity", () => {
  const olderAuth = {
    id: "older-auth",
    workspaceId: "erp",
    name: "Older authentication cleanup",
    branch: "auth/older",
    status: "finished" as const,
    lastActivityAt: "2026-01-05T00:00:00.000Z",
  };
  const recentAuth = {
    id: "recent-auth",
    workspaceId: "erp",
    name: "Passkey cleanup",
    branch: "auth/follow-up",
    status: "finished" as const,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  };
  const openedAt = { "older-auth": 100, "recent-auth": 200, invoice: 300 };
  const pickerSessions = [...sessions, olderAuth, recentAuth];
  const items = sessionPickerItems(pickerSessions, workspaces, openedAt);

  assert.equal(fuzzySubsequenceMatcher("atn", "Authentication refactor") !== undefined, true);
  assert.deepEqual(searchPickerItems(items, "").map((match) => match.item.action.sessionId), ["recent-auth", "older-auth", "invoice", "auth"]);
  assert.deepEqual(searchPickerItems(items, "auth").map((match) => match.item.action.sessionId), ["recent-auth", "older-auth", "auth"]);
  assert.deepEqual(searchPickerItems(items, "missing").map((match) => match.item.action.sessionId), []);

  const refreshed = pickerSessions.map((session) => ({
    ...session,
    lastActivityAt: session.id === "older-auth" ? "2030-01-01T00:00:00.000Z" : session.lastActivityAt,
  }));
  assert.deepEqual(
    sessionPickerItems(refreshed, workspaces, openedAt).map((item) => item.action.sessionId),
    items.map((item) => item.action.sessionId),
  );
});

test("picker matcher is replaceable without changing picker items", () => {
  const exactMatcher: PickerMatcher = (query, candidate) => candidate === query ? 1 : undefined;
  const items = sessionPickerItems(sessions, workspaces);

  assert.deepEqual(searchPickerItems(items, "ERP", exactMatcher).map((match) => match.item.action.sessionId), ["auth"]);
  assert.deepEqual(searchPickerItems(items, "erp", exactMatcher), []);
});
