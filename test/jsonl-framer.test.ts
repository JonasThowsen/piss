import assert from "node:assert/strict";
import test from "node:test";
import { JsonlFramer, JsonlFrameTooLargeError } from "../server/runtimes/JsonlFramer.ts";

test("frames strict LF-delimited JSON without splitting unicode separators", () => {
  const framer = new JsonlFramer();
  const first = framer.push(Buffer.from('{"text":"one\u2028two"}\n{"partial":'));
  const second = framer.push(Buffer.from('true}\r\n'));

  assert.deepEqual(first, ['{"text":"one\u2028two"}']);
  assert.deepEqual(second, ['{"partial":true}']);
  assert.deepEqual(framer.end(), []);
});

test("preserves split utf8 characters across chunks", () => {
  const encoded = Buffer.from('{"text":"blåbær"}\n');
  const split = encoded.indexOf(Buffer.from("å")) + 1;
  const framer = new JsonlFramer();

  assert.deepEqual(framer.push(encoded.subarray(0, split)), []);
  assert.deepEqual(framer.push(encoded.subarray(split)), ['{"text":"blåbær"}']);
});

test("bounds each frame rather than the aggregate chunk", () => {
  const framer = new JsonlFramer(4);
  assert.deepEqual(framer.push(Buffer.from("1234\n5678\n")), ["1234", "5678"]);
});

test("preserves blank records so protocol validation can reject them", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push(Buffer.from("\n{}\n")), ["", "{}"]);
});

test("accepts image-bearing RPC frames larger than the legacy two MiB limit", () => {
  const framer = new JsonlFramer();
  const frame = `{"type":"message_end","data":"${"a".repeat(3 * 1024 * 1024)}"}`;
  assert.deepEqual(framer.push(Buffer.from(`${frame}\n`)), [frame]);
});

test("streams past oversized aggregate events without retaining their image payloads", () => {
  const framer = new JsonlFramer(256, 48);
  assert.deepEqual(framer.push(Buffer.from('{"type":"agent_end","messages":["' + "a".repeat(64))), []);
  const lines = framer.push(Buffer.from('"]}\n{"type":"agent_settled"}\n'));
  assert.equal(JSON.parse(lines[0]!).type, "agent_end");
  assert.equal(JSON.parse(lines[0]!).truncated, true);
  assert.equal(lines[1], '{"type":"agent_settled"}');
});

test("rejects an unbounded partial frame", () => {
  const framer = new JsonlFramer(8);
  assert.throws(() => framer.push(Buffer.from("123456789")), JsonlFrameTooLargeError);
});
