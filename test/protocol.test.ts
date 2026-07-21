import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainStatus } from "../extensions/review.ts";
import { decodedBase64Bytes, isBridgeToServer, isBrowserToServer, isServerToBridge, validateImages } from "../shared/protocol.ts";

test("computes decoded base64 size", () => {
  assert.equal(decodedBase64Bytes(Buffer.from("hello").toString("base64")), 5);
  assert.equal(decodedBase64Bytes("%%%"), Number.POSITIVE_INFINITY);
});

test("accepts supported images and rejects malformed or mislabeled input", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
  assert.equal(validateImages([{ mediaType: "image/png", data: png }]), undefined);
  assert.match(validateImages([{ mediaType: "image/png", data: "not base64!" }]) ?? "", /Malformed/);
  assert.match(validateImages([{ mediaType: "image/jpeg", data: png }]) ?? "", /do not match/);
});

test("validates browser messages at runtime", () => {
  assert.equal(isBrowserToServer({ type: "browser.ping" }), true);
  assert.equal(isBrowserToServer({ type: "browser.archive", sessionId: "session", runtimeId: "runtime" }), true);
  assert.equal(isBrowserToServer({ type: "browser.review_request", requestId: "review", sessionId: "session", runtimeId: "runtime" }), true);
  assert.equal(isBrowserToServer({ type: "browser.models_request", requestId: "models", sessionId: "session", runtimeId: "runtime" }), true);
  assert.equal(isBrowserToServer({ type: "browser.set_model", requestId: "model", sessionId: "session", runtimeId: "runtime", provider: "anthropic", modelId: "opus" }), true);
  assert.equal(isBrowserToServer({ type: "browser.set_thinking_level", requestId: "effort", sessionId: "session", runtimeId: "runtime", level: "high" }), true);
  assert.equal(isBrowserToServer({ type: "browser.set_thinking_level", requestId: "effort", sessionId: "session", runtimeId: "runtime", level: "extreme" }), false);
  assert.equal(isBrowserToServer({ type: "browser.push_subscribe", subscription: { endpoint: "https://push.example/id", keys: { p256dh: "key", auth: "auth" } } }), true);
  assert.equal(isBrowserToServer({ type: "browser.command", commandId: "id", sessionId: "session", runtimeId: "runtime", action: "shell", text: "no" }), false);
  assert.equal(isBrowserToServer({ type: "browser.subscribe", sessionId: "session", runtimeId: "runtime", after: 42 }), true);
  assert.equal(isBrowserToServer({ type: "browser.subscribe", sessionId: "session", runtimeId: "", after: 42 }), false);
  assert.equal(isBrowserToServer({ type: "browser.subscribe", sessionId: "" }), false);
});

test("parses normal, untracked, and renamed porcelain records", () => {
  assert.deepEqual(parsePorcelainStatus(" M src/app.ts\0?? new file.ts\0R  renamed.ts\0old.ts\0"), [
    { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" },
    { path: "new file.ts", indexStatus: "?", worktreeStatus: "?" },
    { path: "renamed.ts", indexStatus: "R", worktreeStatus: " " },
  ]);
});

test("validates broker commands before the extension handles them", () => {
  assert.equal(isServerToBridge({ type: "bridge.command", commandId: "review", runtimeId: "runtime", action: "review" }), true);
  assert.equal(isServerToBridge({ type: "bridge.command", commandId: "model", runtimeId: "runtime", action: "set_model", provider: "anthropic", modelId: "opus" }), true);
  assert.equal(isServerToBridge({ type: "bridge.command", commandId: "effort", runtimeId: "runtime", action: "set_thinking_level", thinkingLevel: "max" }), true);
  assert.equal(isServerToBridge({ type: "bridge.command", commandId: "bad", runtimeId: "runtime", action: "shell" }), false);
});

test("validates bridge registration and event names", () => {
  const session = {
    sessionId: "session",
    runtimeId: "runtime",
    pid: 42,
    cwd: "/tmp/project",
    branch: "feature/worktree",
    state: "idle",
    status: "finished",
    statusChangedAt: 1,
    startedAt: 1,
    lastActivity: 1,
  };
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 2, session, snapshot: [] }), true);
  assert.equal(isBridgeToServer({ type: "bridge.event", runtimeId: "runtime", event: "arbitrary.event", data: {}, timestamp: 1 }), false);
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 1, session, snapshot: [] }), false);
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 2, session: { ...session, branch: "" }, snapshot: [] }), false);
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 2, session: { ...session, status: "waiting" }, snapshot: [] }), false);
});
