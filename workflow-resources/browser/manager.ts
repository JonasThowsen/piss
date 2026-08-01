import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOTS_PER_MINUTE = 12;

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

function bounded(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_SNAPSHOT_BYTES) return value;
  return `${bytes.subarray(0, MAX_SNAPSHOT_BYTES).toString("utf8").replace(/\uFFFD$/u, "")}\n[…snapshot truncated by PISS]`;
}

export class PissBrowserManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private operationTail = Promise.resolve();
  private screenshotTimes: number[] = [];
  private navigationViolation: string | undefined;

  constructor(
    private readonly executablePath: string,
    private readonly stagingDirectory: string,
  ) {}

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

  private assertLoopbackPage(page: Page): void {
    this.throwNavigationViolation();
    parseLoopbackUrl(page.url());
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
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        let topLevel = false;
        try {
          const frame = request.frame();
          topLevel = frame === frame.page().mainFrame();
        } catch {
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
    this.context.on("page", (candidate) => {
      if (candidate !== managedPage) void candidate.close().catch(() => undefined);
    });
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
    const page = await this.ensurePage();
    if (page.url() === "about:blank") throw new Error("Navigate the PISS browser before inspecting it");
    this.assertLoopbackPage(page);
    return { url: page.url(), title: await page.title(), snapshot: bounded(await page.locator("body").ariaSnapshot({ timeout: ACTION_TIMEOUT_MS })) };
  }

  async click(role: string, name: string, exact = true): Promise<void> {
    const page = await this.ensurePage();
    this.navigationViolation = undefined;
    try { await page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact }).click({ timeout: ACTION_TIMEOUT_MS }); }
    catch (cause) { this.throwNavigationViolation(cause); }
    this.assertLoopbackPage(page);
  }

  async fill(label: string, value: string, exact = true): Promise<void> {
    const page = await this.ensurePage();
    this.navigationViolation = undefined;
    try { await page.getByLabel(label, { exact }).fill(value, { timeout: ACTION_TIMEOUT_MS }); }
    catch (cause) { this.throwNavigationViolation(cause); }
    this.assertLoopbackPage(page);
  }

  async screenshot(fullPage: boolean, label?: string) {
    const now = Date.now();
    this.screenshotTimes = this.screenshotTimes.filter((timestamp) => timestamp > now - 60_000);
    if (this.screenshotTimes.length >= MAX_SCREENSHOTS_PER_MINUTE) throw new Error("PISS browser screenshot rate limit exceeded");
    this.screenshotTimes.push(now);

    const page = await this.ensurePage();
    if (page.url() === "about:blank") throw new Error("Navigate the PISS browser before capturing it");
    this.assertLoopbackPage(page);
    const bytes = await page.screenshot({ type: "png", fullPage });
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("PISS browser screenshot exceeds the 10 MiB limit");
    if (bytes.length < 24) throw new Error("PISS browser produced an invalid PNG");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const id = randomUUID();
    const stagingName = `${id}.png`;
    await writeFile(join(this.stagingDirectory, stagingName), bytes, { flag: "wx", mode: 0o600 });
    const artifact = {
      id,
      kind: "browser-screenshot" as const,
      mediaType: "image/png" as const,
      byteCount: bytes.length,
      width,
      height,
      pageUrl: page.url().slice(0, 4 * 1024),
      pageTitle: (await page.title()).slice(0, 4 * 1024),
      ...(label?.trim() ? { label: label.trim().slice(0, 512) } : {}),
      createdAt: new Date().toISOString(),
    };
    return { bytes, candidate: { version: 1 as const, stagingName, artifact } };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }
}
