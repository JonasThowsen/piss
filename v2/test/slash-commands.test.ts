import assert from "node:assert/strict";
import test from "node:test";
import type { PiSlashCommand } from "../shared/domain.ts";
import { activeSlashCommand, applySlashCommand, filterSlashCommands, isSlashCommandInput } from "../web/src/slashCommands.ts";

const commands: ReadonlyArray<PiSlashCommand> = [
  { name: "review", description: "Review the current changes", source: "extension", scope: null },
  { name: "fix-tests", description: "Fix failing tests", source: "prompt", scope: "project" },
  { name: "skill:web-search", description: "Search the web", source: "skill", scope: "user" },
];

test("detects a slash command only in the first message token", () => {
  assert.deepEqual(activeSlashCommand("/rev", 4), { query: "rev", end: 4 });
  assert.deepEqual(activeSlashCommand("/review staged", 4), { query: "rev", end: 7 });
  assert.equal(activeSlashCommand("Please /review", 14), undefined);
  assert.equal(activeSlashCommand("/review staged", 14), undefined);
});

test("applies a selected command without discarding arguments", () => {
  assert.deepEqual(applySlashCommand("/rev", activeSlashCommand("/rev", 4)!, "review"), {
    text: "/review ",
    cursor: 8,
  });
  assert.deepEqual(applySlashCommand("/rev staged", activeSlashCommand("/rev staged", 4)!, "review"), {
    text: "/review staged",
    cursor: 7,
  });
});

test("filters commands by name and description and recognizes command submissions", () => {
  assert.deepEqual(filterSlashCommands(commands, "fix").map((command) => command.name), ["fix-tests"]);
  assert.deepEqual(filterSlashCommands(commands, "current changes").map((command) => command.name), ["review"]);
  assert.equal(isSlashCommandInput("/review"), true);
  assert.equal(isSlashCommandInput("/review staged"), true);
  assert.equal(isSlashCommandInput("Please /review"), false);
});
