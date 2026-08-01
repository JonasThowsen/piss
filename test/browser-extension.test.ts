import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLoopbackUrl, PissBrowserManager } from "../workflow-resources/browser/manager.ts";

async function fixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.com/escape" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Browser fixture</title><label>Name <input></label><button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save</button><button onclick="location.href='https://example.com/escape'">Leave local UI</button><button onclick="window.open('https://example.com/popup')">Open popup</button><output>Waiting</output>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("accepts exact loopback URLs and rejects navigation escapes", () => {
  for (const value of ["http://localhost:3000/", "https://127.0.0.1:4443/", "http://[::1]:8080/"]) {
    assert.equal(parseLoopbackUrl(value).href, value);
  }
  for (const value of ["https://example.com", "http://localhost.example.com", "file:///tmp/a", "data:text/html,hi", "http://user@localhost:3000/", "http://127.1:3000/", "http://2130706433:3000/", "http://0x7f000001:3000/", "http://0177.0.0.1:3000/"]) {
    assert.throws(() => parseLoopbackUrl(value), /loopback|local HTTP/);
  }
});

const networkTest = process.env.PISS_SKIP_NETWORK_TESTS === "1" ? test.skip : test;

networkTest("drives a real local UI and creates model-visible PNG evidence", async () => {
  const executablePath = process.env.PISS_BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executablePath, "the Nix dev shell must provide Chromium");
  const staging = await mkdtemp(join(tmpdir(), "piss-browser-extension-"));
  const fixture = await fixtureServer();
  const manager = new PissBrowserManager(executablePath, staging);
  try {
    assert.equal((await manager.navigate(fixture.url)).title, "Browser fixture");
    await assert.rejects(manager.navigate(`${fixture.url}redirect`));
    assert.equal((await manager.navigate(fixture.url)).title, "Browser fixture");
    assert.match((await manager.snapshot()).snapshot, /button "Save"/);
    await manager.fill("Name", "PISS");
    await manager.click("button", "Save");
    assert.match((await manager.snapshot()).snapshot, /Saved PISS/);
    await assert.rejects(manager.click("button", "Leave local UI"), /blocked.*top-level navigation/i);
    assert.equal((await manager.navigate(fixture.url)).title, "Browser fixture");
    await assert.rejects(manager.click("button", "Open popup"), /blocked.*popup/i);
    assert.equal((await manager.navigate(fixture.url)).title, "Browser fixture");
    const capture = await manager.screenshot(false, "Saved state");
    assert.ok(capture.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.equal(capture.candidate.artifact.label, "Saved state");
    assert.equal(capture.candidate.artifact.byteCount, capture.bytes.length);
    assert.equal(capture.bytes.toString("base64").length > capture.bytes.length, true);
  } finally {
    await manager.close();
    await fixture.close();
    await rm(staging, { recursive: true, force: true });
  }
});
