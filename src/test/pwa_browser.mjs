import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const [, workspace] = process.argv.slice(2);
if (!workspace) throw new Error("browser test workspace is required");

const require = createRequire(import.meta.url);
const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH;
if (!playwrightCorePath) throw new Error("PLAYWRIGHT_CORE_PATH is required");
const { chromium } = require(playwrightCorePath);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required");

const currentWorker = await readFile(join(workspace, "web/public/service-worker.js"), "utf8");
const legacyWorker = `
const CACHE_NAME = "piss-shell-legacy-browser-proof";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add("/")));
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match("/")));
});
`;
const legacyPage = `<!doctype html><meta charset="utf-8"><title>Legacy Piss</title>
<div id="version">legacy frontend</div>
<script>navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" });</script>`;
const currentPage = `<!doctype html><meta charset="utf-8"><title>Current Piss</title>
<div id="version">current frontend</div>`;

let current = false;
const server = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/service-worker.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(current ? currentWorker : legacyWorker);
    return;
  }
  if (request.url === "/" || request.url?.startsWith("/?")) {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(current ? currentPage : legacyPage);
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("PWA proof server has no port");
const origin = `http://127.0.0.1:${address.port}`;

let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active && navigator.serviceWorker.controller;
  });
  await page.getByText("legacy frontend", { exact: true }).waitFor();
  const legacyCaches = await page.evaluate(() => caches.keys());
  if (!legacyCaches.includes("piss-shell-legacy-browser-proof")) {
    throw new Error(`legacy shell was not cached: ${JSON.stringify(legacyCaches)}`);
  }

  current = true;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration) throw new Error("legacy registration disappeared");
    await registration.update();
  });
  await page.getByText("current frontend", { exact: true }).waitFor({ timeout: 15_000 });
  const result = await page.evaluate(async () => ({
    caches: await caches.keys(),
    controller: navigator.serviceWorker.controller?.scriptURL ?? "",
  }));
  if (result.caches.some((key) => key.startsWith("piss-shell-"))) {
    throw new Error(`legacy shell cache survived cutover: ${JSON.stringify(result.caches)}`);
  }
  if (!result.controller.endsWith("/service-worker.js")) {
    throw new Error(`replacement service worker did not claim the app: ${result.controller}`);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("current frontend", { exact: true }).waitFor();
  if (errors.length) throw new Error(`PWA browser errors: ${errors.join("; ")}`);
  console.log("PWA cutover proof passed: retired cache removed, replacement worker claimed the origin, and current frontend loaded without a hard refresh");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
