import assert from "node:assert/strict";
import test from "node:test";
import { keyboardScrollAmount, keyboardScrollDirection } from "../web/src/keyboardScroll.ts";

const keyEvent = (key: string, overrides: Partial<{
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}> = {}) => ({
  altKey: false,
  ctrlKey: true,
  key,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

test("Ctrl-N and Ctrl-P map to shared forward and backward scrolling", () => {
  assert.equal(keyboardScrollDirection(keyEvent("n")), 1);
  assert.equal(keyboardScrollDirection(keyEvent("N")), 1);
  assert.equal(keyboardScrollDirection(keyEvent("p")), -1);
  assert.equal(keyboardScrollDirection(keyEvent("P")), -1);
});

test("shared scrolling ignores unrelated or additionally modified shortcuts", () => {
  assert.equal(keyboardScrollDirection(keyEvent("n", { ctrlKey: false })), undefined);
  assert.equal(keyboardScrollDirection(keyEvent("n", { altKey: true })), undefined);
  assert.equal(keyboardScrollDirection(keyEvent("p", { metaKey: true })), undefined);
  assert.equal(keyboardScrollDirection(keyEvent("p", { shiftKey: true })), undefined);
  assert.equal(keyboardScrollDirection(keyEvent("x")), undefined);
  assert.equal(keyboardScrollDirection(keyEvent("ArrowDown")), undefined);
});

test("shared scrolling advances by a bounded portion of the visible surface", () => {
  assert.equal(keyboardScrollAmount(100), 48);
  assert.equal(keyboardScrollAmount(600), 198);
  assert.equal(keyboardScrollAmount(2_000), 320);
});
