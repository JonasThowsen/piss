import assert from "node:assert/strict";
import test from "node:test";
import { decodedBase64Bytes, isBridgeToServer, isBrowserToServer, validateImages } from "../shared/protocol.ts";

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
  assert.equal(isBrowserToServer({ type: "browser.command", commandId: "id", sessionId: "session", runtimeId: "runtime", action: "shell", text: "no" }), false);
  assert.equal(isBrowserToServer({ type: "browser.subscribe", sessionId: "" }), false);
});

test("validates bridge registration and event names", () => {
  const session = {
    sessionId: "session",
    runtimeId: "runtime",
    pid: 42,
    cwd: "/tmp/project",
    state: "idle",
    startedAt: 1,
    lastActivity: 1,
  };
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 1, session, snapshot: [] }), true);
  assert.equal(isBridgeToServer({ type: "bridge.event", runtimeId: "runtime", event: "arbitrary.event", data: {}, timestamp: 1 }), false);
  assert.equal(isBridgeToServer({ type: "bridge.hello", protocolVersion: 2, session, snapshot: [] }), false);
});
