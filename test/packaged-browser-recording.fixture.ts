import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright-core";

const packageRoot = resolve(process.argv[2] ?? "result");
const wrapper = await readFile(join(packageRoot, "bin/piss"), "utf8");
assert.match(wrapper, /PLAYWRIGHT_BROWSERS_PATH[^\n]*\/nix\/store\//u);
assert.match(wrapper, /PISS_BROWSER_FFMPEG_PATH[^\n]*\/nix\/store\//u);
assert.match(wrapper, /PISS_BROWSER_FFPROBE_PATH[^\n]*\/nix\/store\//u);
const managerUrl = pathToFileURL(join(packageRoot, "lib/piss/workflow-resources/browser/manager.ts")).href;
const { PissBrowserManager } = await import(managerUrl) as typeof import("../workflow-resources/browser/manager.ts");
const chromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.PISS_BROWSER_EXECUTABLE_PATH;
assert.ok(chromium && isAbsolute(chromium) && chromium.startsWith("/nix/store/"), "packaged fixture requires Nix Chromium");
assert.ok(process.env.PISS_BROWSER_FFMPEG_PATH?.startsWith("/nix/store/"), "packaged fixture requires Nix FFmpeg");
assert.ok(process.env.PISS_BROWSER_FFPROBE_PATH?.startsWith("/nix/store/"), "packaged fixture requires Nix ffprobe");
assert.ok(process.env.PLAYWRIGHT_BROWSERS_PATH?.startsWith("/nix/store/"), "packaged fixture requires immutable Playwright FFmpeg layout");

let recordingBytes: Buffer | undefined;
let playbackRangeRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/recording.webm") {
    if (!recordingBytes) { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? "");
    let start = 0;
    let end = recordingBytes.length - 1;
    if (range) {
      if (!range[1]) {
        const suffix = Number(range[2]);
        start = Math.max(0, recordingBytes.length - suffix);
      } else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= recordingBytes.length) {
        response.writeHead(416, { "Content-Range": `bytes */${recordingBytes.length}` }).end();
        return;
      }
      playbackRangeRequests += 1;
    }
    response.writeHead(range ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(end - start + 1),
      "Content-Type": "video/webm",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${recordingBytes.length}` } : {}),
    });
    response.end(recordingBytes.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/play") {
    response.end("<!doctype html><title>Packaged playback</title><video aria-label=\"Packaged WebM playback\" src=\"/recording.webm\" muted playsinline preload=\"metadata\"></video>");
    return;
  }
  response.end("<!doctype html><title>Packaged recording</title><button onclick=\"this.textContent='Recorded'\">Record me</button>");
});
await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const staging = await mkdtemp(join(tmpdir(), "piss-packaged-recording-"));
const manager = new PissBrowserManager(chromium, staging, process.env.PISS_BROWSER_FFPROBE_PATH);
try {
  await manager.navigate(`http://127.0.0.1:${address.port}/`);
  await manager.startVideo("Packaged Chromium proof");
  await manager.click("button", "Record me");
  await manager.wait(150);
  const result = await manager.stopVideo();
  const bytes = await readFile(join(staging, result.candidate.stagingName));
  recordingBytes = bytes;
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  assert.equal(result.candidate.artifact.kind, "browser-video");
  assert.ok(result.candidate.artifact.durationMs > 0);

  const playbackBrowser = await playwrightChromium.launch({ headless: true, executablePath: chromium });
  try {
    const context = await playbackBrowser.newContext({ acceptDownloads: false });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if ((url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") && (url.protocol === "http:" || url.protocol === "https:")) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/play`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return video instanceof HTMLVideoElement && video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration) && video.duration > 0;
    });
    const metadata = await page.locator("video").evaluate((video: HTMLVideoElement) => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }));
    assert.ok(metadata.duration > 0);
    assert.equal(metadata.width, result.candidate.artifact.width);
    assert.equal(metadata.height, result.candidate.artifact.height);
    await page.locator("video").evaluate(async (video: HTMLVideoElement) => { await video.play(); });
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return video instanceof HTMLVideoElement && (video.currentTime > 0 || video.ended);
    });
    assert.ok(playbackRangeRequests > 0, "Chromium playback must request the WebM through byte ranges");
    await context.close();
  } finally { await playbackBrowser.close(); }

  console.log(`packaged Chromium recording fixture: ${result.candidate.artifact.byteCount} bytes, ${result.candidate.artifact.durationMs}ms; native playback passed with ${playbackRangeRequests} range request(s)`);
} finally {
  await manager.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(staging, { recursive: true, force: true });
}
