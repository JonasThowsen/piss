import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
    if (request.url === "/motion") {
      response.end(`<!doctype html><title>Motion fixture</title><canvas width="800" height="600"></canvas><script>
        const context = document.querySelector('canvas').getContext('2d'); let state = 1;
        const draw = () => { const image = context.createImageData(800, 600); for (let index = 0; index < image.data.length; index += 4) { state = (state * 1664525 + 1013904223) >>> 0; image.data[index] = state; image.data[index + 1] = state >>> 8; image.data[index + 2] = state >>> 16; image.data[index + 3] = 255; } context.putImageData(image, 0, 0); requestAnimationFrame(draw); }; draw();
      </script>`);
      return;
    }
    response.end(`<!doctype html><title>Browser fixture</title><label>Name <input></label><label>Mode <select><option>Safe</option><option>Fast</option></select></label><label><input type="checkbox"> Enabled</label><button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save</button><button onclick="location.href='https://example.com/escape'">Leave local UI</button><button onclick="window.open('https://example.com/popup')">Open popup</button><button onclick="console.error('fixture console failure')">Log error</button><output>Waiting</output>`);
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

test("recording startup failure removes partial output without orphaning state", async () => {
  const staging = await mkdtemp(join(tmpdir(), "piss-browser-start-failure-"));
  const manager = new PissBrowserManager("unused", staging);
  let stopCalls = 0;
  const page = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:3000/",
    title: async () => "Fixture",
    viewportSize: () => ({ width: 800, height: 600 }),
    screencast: {
      start: async () => { throw new Error("encoder failed"); },
      stop: async () => { stopCalls += 1; },
    },
  };
  (manager as unknown as { page: unknown }).page = page;
  try {
    await assert.rejects(manager.startVideo(), /encoder failed/);
    assert.deepEqual(await readdir(staging), []);
    assert.equal(stopCalls, 1);
    assert.equal((manager as unknown as { recording?: unknown }).recording, undefined);
  } finally { await rm(staging, { recursive: true, force: true }); }
});

test("console ring enforces final UTF-8 byte bounds and resets on close", async () => {
  const manager = new PissBrowserManager("", "");
  const harness = manager as unknown as {
    pushConsoleError: (source: "console" | "page", message: string) => void;
    consoleErrors: Array<{ message: string }>;
  };
  for (let index = 0; index < 101; index += 1) harness.pushConsoleError("console", `${index}:${"🧪".repeat(2_000)}`);
  assert.equal(harness.consoleErrors.length, 100);
  assert.match(harness.consoleErrors[0]!.message, /^1:/u);
  for (const entry of harness.consoleErrors) {
    assert.ok(Buffer.byteLength(entry.message) <= 4 * 1024);
    assert.doesNotMatch(entry.message, /\uFFFD/u);
    assert.match(entry.message, /truncated by PISS/u);
  }
  await manager.close();
  assert.equal(harness.consoleErrors.length, 0);
});

test("production recording watchers reserve finalization headroom", () => {
  const manager = new PissBrowserManager("", "");
  const limits = manager as unknown as { videoByteStopThreshold: number; videoDurationStopDelayMs: number };
  assert.ok(limits.videoByteStopThreshold < 50 * 1024 * 1024);
  assert.ok(limits.videoDurationStopDelayMs < 60_000);
});

test("shutdown closes a browser assigned by an already queued launch", async () => {
  const manager = new PissBrowserManager("", "");
  let release!: () => void;
  let closed = false;
  const queuedLaunch = manager.run(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    (manager as unknown as { browser: { close: () => Promise<void> } }).browser = {
      close: async () => { closed = true; },
    };
  });
  const shutdown = manager.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([queuedLaunch, shutdown]);
  assert.equal(closed, true);
  assert.equal((manager as unknown as { browser?: unknown }).browser, undefined);
});

const networkTest = process.env.PISS_SKIP_NETWORK_TESTS === "1" ? test.skip : test;

