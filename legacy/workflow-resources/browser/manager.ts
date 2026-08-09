import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const FINALIZATION_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOTS_PER_MINUTE = 12;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 60_000;
const MAX_CONSOLE_ERRORS = 100;
const MAX_CONSOLE_ERROR_BYTES = 4 * 1024;
const VIDEO_BYTE_FINALIZATION_HEADROOM = 4 * 1024 * 1024;
const VIDEO_DURATION_FINALIZATION_HEADROOM_MS = 1_500;
const VIDEO_SIZE_MONITOR_INTERVAL_MS = 100;

export function parseLoopbackUrl(raw: string): URL {
  const authority = /^(?:http|https):\/\/([^/?#]*)(?:[/?#]|$)/u.exec(raw)?.[1];
  if (!authority || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u.test(authority)) {
    throw new Error("PISS browser top-level navigation is restricted to literal loopback HTTP(S) URLs");
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Browser URL must be an absolute local HTTP(S) URL"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("PISS browser top-level navigation is restricted to literal loopback HTTP(S) URLs");
  }
  return url;
}

function bounded(value: string, maximum = MAX_SNAPSHOT_BYTES): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  const marker = "\n[…truncated by PISS]";
  const markerBytes = Buffer.byteLength(marker);
  const prefixLimit = Math.max(0, maximum - markerBytes);
  let end = prefixLimit;
  while (end > 0) {
    try {
      return `${new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))}${marker}`;
    } catch { end -= 1; }
  }
  return marker.slice(0, maximum);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (cause) => { clearTimeout(timer); reject(cause); });
  });
}

type VideoProbe = { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
async function probeVideo(path: string, ffprobePath: string, maxDurationMs: number): Promise<{ durationMs: number; width: number; height: number }> {
  if (!ffprobePath) throw new Error("PISS browser ffprobe executable is not configured");
  const result = await new Promise<VideoProbe>((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", path], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("PISS browser video probe timed out")); }, 5_000);
    timer.unref();
    const finish = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cause) reject(cause);
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as VideoProbe); }
        catch (parseCause) { reject(new Error("PISS browser video probe returned invalid metadata", { cause: parseCause })); }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { child.kill("SIGKILL"); finish(new Error("PISS browser video probe output exceeded its limit")); }
      else chunks.push(chunk);
    });
    child.once("error", finish);
    child.once("close", (code) => code === 0 ? finish() : finish(new Error("PISS browser produced an invalid WebM")));
  });
  const stream = result.streams?.[0];
  const durationMs = Math.round(Number(result.format?.duration) * 1000);
  if (result.streams?.length !== 1 || stream?.codec_type !== "video" || stream.codec_name !== "vp8"
    || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)
    || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > maxDurationMs) {
    throw new Error("PISS browser produced an invalid VP8 WebM");
  }
  return { durationMs, width: stream.width!, height: stream.height! };
}

type VideoEncoder = {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  failure?: Error;
  lastFrame?: Buffer;
};

type Recording = {
  id: string;
  stagingName: string;
  path: string;
  encoder: VideoEncoder;
  label?: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: string;
  deadline: NodeJS.Timeout;
  sizeMonitor: NodeJS.Timeout;
};
export interface PissBrowserManagerOptions {
  readonly maxVideoBytes?: number;
  readonly maxVideoDurationMs?: number;
  readonly videoByteHeadroom?: number;
  readonly videoDurationHeadroomMs?: number;
  readonly sizeMonitorIntervalMs?: number;
}

export type BrowserVideoResult = {
  candidate: {
    version: 1;
    stagingName: string;
    artifact: {
      id: string;
      kind: "browser-video";
      mediaType: "video/webm";
      byteCount: number;
      width: number;
      height: number;
      durationMs: number;
      pageUrl: string;
      pageTitle: string;
      label?: string;
      createdAt: string;
    };
  };
  stoppedBy: "manual" | "duration" | "bytes";
};

