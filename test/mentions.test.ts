import assert from "node:assert/strict";
import test from "node:test";
import { activeFileMention, applyFileMention, fileMentionValue } from "../web/src/mentions.ts";

test("detects and applies FFF-compatible file mentions", () => {
  assert.deepEqual(activeFileMention("Read @app", 9), {
    prefix: "@app",
    query: "app",
    start: 5,
    end: 9,
  });
  assert.deepEqual(activeFileMention('Read @"src/my f', 15), {
    prefix: '@"src/my f',
    query: "src/my f",
    start: 5,
    end: 15,
  });
  assert.equal(activeFileMention("email@example.com", 17), undefined);
  assert.deepEqual(activeFileMention("First line\n@app", 15), {
    prefix: "@app",
    query: "app",
    start: 11,
    end: 15,
  });
  assert.equal(fileMentionValue("src/app.ts"), "@src/app.ts");
  assert.equal(fileMentionValue("src/my file.ts"), '@"src/my file.ts"');
  assert.equal(fileMentionValue("src/my\u00a0file.ts"), '@"src/my\u00a0file.ts"');
  assert.deepEqual(
    applyFileMention("Read @app now", activeFileMention("Read @app now", 9)!, "src/app.ts"),
    { text: "Read @src/app.ts now", cursor: 16 },
  );
});
