import assert from "node:assert/strict";
import test from "node:test";
import { nextOptionIndex, optionNavigationDirection } from "../web/src/optionNavigation.ts";

const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key: value,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
}) as KeyboardEvent;

test("shared option navigation recognizes arrows and Emacs keys", () => {
  assert.equal(optionNavigationDirection(key("ArrowDown")), 1);
  assert.equal(optionNavigationDirection(key("ArrowUp")), -1);
  assert.equal(optionNavigationDirection(key("n", { ctrlKey: true })), 1);
  assert.equal(optionNavigationDirection(key("P", { ctrlKey: true })), -1);
  assert.equal(optionNavigationDirection(key("n", { ctrlKey: true, shiftKey: true })), undefined);
  assert.equal(optionNavigationDirection(key("n", { metaKey: true })), undefined);
});

test("shared option navigation wraps at both ends", () => {
  assert.equal(nextOptionIndex(0, 4, -1), 3);
  assert.equal(nextOptionIndex(3, 4, 1), 0);
  assert.equal(nextOptionIndex(1, 4, 1), 2);
  assert.equal(nextOptionIndex(0, 0, 1), 0);
});