export class PissBrowserManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private operationTail = Promise.resolve();
  private screenshotTimes: number[] = [];
  private navigationViolation: string | undefined;
  private consoleErrors: Array<{ timestamp: string; source: "console" | "page"; message: string }> = [];
  private recording: Recording | undefined;
  private finalizedRecording: BrowserVideoResult | undefined;
  private videoFinalization: Promise<BrowserVideoResult> | undefined;
  private finalizingRecording: Recording | undefined;
  private videoFailure: string | undefined;

  private readonly ffmpegPath: string;
  private readonly maxVideoBytes: number;
  private readonly maxVideoDurationMs: number;
  private readonly videoByteStopThreshold: number;
  private readonly videoDurationStopDelayMs: number;
  private readonly sizeMonitorIntervalMs: number;

  constructor(
    private readonly executablePath: string,
    private readonly stagingDirectory: string,
    private readonly ffprobePath = process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe",
    options: PissBrowserManagerOptions = {},
  ) {
    this.ffmpegPath = process.env.PISS_BROWSER_FFMPEG_PATH
      ?? (ffprobePath.includes("/") ? join(dirname(ffprobePath), "ffmpeg") : "ffmpeg");
    this.maxVideoBytes = options.maxVideoBytes ?? MAX_VIDEO_BYTES;
    this.maxVideoDurationMs = options.maxVideoDurationMs ?? MAX_VIDEO_DURATION_MS;
    const byteHeadroom = options.videoByteHeadroom ?? VIDEO_BYTE_FINALIZATION_HEADROOM;
    const durationHeadroom = options.videoDurationHeadroomMs ?? VIDEO_DURATION_FINALIZATION_HEADROOM_MS;
    this.videoByteStopThreshold = Math.max(1, this.maxVideoBytes - Math.min(byteHeadroom, this.maxVideoBytes - 1));
    this.videoDurationStopDelayMs = Math.max(1, this.maxVideoDurationMs - Math.min(durationHeadroom, this.maxVideoDurationMs - 1));
    this.sizeMonitorIntervalMs = options.sizeMonitorIntervalMs ?? VIDEO_SIZE_MONITOR_INTERVAL_MS;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private throwNavigationViolation(cause?: unknown): void {
    const violation = this.navigationViolation;
    this.navigationViolation = undefined;
    if (violation) throw new Error(violation, cause === undefined ? undefined : { cause });
    if (cause !== undefined) throw cause;
  }
  private assertLoopbackPage(page: Page): void { this.throwNavigationViolation(); parseLoopbackUrl(page.url()); }
  private async readyPage(action: string): Promise<Page> {
    const page = await this.ensurePage();
    if (page.url() === "about:blank") throw new Error(`Navigate the PISS browser before ${action}`);
    this.assertLoopbackPage(page);
    return page;
  }
  private pushConsoleError(source: "console" | "page", raw: string): void {
    this.consoleErrors.push({ timestamp: new Date().toISOString(), source, message: bounded(raw, MAX_CONSOLE_ERROR_BYTES) });
    if (this.consoleErrors.length > MAX_CONSOLE_ERRORS) this.consoleErrors.splice(0, this.consoleErrors.length - MAX_CONSOLE_ERRORS);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.executablePath) throw new Error("PISS browser Chromium executable is not configured");
    if (!this.stagingDirectory) throw new Error("PISS browser artifact staging is not configured");
    this.browser = await chromium.launch({ headless: true, executablePath: this.executablePath });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } });
    this.page = await this.context.newPage();
    const managedPage = this.page;
    managedPage.setDefaultTimeout(ACTION_TIMEOUT_MS);
    managedPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    managedPage.on("console", (message) => { if (message.type() === "error") this.pushConsoleError("console", message.text()); });
    managedPage.on("pageerror", (error) => this.pushConsoleError("page", error.message));
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        let topLevel = false;
        try { const frame = request.frame(); topLevel = frame === frame.page().mainFrame(); }
        catch {
          this.navigationViolation = "PISS browser blocked a popup";
          await route.abort("blockedbyclient");
          return;
        }
        if (topLevel) {
          try { parseLoopbackUrl(request.url()); }
          catch {
            this.navigationViolation = "PISS browser blocked non-loopback top-level navigation";
            await route.abort("blockedbyclient");
            return;
          }
        }
      }
      await route.continue();
    });
    this.context.on("page", (candidate) => { if (candidate !== managedPage) void candidate.close().catch(() => undefined); });
    return managedPage;
  }

  async navigate(raw: string): Promise<{ url: string; title: string }> {
    const url = parseLoopbackUrl(raw);
    const page = await this.ensurePage();
    this.navigationViolation = undefined;
    try { await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }); }
    catch (cause) { this.throwNavigationViolation(cause); }
    this.assertLoopbackPage(page);
    return { url: page.url(), title: await page.title() };
  }
  async snapshot(): Promise<{ url: string; title: string; snapshot: string }> {
    const page = await this.readyPage("inspecting it");
    return { url: page.url(), title: bounded(await page.title(), 4 * 1024), snapshot: bounded(await page.locator("body").ariaSnapshot({ timeout: ACTION_TIMEOUT_MS })) };
  }
  async info(): Promise<{ url: string; title: string }> {
    const page = await this.readyPage("inspecting it");
    return { url: page.url(), title: bounded(await page.title(), 4 * 1024) };
  }

  private async action(operation: (page: Page) => Promise<void>, description = "interacting with it"): Promise<void> {
    const page = await this.readyPage(description);
    this.navigationViolation = undefined;
    try { await operation(page); }
    catch (cause) { this.throwNavigationViolation(cause); }
    this.assertLoopbackPage(page);
  }
  click(role: string, name: string, exact = true): Promise<void> {
    return this.action((page) => page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact }).click({ timeout: ACTION_TIMEOUT_MS }));
  }
  fill(label: string, value: string, exact = true): Promise<void> {
    return this.action((page) => page.getByLabel(label, { exact }).fill(value, { timeout: ACTION_TIMEOUT_MS }));
  }
  typeText(text: string, delayMs = 0): Promise<void> {
    if (Buffer.byteLength(text) > 64 * 1024 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 100) throw new Error("PISS browser typing exceeds its bounds");
    return this.action((page) => page.keyboard.type(text, { delay: delayMs }), "typing into it");
  }
  press(key: string): Promise<void> {
    if (!key || key.length > 128) throw new Error("PISS browser key expression is invalid");
    return this.action((page) => page.keyboard.press(key), "using its keyboard");
  }
  select(label: string, options: string[], exact = true): Promise<void> {
    if (options.length < 1 || options.length > 100 || options.some((option) => !option || option.length > 1024)) throw new Error("PISS browser option selection exceeds its bounds");
    return this.action(async (page) => { await page.getByLabel(label, { exact }).selectOption(options.map((option) => ({ label: option })), { timeout: ACTION_TIMEOUT_MS }); });
  }
  check(label: string, checked: boolean, exact = true): Promise<void> {
    return this.action((page) => checked
      ? page.getByLabel(label, { exact }).check({ timeout: ACTION_TIMEOUT_MS })
      : page.getByLabel(label, { exact }).uncheck({ timeout: ACTION_TIMEOUT_MS }));
  }
  async wait(milliseconds: number): Promise<void> {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 10_000) throw new Error("PISS browser wait must be between 1 and 10000 ms");
    const page = await this.readyPage("waiting on it");
    await page.waitForTimeout(milliseconds);
    this.assertLoopbackPage(page);
  }
  async resize(width: number, height: number): Promise<void> {
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 1440) throw new Error("PISS browser viewport exceeds its bounds");
    const page = await this.readyPage("resizing it");
    await page.setViewportSize({ width, height });
    this.assertLoopbackPage(page);
  }
  async inspectConsoleErrors(limit: number, clear: boolean): Promise<{ errors: ReadonlyArray<{ timestamp: string; source: "console" | "page"; message: string }> }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("PISS browser console error limit is invalid");
    await this.readyPage("inspecting console errors");
    const errors = this.consoleErrors.slice(-limit);
    if (clear) this.consoleErrors = [];
    return { errors };
  }

  async screenshot(fullPage: boolean, label?: string) {
    const now = Date.now();
    this.screenshotTimes = this.screenshotTimes.filter((timestamp) => timestamp > now - 60_000);
    if (this.screenshotTimes.length >= MAX_SCREENSHOTS_PER_MINUTE) throw new Error("PISS browser screenshot rate limit exceeded");
    this.screenshotTimes.push(now);
    const page = await this.readyPage("capturing it");
    const bytes = await page.screenshot({ type: "png", fullPage });
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("PISS browser screenshot exceeds the 10 MiB limit");
    if (bytes.length < 24) throw new Error("PISS browser produced an invalid PNG");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const id = randomUUID();
    const stagingName = `${id}.png`;
    await writeFile(join(this.stagingDirectory, stagingName), bytes, { flag: "wx", mode: 0o600 });
    const artifact = {
      id, kind: "browser-screenshot" as const, mediaType: "image/png" as const,
      byteCount: bytes.length, width, height,
      pageUrl: page.url().slice(0, 4 * 1024), pageTitle: (await page.title()).slice(0, 4 * 1024),
      ...(label?.trim() ? { label: label.trim().slice(0, 512) } : {}), createdAt: new Date().toISOString(),
    };
    return { bytes, candidate: { version: 1 as const, stagingName, artifact } };
  }

  private async startVideoEncoder(path: string, size: { width: number; height: number }): Promise<VideoEncoder> {
    const child = spawn(this.ffmpegPath, [
      "-loglevel", "error", "-use_wallclock_as_timestamps", "1", "-f", "image2pipe", "-framerate", "25", "-vcodec", "mjpeg", "-i", "pipe:0",
      "-y", "-an", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M", "-pix_fmt", "yuv420p",
      "-vf", `scale=${size.width}:${size.height}`, path,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.resume();
    const encoder = {} as VideoEncoder;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4 * 1024); });
    const completion = new Promise<void>((resolve, reject) => {
      child.once("error", (cause) => reject(cause));
      child.once("close", (code, signal) => code === 0
        ? resolve()
        : reject(new Error(`PISS browser video encoder failed${code === null ? ` (${signal ?? "terminated"})` : ` with code ${code}`}${stderr ? `: ${bounded(stderr, 4 * 1024)}` : ""}`)));
    });
    encoder.child = child;
    encoder.completion = completion.catch((cause) => {
      encoder.failure = cause instanceof Error ? cause : new Error("PISS browser video encoder failed");
      throw encoder.failure;
    });
    void encoder.completion.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return encoder;
  }

  private async writeVideoFrame(encoder: VideoEncoder, frame: Buffer): Promise<void> {
    if (encoder.failure) throw encoder.failure;
    if (frame.length > MAX_SCREENSHOT_BYTES) throw new Error("PISS browser screencast frame exceeds its bound");
    encoder.lastFrame = frame;
    if (encoder.child.stdin.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const drained = () => { cleanup(); resolve(); };
      const failed = (cause: unknown) => { cleanup(); reject(cause); };
      const cleanup = () => {
        encoder.child.stdin.off("drain", drained);
        encoder.child.stdin.off("error", failed);
      };
      encoder.child.stdin.once("drain", drained);
      encoder.child.stdin.once("error", failed);
    });
  }

  private async discardEncoder(encoder: VideoEncoder): Promise<void> {
    encoder.child.stdin.destroy();
    if (encoder.child.exitCode === null && encoder.child.signalCode === null) encoder.child.kill("SIGKILL");
    await encoder.completion.catch(() => undefined);
  }

  async startVideo(label?: string): Promise<{ id: string; maxDurationMs: number; maxBytes: number }> {
    if (this.recording || this.videoFinalization || this.finalizedRecording) throw new Error("A PISS browser recording is already active or awaiting publication");
    const page = await this.readyPage("recording it");
    const id = randomUUID();
    const stagingName = `${id}.webm`;
    const path = join(this.stagingDirectory, stagingName);
    const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
    const size = { width: Math.max(2, viewport.width - viewport.width % 2), height: Math.max(2, viewport.height - viewport.height % 2) };
    const pageUrl = page.url().slice(0, 4 * 1024);
    const pageTitle = bounded(await page.title(), 4 * 1024);
    let encoder: VideoEncoder | undefined;
    try {
      encoder = await this.startVideoEncoder(path, size);
      await page.screencast.start({ size, onFrame: ({ data }) => this.writeVideoFrame(encoder!, data) });
      const deadline = setTimeout(() => { void this.finalizeVideo("duration").catch(() => undefined); }, this.videoDurationStopDelayMs);
      deadline.unref();
      const sizeMonitor = setInterval(() => {
        void stat(path).then((metadata) => {
          if (metadata.size >= this.videoByteStopThreshold) void this.finalizeVideo("bytes").catch(() => undefined);
        }, () => undefined);
      }, this.sizeMonitorIntervalMs);
      sizeMonitor.unref();
      this.recording = {
        id, stagingName, path, encoder,
        ...(label?.trim() ? { label: label.trim().slice(0, 512) } : {}),
        pageUrl, pageTitle,
        createdAt: new Date().toISOString(), deadline, sizeMonitor,
      };
      this.videoFailure = undefined;
      return { id, maxDurationMs: this.maxVideoDurationMs, maxBytes: this.maxVideoBytes };
    } catch (cause) {
      await withTimeout(page.screencast.stop(), FINALIZATION_TIMEOUT_MS, "PISS browser recording startup cleanup timed out").catch(() => undefined);
      if (encoder) await this.discardEncoder(encoder);
      await rm(path, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  private finalizeVideo(stoppedBy: BrowserVideoResult["stoppedBy"]): Promise<BrowserVideoResult> {
    if (this.finalizedRecording) return Promise.resolve(this.finalizedRecording);
    if (this.videoFinalization) return this.videoFinalization;
    const recording = this.recording;
    if (!recording) return Promise.reject(new Error(this.videoFailure ?? "No PISS browser recording is active"));
    clearTimeout(recording.deadline);
    clearInterval(recording.sizeMonitor);
    this.recording = undefined;
    this.finalizingRecording = recording;
    const finalization = this.finalizeClaimedVideo(recording, stoppedBy);
    this.videoFinalization = finalization;
    void finalization.finally(() => {
      if (this.videoFinalization === finalization) this.videoFinalization = undefined;
      if (this.finalizingRecording === recording) this.finalizingRecording = undefined;
    }).catch(() => undefined);
    return finalization;
  }

  private async finalizeClaimedVideo(recording: Recording, stoppedBy: BrowserVideoResult["stoppedBy"]): Promise<BrowserVideoResult> {
    try {
      const page = this.page;
      if (!page || page.isClosed()) throw new Error("PISS browser recording was interrupted because its page closed");
      await withTimeout(page.screencast.stop(), FINALIZATION_TIMEOUT_MS, "PISS browser recording finalization timed out");
      if (recording.encoder.lastFrame) await this.writeVideoFrame(recording.encoder, recording.encoder.lastFrame);
      recording.encoder.child.stdin.end();
      await withTimeout(recording.encoder.completion, FINALIZATION_TIMEOUT_MS, "PISS browser video encoder finalization timed out");
      const metadata = await stat(recording.path);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > this.maxVideoBytes) throw new Error("PISS browser recording exceeds its byte limit");
      const probed = await probeVideo(recording.path, this.ffprobePath, this.maxVideoDurationMs);
      const artifact = {
        id: recording.id, kind: "browser-video" as const, mediaType: "video/webm" as const,
        byteCount: metadata.size, width: probed.width, height: probed.height, durationMs: probed.durationMs,
        pageUrl: recording.pageUrl, pageTitle: recording.pageTitle, ...(recording.label ? { label: recording.label } : {}), createdAt: recording.createdAt,
      };
      const result = { candidate: { version: 1 as const, stagingName: recording.stagingName, artifact }, stoppedBy };
      this.finalizedRecording = result;
      return result;
    } catch (cause) {
      await this.discardEncoder(recording.encoder);
      await rm(recording.path, { force: true }).catch(() => undefined);
      this.videoFailure = cause instanceof Error ? cause.message : "PISS browser recording finalization failed";
      throw cause;
    }
  }

  async stopVideo(): Promise<BrowserVideoResult> {
    const result = this.finalizedRecording ?? await this.finalizeVideo("manual");
    this.finalizedRecording = undefined;
    this.videoFailure = undefined;
    return result;
  }

  async close(): Promise<{ interruptedRecordingId?: string }> {
    const claimed = this.finalizingRecording;
    const interruptedRecordingId = this.recording?.id ?? claimed?.id ?? this.finalizedRecording?.candidate.artifact.id;
    if (this.videoFinalization) await this.videoFinalization.catch(() => undefined);
    const recordingPath = this.recording?.path ?? claimed?.path ?? (this.finalizedRecording ? join(this.stagingDirectory, this.finalizedRecording.candidate.stagingName) : undefined);
    if (this.recording) {
      clearTimeout(this.recording.deadline);
      clearInterval(this.recording.sizeMonitor);
      if (this.page) await withTimeout(this.page.screencast.stop(), FINALIZATION_TIMEOUT_MS, "PISS browser recording close timed out").catch(() => undefined);
      await this.discardEncoder(this.recording.encoder);
    }
    this.recording = undefined;
    this.finalizedRecording = undefined;
    this.videoFinalization = undefined;
    this.finalizingRecording = undefined;
    this.videoFailure = undefined;
    if (recordingPath) await rm(recordingPath, { force: true }).catch(() => undefined);
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.consoleErrors = [];
    if (browser) await browser.close().catch(() => undefined);
    return interruptedRecordingId ? { interruptedRecordingId } : {};
  }
  shutdown(): Promise<void> { return this.run(async () => { await this.close(); }); }
}
