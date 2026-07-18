import assert from "node:assert/strict";
import test from "node:test";
import { decodedBase64Bytes, validateImages } from "../shared/protocol.ts";

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