networkTest("auto-stops a real recording within an injected duration bound", async () => {
  const executablePath = process.env.PISS_BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executablePath, "the Nix dev shell must provide Chromium");
  const staging = await mkdtemp(join(tmpdir(), "piss-browser-duration-limit-"));
  const fixture = await fixtureServer();
  const manager = new PissBrowserManager(executablePath, staging, process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe", {
    maxVideoDurationMs: 4_000,
    videoDurationHeadroomMs: 1_500,
  });
  try {
    await manager.navigate(fixture.url);
    const limits = await manager.startVideo("Duration bound");
    await manager.wait(4_000);
    const result = await manager.stopVideo();
    assert.equal(result.stoppedBy, "duration");
    assert.ok(result.candidate.artifact.durationMs <= limits.maxDurationMs);
    assert.ok(result.candidate.artifact.byteCount <= limits.maxBytes);
  } finally {
    await manager.close();
    await fixture.close();
    await rm(staging, { recursive: true, force: true });
  }
});

networkTest("auto-stops a real recording before an injected byte bound", async () => {
  const executablePath = process.env.PISS_BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executablePath, "the Nix dev shell must provide Chromium");
  const staging = await mkdtemp(join(tmpdir(), "piss-browser-byte-limit-"));
  const fixture = await fixtureServer();
  const manager = new PissBrowserManager(executablePath, staging, process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe", {
    maxVideoBytes: 2 * 1024 * 1024,
    maxVideoDurationMs: 15_000,
    videoByteHeadroom: 2 * 1024 * 1024 - 1,
    sizeMonitorIntervalMs: 50,
  });
  try {
    await manager.navigate(`${fixture.url}motion`);
    const limits = await manager.startVideo("Byte bound");
    await manager.wait(8_000);
    const result = await manager.stopVideo();
    assert.equal(result.stoppedBy, "bytes");
    assert.ok(result.candidate.artifact.byteCount <= limits.maxBytes);
    assert.ok(result.candidate.artifact.durationMs <= limits.maxDurationMs);
  } finally {
    await manager.close();
    await fixture.close();
    await rm(staging, { recursive: true, force: true });
  }
});

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
    await manager.press("Control+A");
    await manager.typeText("PISS video", 0);
    await manager.select("Mode", ["Fast"], false);
    await manager.check("Enabled", true);
    await manager.resize(800, 600);
    assert.deepEqual(await manager.info(), { url: fixture.url, title: "Browser fixture" });
    const recording = await manager.startVideo("Interaction sequence");
    assert.equal(recording.maxDurationMs, 60_000);
    await assert.rejects(manager.startVideo(), /already active/i);
    await manager.click("button", "Save");
    await manager.wait(200);
    const video = await manager.stopVideo();
    assert.equal(video.candidate.artifact.kind, "browser-video");
    assert.equal(video.candidate.artifact.mediaType, "video/webm");
    assert.ok(video.candidate.artifact.durationMs > 0);
    assert.ok(video.candidate.artifact.byteCount > 0);
    assert.equal("bytes" in video, false);
    assert.equal(video.candidate.stagingName, `${recording.id}.webm`);
    await assert.rejects(manager.stopVideo(), /No PISS browser recording/i);
    assert.match((await manager.snapshot()).snapshot, /Saved PISS video/);
    await manager.click("button", "Log error");
    const consoleResult = await manager.inspectConsoleErrors(1, true);
    assert.match(consoleResult.errors[0]?.message ?? "", /fixture console failure/);
    assert.equal((await manager.inspectConsoleErrors(1, false)).errors.length, 0);
    assert.throws(() => manager.typeText("x".repeat(64 * 1024 + 1)), /bounds/);
    assert.throws(() => manager.press("x".repeat(129)), /invalid/);
    await assert.rejects(manager.wait(10_001), /between/);
    await assert.rejects(manager.resize(319, 600), /bounds/);
    await assert.rejects(manager.inspectConsoleErrors(101, false), /invalid/);
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
