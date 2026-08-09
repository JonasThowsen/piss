import assert from "node:assert/strict";
import test from "node:test";
import { canAcceptPrompt, canConfigureSession, isResumableSession, transitionAttentionState } from "../shared/sessionState.ts";

test("attention transitions are deterministic runtime truth", () => {
  assert.equal(transitionAttentionState("starting", "runtimeStarted"), "idle");
  assert.equal(transitionAttentionState("idle", "agentStarted"), "working");
  assert.equal(transitionAttentionState("working", "interactiveRequest"), "blocked");
  assert.equal(transitionAttentionState("blocked", "agentSettled"), "blocked");
  assert.equal(transitionAttentionState("blocked", "interactiveResolved"), "working");
  assert.equal(transitionAttentionState("working", "agentSettled"), "finished");
  assert.equal(transitionAttentionState("finished", "acknowledged"), "idle");
  assert.equal(transitionAttentionState("idle", "acknowledged"), "idle");
  assert.equal(transitionAttentionState("working", "stopRequested"), "stopping");
  assert.equal(transitionAttentionState("stopping", "runtimeStopped"), "stopped");
  assert.equal(transitionAttentionState("working", "runtimeCrashed"), "crashed");
  assert.equal(transitionAttentionState("stopped", "agentStarted"), "stopped");
});

test("attention capabilities follow central state semantics", () => {
  assert.equal(canAcceptPrompt("idle"), true);
  assert.equal(canAcceptPrompt("finished"), true);
  assert.equal(canAcceptPrompt("working"), false);
  assert.equal(canConfigureSession("idle"), true);
  assert.equal(canConfigureSession("finished"), true);
  assert.equal(canConfigureSession("blocked"), false);
  assert.equal(isResumableSession("stopped"), true);
  assert.equal(isResumableSession("crashed"), true);
  assert.equal(isResumableSession("idle"), false);
});
