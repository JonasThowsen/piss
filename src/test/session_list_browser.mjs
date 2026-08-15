import { createRequire } from "node:module";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [url, workspace] = process.argv.slice(2);
if (!url || !workspace) throw new Error("browser test URL and workspace are required");

const require = createRequire(import.meta.url);
const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH;
if (!playwrightCorePath) throw new Error("PLAYWRIGHT_CORE_PATH is required");
const { chromium } = require(playwrightCorePath);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required");

async function assertPaintedSvg(icon, label) {
  await icon.waitFor();
  const proof = await icon.evaluate((node) => {
    const shapes = [...node.querySelectorAll("path, circle")];
    const boxes = shapes.map((shape) => {
      try {
        const box = shape.getBBox();
        return { width: box.width, height: box.height };
      } catch {
        return { width: 0, height: 0 };
      }
    });
    return {
      namespace: node.namespaceURI,
      shapeNamespaces: shapes.map((shape) => shape.namespaceURI),
      shapeCount: shapes.length,
      stroke: shapes[0] ? getComputedStyle(shapes[0]).stroke : "none",
      boxes,
    };
  });
  if (
    proof.namespace !== "http://www.w3.org/2000/svg"
    || proof.shapeCount === 0
    || proof.shapeNamespaces.some((namespace) => namespace !== "http://www.w3.org/2000/svg")
    || proof.stroke === "none"
    || !proof.boxes.some((box) => box.width > 0 && box.height > 0)
  ) {
    throw new Error(`${label} SVG was present but not painted: ${JSON.stringify(proof)}`);
  }
}

const auditProofFiles = [
  { relative: `src/audit_browser_permission_${process.pid}.ml`, contents: "let audit_browser_boundary = 731\n" },
  { relative: `web/audit_browser_interface_${process.pid}.ml`, contents: "let audit_browser_interface = 732\n" },
  { relative: `src/audit_browser_proof_${process.pid}_test.ml`, contents: "let audit_browser_proof = 733\n" },
];

let browser;
const errors = [];
let intentionalNetworkFailures = 0;
let intentionalAuditFailures = 0;
try {
  for (const file of auditProofFiles) await writeFile(join(workspace, file.relative), file.contents, "utf8");
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const page = await context.newPage();
  const eventPageRequests = [];
  const eventStreamRequests = [];
  const auditRequests = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/api/v2/events") eventPageRequests.push(request.url());
    if (requestUrl.pathname === "/api/v2/event-stream") eventStreamRequests.push(request.url());
    if (/^\/api\/v2\/sessions\/[^/]+\/audit$/.test(requestUrl.pathname)) auditRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() !== "error" || message.text().includes("409 (Conflict)")) return;
    if (message.text().includes("400 (Bad Request)") && intentionalAuditFailures < 1) {
      intentionalAuditFailures += 1;
      return;
    }
    if (message.text().includes("net::ERR_FAILED") && intentionalNetworkFailures < 1) {
      intentionalNetworkFailures += 1;
      return;
    }
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const shellAssets = [
    ["/", "text/html"],
    ["/app.js", "text/javascript"],
    ["/styles.css", "text/css"],
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/service-worker.js", "text/javascript"],
    ["/icon.svg", "image/svg+xml"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
  ];
  const shellResponses = new Map();
  for (const [path, contentType] of shellAssets) {
    const response = await context.request.get(`${url}${path}`);
    if (!response.ok()) throw new Error(`browser asset request failed for ${path}: ${response.status()}`);
    const headers = response.headers();
    if (!headers["content-type"]?.startsWith(contentType)) {
      throw new Error(`browser asset ${path} used unexpected content type: ${headers["content-type"]}`);
    }
    if (!headers["cache-control"]?.split(",").map((value) => value.trim()).includes("no-store")) {
      throw new Error(`browser asset ${path} may be cached across deployments: ${headers["cache-control"]}`);
    }
    shellResponses.set(path, response);
  }
  const appBytes = (await shellResponses.get("/app.js").body()).byteLength;
  if (appBytes >= 5 * 1024 * 1024) {
    throw new Error(`production browser bundle is unexpectedly large: ${appBytes} bytes`);
  }
  const manifest = await shellResponses.get("/manifest.webmanifest").json();
  if (
    manifest.name !== "Piss"
    || manifest.short_name !== "Piss"
    || manifest.id !== "/"
    || manifest.start_url !== "/"
    || manifest.scope !== "/"
    || manifest.display !== "standalone"
    || !Array.isArray(manifest.icons)
    || !manifest.icons.some((icon) => icon.src === "/icon-192.png" && icon.sizes === "192x192")
    || !manifest.icons.some((icon) => icon.src === "/icon-512.png" && icon.sizes === "512x512")
  ) {
    throw new Error(`browser manifest is not installable: ${JSON.stringify(manifest)}`);
  }
  for (const size of [192, 512]) {
    const icon = await shellResponses.get(`/icon-${size}.png`).body();
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    if (width !== size || height !== size) {
      throw new Error(`PWA icon declared ${size}x${size} but is ${width}x${height}`);
    }
  }
  const serviceWorker = await shellResponses.get("/service-worker.js").text();
  if (!serviceWorker.includes('LEGACY_CACHE_PREFIX = "piss-shell-"') || serviceWorker.includes("respondWith")) {
    throw new Error("service worker did not preserve the network-only deployment contract");
  }
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker?.getRegistration("/");
    return registration?.active?.scriptURL.endsWith("/service-worker.js")
      && navigator.serviceWorker.controller?.scriptURL.endsWith("/service-worker.js");
  });
  const applicationCaches = await page.evaluate(() => caches.keys());
  if (applicationCaches.some((key) => key.startsWith("piss-shell-"))) {
    throw new Error(`retired frontend caches survived activation: ${JSON.stringify(applicationCaches)}`);
  }
  const devtools = await context.newCDPSession(page);
  const appManifest = await devtools.send("Page.getAppManifest");
  if (appManifest.errors?.length) {
    throw new Error(`Chromium rejected the PWA manifest: ${JSON.stringify(appManifest.errors)}`);
  }
  const installability = await devtools.send("Page.getInstallabilityErrors");
  const installabilityErrors = (installability.installabilityErrors ?? [])
    .filter((error) => error.errorId !== "in-incognito");
  if (installabilityErrors.length) {
    throw new Error(`Chromium found PWA installability errors: ${JSON.stringify(installabilityErrors)}`);
  }
  await devtools.detach();
  const session = page.getByRole("button", { name: /^Pi \/ deployed idle \/ opencode$/ });
  try {
    await session.waitFor();
  } catch (error) {
    throw new Error(`${error.message}\n${errors.join("\n")}\nbody: ${await page.locator("body").innerText()}`);
  }
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();
  const expectedWorkspaceLabel = `Piss / ${workspace}`;
  await page.locator(".app-header").getByText(expectedWorkspaceLabel, { exact: true }).waitFor();
  const realAuditResponse = await context.request.get(`${url}/api/v2/sessions/s-mention-browser/audit`);
  if (!realAuditResponse.ok()) {
    throw new Error(`session-bound Audit endpoint failed: ${realAuditResponse.status()} ${await realAuditResponse.text()}`);
  }
  const realAudit = (await realAuditResponse.json()).audit;
  if (
    !Number.isInteger(realAudit?.totalFiles)
    || realAudit.totalFiles < 0
    || !Array.isArray(realAudit.files)
    || realAudit.accountedFiles !== realAudit.files.length
    || realAudit.highlightedFiles !== realAudit.files.filter((file) => file.journeyIndex !== null).length
  ) {
    throw new Error(`real Audit endpoint violated its typed coverage contract: ${JSON.stringify(realAudit)}`);
  }
  for (const proof of auditProofFiles) {
    if (!realAudit.files.some((file) => file.path === proof.relative)) {
      throw new Error(`real Audit endpoint omitted changed proof file ${proof.relative}`);
    }
  }
  const proofPath = auditProofFiles[2].relative;
  const proofFile = realAudit.files.find((file) => file.path === proofPath);
  if (proofFile?.journeyIndex === null || !proofFile?.patch.includes("audit_browser_proof = 733")) {
    throw new Error(`real Audit endpoint did not carry the proof patch into its journey: ${JSON.stringify(proofFile)}`);
  }
  const wrongSessionAudit = await context.request.get(`${url}/api/v2/sessions/session-does-not-exist/audit`);
  if (wrongSessionAudit.status() !== 404) {
    throw new Error(`Audit did not resolve through the session registry: ${wrongSessionAudit.status()}`);
  }
  if (await page.getByText("session / s-mention-browser", { exact: true }).count() !== 0) {
    throw new Error("duplicate selected-session header remained below the app header");
  }
  await assertPaintedSvg(
    page.getByRole("button", { name: "Search sessions" }).locator("svg"),
    "search trigger",
  );
  if (eventStreamRequests.length === 0) {
    await page.waitForRequest((request) => request.url().includes("/api/v2/event-stream"));
  }
  if (
    eventPageRequests.length < 1
    || !eventPageRequests[0].includes("recent=500")
    || !eventPageRequests[0].includes("session=s-mention-browser")
    || eventPageRequests.slice(1).some((request) => {
      const requestUrl = new URL(request);
      return !requestUrl.searchParams.has("before")
        || requestUrl.searchParams.get("session") !== "s-mention-browser";
    })
  ) {
    throw new Error(`unexpected initial event requests: ${JSON.stringify(eventPageRequests)}`);
  }
  let initialEventPageRequestCount = eventPageRequests.length;
  const streamUrl = new URL(eventStreamRequests.at(-1));
  if (
    streamUrl.searchParams.get("session") !== "s-mention-browser"
    || !/^\d+$/.test(streamUrl.searchParams.get("after") ?? "")
  ) {
    throw new Error(`unexpected event stream request: ${streamUrl}`);
  }
  const tabs = page.getByRole("tablist", { name: "Session views" }).getByRole("tab");
  const tabLabels = await tabs.allTextContents();
  if (JSON.stringify(tabLabels) !== JSON.stringify(["Agent", "Audit", "Details"])) {
    throw new Error(`unexpected session tabs: ${JSON.stringify(tabLabels)}`);
  }
  if (await page.locator("#session-panel-working, #session-tab-working").count() !== 0) {
    throw new Error("removed Working page remained in the DOM");
  }
  const agentTab = page.getByRole("tab", { name: "Agent" });
  const auditTab = page.getByRole("tab", { name: "Audit" });
  const detailsTab = page.getByRole("tab", { name: "Details" });
  await agentTab.focus();
  const pageAuditResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/v2/sessions/s-mention-browser/audit") && response.request().resourceType() === "fetch",
  );
  await agentTab.press("ArrowRight");
  const pageAuditResponse = await pageAuditResponsePromise;
  if (!pageAuditResponse.ok()) throw new Error(`page Audit request failed: ${pageAuditResponse.status()}`);
  const pageAudit = (await pageAuditResponse.json()).audit;
  await page.waitForFunction(() => document.getElementById("session-tab-audit")?.getAttribute("aria-selected") === "true");
  await page.getByRole("region", { name: "Feature Audit" }).getByRole("heading", { name: "Read the design end to end" }).waitFor();
  if (auditRequests.length !== 1 || !auditRequests[0].endsWith("/api/v2/sessions/s-mention-browser/audit")) {
    throw new Error(`Audit was not bound to the selected durable session: ${JSON.stringify(auditRequests)}`);
  }
  const journey = page.getByRole("region", { name: "Review journey" });
  const stops = journey.locator("details.audit-stop");
  if (await stops.count() !== pageAudit.highlightedFiles || pageAudit.highlightedFiles < 3) {
    throw new Error(`Audit did not render the real representative journey: ${await stops.count()} / ${pageAudit.highlightedFiles}`);
  }
  const proofStop = stops.filter({ hasText: proofPath });
  await proofStop.waitFor();
  if ((await proofStop.getAttribute("open")) === null) await proofStop.locator("summary").click();
  await proofStop.getByText("audit_browser_proof = 733", { exact: false }).waitFor();
  const secondStop = stops.nth(1);
  if ((await secondStop.getAttribute("open")) === null) await secondStop.locator("summary").click();
  if ((await secondStop.getAttribute("open")) === null) throw new Error("non-first Audit disclosure did not open");
  if (await secondStop.locator(".audit-stop-toggle").count() !== 1) {
    throw new Error("Audit disclosure lacked a visible affordance");
  }
  const ledger = page.getByRole("region", { name: "Change coverage ledger" });
  if (await ledger.locator("li").count() !== pageAudit.files.length) {
    throw new Error("Audit coverage ledger did not account for every API file");
  }
  for (const file of pageAudit.files) await ledger.getByText(file.path, { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileAudit = await page.locator(".audit-view").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    ledgerPosition: getComputedStyle(node.querySelector(".audit-ledger")).position,
  }));
  if (mobileAudit.scrollWidth > mobileAudit.clientWidth || mobileAudit.ledgerPosition !== "static") {
    throw new Error(`Audit mobile layout overflowed or kept a sticky ledger: ${JSON.stringify(mobileAudit)}`);
  }
  const auditUrlPattern = "**/api/v2/sessions/s-mention-browser/audit";
  let failNextAuditRefresh = true;
  const readableAuditError = "This workspace is not inside an approved Git repository";
  await page.route(auditUrlPattern, async (route) => {
    if (!failNextAuditRefresh) return route.continue();
    failNextAuditRefresh = false;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: readableAuditError,
        errorDetails: { kind: "Validation", field: "workspace", reason: "internal detail must stay hidden" },
      }),
    });
  });
  await page.getByRole("button", { name: "Refresh Audit" }).click();
  const auditAlert = page.getByRole("alert");
  await auditAlert.getByText(readableAuditError, { exact: true }).waitFor();
  const auditAlertText = await auditAlert.innerText();
  if (auditAlertText.includes("errorDetails") || auditAlertText.includes("internal detail") || auditAlertText.includes("{\"error\"")) {
    throw new Error(`Audit exposed raw JSON or internal details on mobile: ${auditAlertText}`);
  }
  const recoveryResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/v2/sessions/s-mention-browser/audit") && response.request().resourceType() === "fetch",
  );
  await auditAlert.getByRole("button", { name: "Try again" }).click();
  const recoveryResponse = await recoveryResponsePromise;
  if (!recoveryResponse.ok()) throw new Error(`Audit recovery failed: ${recoveryResponse.status()}`);
  await page.waitForFunction((expected) => document.querySelectorAll(".audit-stop").length === expected, pageAudit.highlightedFiles);
  await page.unroute(auditUrlPattern);
  if (auditRequests.length !== 3) {
    throw new Error(`Audit error and recovery did not issue two refreshes: ${JSON.stringify(auditRequests)}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await auditTab.press("ArrowRight");
  await page.waitForFunction(() => document.getElementById("session-tab-details")?.getAttribute("aria-selected") === "true");
  await detailsTab.press("ArrowLeft");
  await page.waitForFunction(() => document.getElementById("session-tab-audit")?.getAttribute("aria-selected") === "true");
  await auditTab.press("ArrowLeft");
  await page.waitForFunction(() => document.getElementById("session-tab-agent")?.getAttribute("aria-selected") === "true");
  const modelButton = page.getByRole("button", { name: "Model: Mock Fast" });
  await modelButton.click();
  const modelRequestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/config-options") && request.method() === "POST",
  );
  await page.getByRole("menu", { name: "Model options" }).getByRole("menuitemradio", { name: /Mock Deep/ }).click();
  const modelRequest = await modelRequestPromise;
  const modelBody = modelRequest.postDataJSON();
  if (modelBody.configId !== "model" || modelBody.value !== "mock/deep" || !modelBody.mutationId?.startsWith("web-") || modelBody.target?.sessionId !== "s-mention-browser") {
    throw new Error(`unexpected model config request: ${modelRequest.postData()}`);
  }
  await page.getByRole("button", { name: "Model: Mock Deep" }).waitFor();
  const thinkingButton = page.getByRole("button", { name: "Thinking: medium" });
  await thinkingButton.click();
  const configRequestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/config-options") && request.method() === "POST",
  );
  await page.getByRole("menu", { name: "Thinking options" }).getByRole("menuitemradio", { name: /high/ }).click();
  const configRequest = await configRequestPromise;
  const configBody = configRequest.postDataJSON();
  if (
    configBody.configId !== "thought_level"
    || configBody.value !== "high"
    || !configBody.mutationId?.startsWith("web-")
    || configBody.target?.sessionId !== "s-mention-browser"
    || new URL(configRequest.url()).searchParams.get("session") !== "s-mention-browser"
  ) {
    throw new Error(`unexpected config request: ${configRequest.postData()}`);
  }
  await page.getByRole("button", { name: "Thinking: high" }).waitFor();
  await detailsTab.click();
  await page.getByRole("region", { name: "Session runtime details" }).getByText(/^worker-/).waitFor();
  await page.getByRole("region", { name: "Configuration options" }).getByText("Mock Fast", { exact: false }).waitFor();
  await agentTab.click();
  const sessions = await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  if (sessions.length !== 1 || sessions[0].id !== "s-mention-browser") {
    throw new Error(`unexpected session response: ${JSON.stringify(sessions)}`);
  }
  const waitForIdle = async () => {
    await page.waitForFunction(async () => {
      const response = await fetch("/api/v2/session?session=s-mention-browser");
      return response.ok && (await response.json()).status === "idle";
    });
    await page.locator(".connection-pill").getByText("idle", { exact: true }).waitFor();
  };
  const prompt = "Render the deterministic Bonsai response";
  const draftStorageKey = "piss:composer-draft:s-mention-browser";
  const composerField = page.getByRole("textbox", { name: "Message agent" });
  await composerField.fill(prompt);
  await page.waitForFunction(
    ({ key, value }) => localStorage.getItem(key) === value,
    { key: draftStorageKey, value: prompt },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();
  await page.getByRole("textbox", { name: "Message agent" }).waitFor();
  try {
    await page.waitForFunction(
      (value) => document.getElementById("prompt-input")?.value === value,
      prompt,
    );
  } catch (error) {
    const draftState = await page.evaluate((key) => ({
      field: document.getElementById("prompt-input")?.value,
      stored: localStorage.getItem(key),
    }), draftStorageKey);
    throw new Error(`${error.message}: ${JSON.stringify(draftState)}`);
  }
  await page.waitForFunction(() =>
    !document.getElementById("timeline")?.textContent?.includes("Loading recent events"));
  await waitForIdle();
  initialEventPageRequestCount = eventPageRequests.length;
  let dropFirstCommandResponse = true;
  await page.route("**/api/v2/commands?*", async (route) => {
    if (!dropFirstCommandResponse) return route.continue();
    dropFirstCommandResponse = false;
    await route.fetch();
    await route.abort("failed");
  });
  const requestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/commands") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await requestPromise;
  const body = request.postDataJSON();
  await page.getByRole("button", { name: "Retry same command" }).waitFor({ timeout: 15000 });
  if (await page.evaluate((key) => localStorage.getItem(key), draftStorageKey) !== prompt) {
    throw new Error("uncertain command delivery discarded the saved composer draft");
  }
  const retryPromise = page.waitForRequest(
    (candidate) => candidate.url().includes("/api/v2/commands") && candidate.method() === "POST" && candidate !== request,
  );
  const retryResponsePromise = page.waitForResponse(
    (candidate) => candidate.url().includes("/api/v2/commands") && candidate.request().method() === "POST" && candidate.request().postDataJSON()?.commandId === body.commandId,
  );
  await page.getByRole("button", { name: "Retry same command" }).evaluate((button) => {
    button.click();
    button.click();
  });
  const retryBody = (await retryPromise).postDataJSON();
  const retryResponse = await retryResponsePromise;
  if (!retryResponse.ok()) throw new Error(`same-command retry failed: ${await retryResponse.text()}`);
  if (retryBody.commandId !== body.commandId || JSON.stringify(retryBody.target) !== JSON.stringify(body.target)) {
    throw new Error(`uncertain retry changed command identity: ${JSON.stringify({ body, retryBody })}`);
  }
  await page.getByRole("button", { name: "Retry same command" }).waitFor({ state: "detached" });
  if (await page.evaluate((key) => localStorage.getItem(key), draftStorageKey) !== null) {
    throw new Error("accepted command left a stale composer draft in localStorage");
  }
  await page.unroute("**/api/v2/commands?*");
  if (
    !body.commandId?.startsWith("web-")
    || body.text !== prompt
    || body.action !== "prompt"
    || body.images?.length !== 0
    || body.resources?.length !== 0
    || body.target?.sessionId !== "s-mention-browser"
    || !body.target?.workerId
    || !Number.isInteger(body.target?.runtimeGeneration)
    || !request.url().includes("session=s-mention-browser")
  ) {
    throw new Error(`unexpected command request: ${JSON.stringify(body)}`);
  }
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 10000 });
  const liveActivity = page.locator("details.timeline-activity-live").filter({ hasText: "Running durability tests" });
  await liveActivity.waitFor({ timeout: 10000 });
  if (await liveActivity.getAttribute("open") !== null) {
    throw new Error("live tool activity expanded itself");
  }
  const liveSummary = liveActivity.locator(":scope > summary");
  if (!(await liveSummary.innerText()).includes("In progress · 1 tool")) {
    throw new Error(`live activity omitted its running summary: ${await liveSummary.innerText()}`);
  }
  const liveActivityKey = await liveActivity.getAttribute("data-timeline-key");
  if (!liveActivityKey?.startsWith("activity-after:")) {
    throw new Error(`live activity lacked a boundary-stable key: ${liveActivityKey}`);
  }
  await liveSummary.click();
  await page.getByText("The worker retained ownership while the control plane was replaceable.", { exact: true }).waitFor({ timeout: 10000 });
  await page.waitForFunction((commandId) =>
    [...document.querySelectorAll(".timeline-command")].some((entry) =>
      entry.textContent?.includes(commandId)
      && entry.textContent?.includes("state / completed")),
  body.commandId);
  const commandEventsResponse = await fetch(new URL("/api/v2/events?session=s-mention-browser&after=0", page.url()));
  if (!commandEventsResponse.ok) throw new Error(await commandEventsResponse.text());
  const commandEvents = await commandEventsResponse.json();
  if (
    commandEvents.filter((event) => event.kind === "command.accepted" && event.payload.commandId === body.commandId).length !== 1
    || commandEvents.filter((event) => event.kind === "command.state" && event.payload.commandId === body.commandId && event.payload.state === "completed").length !== 1
  ) {
    throw new Error(`response-loss retry did not remain exactly-once: ${JSON.stringify(commandEvents)}`);
  }
  const firstTool = page.locator(".timeline-tool");
  if (await firstTool.count() !== 1) throw new Error("tool lifecycle did not aggregate into one row");
  const toolActivity = page.locator("details.timeline-activity").filter({ has: firstTool });
  if (await toolActivity.count() !== 1) throw new Error("tool row was not grouped into one activity accordion");
  const activityKey = await toolActivity.getAttribute("data-timeline-key");
  if (activityKey !== liveActivityKey) {
    throw new Error(`live reconciliation changed the activity key: ${liveActivityKey} -> ${activityKey}`);
  }
  if (await toolActivity.getAttribute("open") === null || !(await firstTool.isVisible())) {
    throw new Error("live reconciliation discarded the expanded activity state");
  }
  const disclosure = firstTool.locator("details.tool-disclosure");
  if (await disclosure.getAttribute("open") !== null) throw new Error("nested tool call was expanded by default");
  await disclosure.locator(":scope > summary").click();
  await firstTool.getByRole("button", { name: "Copy tool output" }).click();
  const toolClipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (!toolClipboard.includes("dune runtest") || !toolClipboard.includes("2 tests passed")) {
    throw new Error(`aggregated tool copy was incomplete: ${toolClipboard}`);
  }
  await disclosure.locator(":scope > summary").click();
  await toolActivity.locator(":scope > summary").click();

  const response = "The worker retained ownership while the control plane was replaceable.";
  const agent = page.locator(".timeline-agent").last();
  await agent.getByRole("button", { name: "Copy message" }).click();
  if (await page.evaluate(() => navigator.clipboard.readText()) !== response) {
    throw new Error("aggregated agent message copy was incomplete");
  }
  await page.waitForTimeout(1000);
  await agent.getByRole("button", { name: "Copied message" }).click();
  await page.waitForTimeout(1000);
  if (await agent.getByRole("button", { name: "Copied message" }).count() !== 1) {
    throw new Error("repeated copy feedback reset before 1.8 seconds");
  }
  if (eventPageRequests.length !== initialEventPageRequestCount) {
    throw new Error(`post-submit polling remained active: ${JSON.stringify(eventPageRequests)}`);
  }

  await waitForIdle();
  const gifData = "R0lGODlhAQABAAAAACw=";
  const imageInput = page.locator("#composer-image-input");
  if ((await imageInput.getAttribute("multiple")) === null || !(await imageInput.isHidden())) {
    throw new Error("image input was not hidden and multi-file capable");
  }
  await page.getByRole("textbox", { name: "Message agent" }).evaluate((field, data) => {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "proof.gif", { type: "image/gif" }));
    field.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, gifData);
  await page.getByText("proof.gif", { exact: true }).waitFor();
  await page.getByText("14 B", { exact: true }).waitFor();
  const imageRequestPromise = page.waitForRequest(
    (candidate) => candidate.url().includes("/api/v2/commands") && candidate.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const imageBody = (await imageRequestPromise).postDataJSON();
  if (
    imageBody.action !== "prompt"
    || imageBody.text !== ""
    || imageBody.images?.length !== 1
    || imageBody.images[0]?.mimeType !== "image/gif"
    || imageBody.images[0]?.name !== "proof.gif"
    || imageBody.images[0]?.data !== gifData
  ) {
    throw new Error(`unexpected image command: ${JSON.stringify(imageBody)}`);
  }
  await page.getByText("Received 1 image attachment.", { exact: true }).waitFor({ timeout: 10000 });
  if ((await page.locator("body").innerText()).includes(gifData)) {
    throw new Error("base64 image data was rendered into the timeline");
  }

  await waitForIdle();
  const permissionPrompt = "permission: render the browser decision path";
  await page.getByRole("textbox", { name: "Message agent" }).fill(permissionPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const permissionCard = page.locator(".timeline-permission");
  await permissionCard.getByText("Allow the stability proof", { exact: true }).waitFor();
  await page.getByText("requires_action", { exact: true }).first().waitFor();
  await permissionCard.getByText("mock-proof").waitFor();
  const decisionLabels = await permissionCard.getByRole("button").allTextContents();
  if (JSON.stringify(decisionLabels) !== JSON.stringify(["Allow once", "Reject", "Cancel"])) {
    throw new Error(`unexpected permission decisions: ${JSON.stringify(decisionLabels)}`);
  }
  const permissionRequestId = await permissionCard.locator(".permission-context dd").first().textContent();
  if (!permissionRequestId?.startsWith("permission-web-")) {
    throw new Error(`unexpected rendered permission request ID: ${permissionRequestId}`);
  }

  let releasePermission;
  const permissionGate = new Promise((resolve) => { releasePermission = resolve; });
  await page.route("**/api/v2/permissions?*", async (route) => {
    await permissionGate;
    await route.continue();
  });
  const permissionRequestPromise = page.waitForRequest(
    (candidate) => candidate.url().includes("/api/v2/permissions") && candidate.method() === "POST",
  );
  const clickPromise = permissionCard.getByRole("button", { name: "Allow once" }).click();
  const permissionRequest = await permissionRequestPromise;
  const permissionBody = permissionRequest.postDataJSON();
  if (
    permissionBody.requestId !== permissionRequestId
    || permissionBody.optionId !== "allow-once"
    || !permissionBody.mutationId?.startsWith("web-")
    || permissionBody.target?.sessionId !== "s-mention-browser"
    || !permissionRequest.url().includes("session=s-mention-browser")
  ) {
    throw new Error(`unexpected permission request: ${JSON.stringify(permissionBody)}`);
  }
  await permissionCard.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".timeline-permission button")?.disabled === true);
  if (!(await permissionCard.getByRole("button", { name: "Allow once" }).isDisabled())) {
    throw new Error("permission card was not retained in submitted state");
  }
  releasePermission();
  await clickPromise;
  await permissionCard.waitFor({ state: "detached", timeout: 10000 });
  await page.getByRole("button", { name: "Steer next" }).waitFor();
  if (!(await page.getByRole("button", { name: "Send message" }).isDisabled())) {
    throw new Error("permission resolution inferred a running delivery action");
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".timeline-command .message-status")]
      .some((status) => status.textContent === "state / completed"),
  );
  if (eventPageRequests.length !== initialEventPageRequestCount) {
    throw new Error(`permission flow polled event pages: ${JSON.stringify(eventPageRequests)}`);
  }

  await waitForIdle();
  await page.getByRole("textbox", { name: "Message agent" }).fill("hold active for steering");
  await page.getByRole("button", { name: "Send message" }).click();
  const steerButton = page.getByRole("button", { name: "Steer next" });
  await steerButton.waitFor();
  await steerButton.click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("steer the active proof");
  const steerRequestPromise = page.waitForRequest(
    (candidate) => candidate.url().includes("/api/v2/commands") && candidate.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const steerBody = (await steerRequestPromise).postDataJSON();
  if (steerBody.action !== "steer" || steerBody.text !== "steer the active proof") {
    throw new Error(`unexpected steer command: ${JSON.stringify(steerBody)}`);
  }
  const cancelRequestPromise = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === "/api/v2/cancel" && candidate.method() === "POST",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  const cancelRequest = await cancelRequestPromise;
  const cancelBody = cancelRequest.postDataJSON();
  if (
    !cancelBody.mutationId?.startsWith("web-")
    || cancelBody.target?.sessionId !== "s-mention-browser"
    || !cancelBody.target?.workerId
    || !Number.isInteger(cancelBody.target?.runtimeGeneration)
    || new URL(cancelRequest.url()).searchParams.get("session") !== "s-mention-browser"
  ) {
    throw new Error(`unexpected cancel request: ${cancelRequest.postData()}`);
  }
  await page.getByText("Cancellation requested. Waiting for session events.", { exact: false }).waitFor();

  await waitForIdle();
  await page.getByRole("textbox", { name: "Message agent" }).fill("hold active for follow-up");
  await page.getByRole("button", { name: "Send message" }).click();
  const followButton = page.getByRole("button", { name: "Follow-up" });
  await followButton.click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("run this after the proof");
  const followRequestPromise = page.waitForRequest(
    (candidate) => candidate.url().includes("/api/v2/commands") && candidate.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const followBody = (await followRequestPromise).postDataJSON();
  if (followBody.action !== "follow_up" || followBody.text !== "run this after the proof") {
    throw new Error(`unexpected follow-up command: ${JSON.stringify(followBody)}`);
  }
  await page.locator(".outbox-message").filter({ hasText: "Follow-up" }).waitFor();
  await waitForIdle();

  const dispatchPrompt = (text) => page.evaluate(async (prompt) => {
    const snapshot = await fetch("/api/v2/session?session=s-mention-browser").then((response) => response.json());
    const target = { sessionId: snapshot.sessionId, workerId: snapshot.workerId, runtimeGeneration: snapshot.runtimeGeneration };
    const response = await fetch("/api/v2/commands?session=s-mention-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, commandId: `browser-${crypto.randomUUID()}`, text: prompt, images: [], resources: [], action: "prompt" }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, text);
  await waitForIdle();
  const latestButton = page.getByRole("button", { name: "Jump to latest message" });
  if (await latestButton.isVisible()) await latestButton.click();
  await page.waitForTimeout(1600);
  await page.setViewportSize({ width: 1280, height: 500 });
  const timeline = page.locator("#timeline");
  await page.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight > value.clientHeight;
  });
  await page.waitForTimeout(500);
  await timeline.evaluate((value) => { value.scrollTop = value.scrollHeight; value.dispatchEvent(new Event("scroll")); });
  const initialScroll = await timeline.evaluate((value) => ({
    top: value.scrollTop,
    height: value.scrollHeight,
    client: value.clientHeight,
  }));
  if (initialScroll.height - initialScroll.top - initialScroll.client > 2) {
    throw new Error(`timeline did not start at the bottom: ${JSON.stringify(initialScroll)}`);
  }
  await timeline.evaluate((value) => {
    value.scrollTop = 0;
    value.dispatchEvent(new Event("scroll"));
  });
  try {
    await latestButton.waitFor({ timeout: 3_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      tab: document.getElementById("session-tab-agent")?.getAttribute("aria-selected"),
      panelHidden: document.getElementById("session-panel-agent")?.hasAttribute("hidden"),
      buttonHidden: document.querySelector('[aria-label="Jump to latest message"]')?.hasAttribute("hidden"),
      scrollTop: document.getElementById("timeline")?.scrollTop,
    }));
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  await assertPaintedSvg(latestButton.locator("svg"), "latest jump button");
  if ((await latestButton.innerText()).trim() !== "") {
    throw new Error("latest jump button retained a visible text label");
  }
  const agentCount = await page.locator(".timeline-agent").count();
  await dispatchPrompt("manual scroll should stay put");
  await page.waitForFunction((count) => document.querySelectorAll(".timeline-agent").length > count, agentCount);
  if (await timeline.evaluate((value) => value.scrollTop) > 4) {
    throw new Error("stream overrode manual upward scrolling");
  }
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await page.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  await waitForIdle();
  const nextAgentCount = await page.locator(".timeline-agent").count();
  await dispatchPrompt("follow this stream");
  await page.waitForFunction((count) => document.querySelectorAll(".timeline-agent").length > count, nextAgentCount);
  await page.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  if (await page.locator("details.timeline-activity[open], details.tool-disclosure[open]").count() !== 0) {
    throw new Error("streamed activity opened a collapsed disclosure");
  }
  await waitForIdle();

  const workspaceSettings = page.getByRole("button", { name: "Workspace settings for Piss" });
  await workspaceSettings.click();
  await page.getByRole("menu", { name: "Piss workspace settings" }).getByRole("menuitem", { name: "Remove workspace" }).click();
  const blockedRemoval = page.getByRole("alertdialog", { name: "Remove workspace?" });
  await blockedRemoval.getByText("This does not delete the directory or any files.", { exact: false }).waitFor();
  await blockedRemoval.getByRole("button", { name: "REMOVE WORKSPACE" }).click();
  await blockedRemoval.getByRole("alert").getByText(/Delete 1 session first, including archived sessions/).waitFor();
  await blockedRemoval.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Add workspace" }).click();
  const addWorkspace = page.getByRole("dialog", { name: "Add workspace" });
  const directoryQuery = addWorkspace.getByRole("combobox", { name: "Search approved directories" });
  await directoryQuery.fill("/web");
  const webDirectory = addWorkspace.getByRole("option").filter({ hasText: /\/web$/ }).first();
  await webDirectory.waitFor();
  await webDirectory.click();
  await addWorkspace.getByRole("button", { name: "ADD WORKSPACE" }).click();
  await page.getByRole("button", { name: "Workspace settings for web" }).waitFor();
  await page.getByRole("button", { name: "Workspace settings for web" }).click();
  await page.getByRole("menu", { name: "web workspace settings" }).getByRole("menuitem", { name: "Remove workspace" }).click();
  const removeWeb = page.getByRole("alertdialog", { name: "Remove workspace?" });
  await removeWeb.getByRole("button", { name: "REMOVE WORKSPACE" }).click();
  await page.getByRole("button", { name: "Workspace settings for web" }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "New session in Piss" }).click();
  const creator = page.getByRole("dialog", { name: "New session" });
  await creator.getByLabel("Session title").fill("Lifecycle proof");
  if (await creator.getByRole("combobox", { name: "Session harness" }).inputValue() !== "opencode") {
    throw new Error("session creator did not select the managed host default");
  }
  const createRequestPromise = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === "/api/v2/sessions" && candidate.method() === "POST",
  );
  await creator.getByRole("button", { name: "START SESSION" }).click();
  const createRequest = await createRequestPromise;
  if (JSON.stringify(createRequest.postDataJSON()) !== JSON.stringify({ workspaceId: "test-workspace", title: "Lifecycle proof", harness: "opencode" })) {
    throw new Error(`unexpected create request: ${createRequest.postData()}`);
  }
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle proof" }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() =>
    !document.getElementById("timeline")?.textContent?.includes("Loading recent events"));
  const recentHistoryCount = () => eventPageRequests.filter((request) =>
    new URL(request).searchParams.has("recent")).length;
  const recentBeforeWarmSwitch = recentHistoryCount();
  const warmGapPrompt = `Warm cache gap ${Date.now()}`;
  await page.evaluate(async (text) => {
    const runtimeResponse = await fetch("/api/v2/session?session=s-mention-browser");
    if (!runtimeResponse.ok) throw new Error(await runtimeResponse.text());
    const runtime = await runtimeResponse.json();
    const commandId = `browser-warm-gap-${Date.now()}`;
    const response = await fetch("/api/v2/commands?session=s-mention-browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        requestId: commandId,
        action: "prompt",
        text,
        images: [],
        resources: [],
        target: {
          sessionId: runtime.sessionId,
          workerId: runtime.workerId,
          runtimeGeneration: runtime.runtimeGeneration,
        },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, warmGapPrompt);
  await page.locator("button.session-row").filter({ hasText: "Pi / deployed" }).click();
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();
  await page.locator(".timeline-agent").filter({ hasText: response }).last().waitFor();
  await page.getByText(warmGapPrompt, { exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(async () => {
    const response = await fetch("/api/v2/session?session=s-mention-browser");
    return response.ok && (await response.json()).status === "idle";
  });
  await page.locator("button.session-row").filter({ hasText: "Pi / deployed" })
    .getByText(/idle \/ opencode$/).waitFor();
  if (recentHistoryCount() !== recentBeforeWarmSwitch) {
    throw new Error(`revisiting a warm chat refetched history: ${JSON.stringify(eventPageRequests)}`);
  }
  await page.locator("button.session-row").filter({ hasText: "Lifecycle proof" }).click();
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle proof" }).waitFor();
  await page.waitForFunction(() =>
    !document.getElementById("timeline")?.textContent?.includes("Loading recent events"));
  if (recentHistoryCount() !== recentBeforeWarmSwitch) {
    throw new Error(`switching between warm chats refetched history: ${JSON.stringify(eventPageRequests)}`);
  }

  await page.getByRole("button", { name: "Session settings for Lifecycle proof" }).click();
  await page.getByRole("menu", { name: "Lifecycle proof session settings" }).getByRole("menuitem", { name: "Rename session" }).click();
  const rename = page.getByRole("dialog", { name: "Rename session" });
  await rename.getByLabel("Session title").fill("Lifecycle renamed");
  const renameRequestPromise = page.waitForRequest(
    (candidate) => /\/api\/v2\/sessions\/[^/]+\/rename$/.test(new URL(candidate.url()).pathname) && candidate.method() === "POST",
  );
  await rename.getByRole("button", { name: "SAVE" }).click();
  const renameRequest = await renameRequestPromise;
  if (JSON.stringify(renameRequest.postDataJSON()) !== JSON.stringify({ title: "Lifecycle renamed" })) {
    throw new Error(`unexpected rename request: ${renameRequest.postData()}`);
  }
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle renamed" }).waitFor();

  const searchTrigger = page.getByRole("button", { name: "Search sessions" });
  await page.mouse.move(0, 0);
  await searchTrigger.focus();
  await page.keyboard.press("Control+K");
  const activeSearch = page.getByRole("dialog", { name: "Search sessions" });
  const sessionQuery = activeSearch.getByRole("combobox", { name: "Search sessions" });
  await page.waitForFunction(() => document.activeElement?.id === "global-session-query");
  const activeResults = activeSearch.locator("#global-session-results");
  if (await activeResults.getByRole("option").count() < 2) {
    throw new Error("search scroll proof requires at least two active sessions");
  }
  const newestFinished = activeResults.getByRole("option").first();
  await newestFinished.getByText("Pi / deployed", { exact: true }).waitFor();
  if ((await newestFinished.locator("em").innerText()).trim().toLowerCase() !== "finished") {
    throw new Error(`newly idle session was not first with finished status: ${await newestFinished.innerText()}`);
  }
  await activeResults.evaluate((element) => {
    element.style.flex = "none";
    element.style.minHeight = "0";
    element.style.height = "56px";
    element.style.maxHeight = "56px";
  });
  await sessionQuery.press("Control+n");
  await page.waitForFunction(() => {
    const results = document.getElementById("global-session-results");
    const option = document.getElementById("global-session-option-1");
    if (!results || option?.getAttribute("aria-selected") !== "true") return false;
    const viewport = results.getBoundingClientRect();
    const bounds = option.getBoundingClientRect();
    return results.scrollTop > 0 && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
  });
  const scrolledSelection = await activeResults.evaluate((element) => {
    const selected = element.querySelector('[role="option"][aria-selected="true"]');
    const viewport = element.getBoundingClientRect();
    const option = selected?.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      visible: !!option && option.top >= viewport.top - 1 && option.bottom <= viewport.bottom + 1,
      inputFocused: document.activeElement?.id === "global-session-query",
    };
  });
  if (!scrolledSelection.visible || !scrolledSelection.inputFocused || scrolledSelection.scrollTop <= 0) {
    throw new Error(`keyboard search selection was not revealed: ${JSON.stringify(scrolledSelection)}`);
  }
  await sessionQuery.press("Control+p");
  await page.waitForFunction(() => {
    const results = document.getElementById("global-session-results");
    return results?.scrollTop === 0
      && document.getElementById("global-session-option-0")?.getAttribute("aria-selected") === "true";
  });
  const returnedSelection = await activeResults.evaluate((element) => ({
    scrollTop: element.scrollTop,
    inputFocused: document.activeElement?.id === "global-session-query",
  }));
  if (returnedSelection.scrollTop !== 0 || !returnedSelection.inputFocused) {
    throw new Error(`keyboard search selection did not return into view: ${JSON.stringify(returnedSelection)}`);
  }
  await sessionQuery.fill("Lifecycle");
  await activeSearch.getByRole("option", { name: /Lifecycle renamed/ }).waitFor();
  const descendant = await sessionQuery.getAttribute("aria-activedescendant");
  if (!descendant || await page.locator(`#${descendant}[role=option][aria-selected=true]`).count() !== 1) {
    throw new Error(`invalid global search active descendant: ${descendant}`);
  }
  await activeSearch.getByRole("button", { name: /Active \(\d+\)/ }).focus();
  await page.keyboard.press("Shift+Tab");
  if (await page.locator("[role=option]:focus").count() !== 1) {
    const focused = await page.evaluate(() => document.activeElement?.outerHTML ?? "none");
    throw new Error(`modal focus trap did not wrap from its first to last control: ${focused}`);
  }
  await sessionQuery.focus();
  await sessionQuery.press("Enter");
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle renamed" }).waitFor();

  await page.getByRole("button", { name: "Session settings for Lifecycle renamed" }).click();
  await page.getByRole("menu", { name: "Lifecycle renamed session settings" }).getByRole("menuitem", { name: "Archive session" }).click();
  const archive = page.getByRole("alertdialog", { name: "Archive session?" });
  await archive.getByRole("button", { name: "ARCHIVE SESSION" }).click();
  await page.getByRole("button", { name: "Session settings for Lifecycle renamed" }).waitFor({ state: "detached" });
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();

  await page.keyboard.press("Control+K");
  const archivedSearch = page.getByRole("dialog", { name: "Search sessions" });
  await archivedSearch.getByRole("button", { name: /Archived \(1\)/ }).click();
  const archivedQuery = archivedSearch.getByRole("combobox", { name: "Search sessions" });
  await archivedQuery.fill("Lifecycle renamed");
  await archivedSearch.getByRole("option", { name: /Lifecycle renamed/ }).waitFor();
  await archivedQuery.press("Control+n");
  await archivedQuery.press("Control+p");
  await archivedQuery.press("Enter");
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle renamed" }).waitFor({ timeout: 15_000 });
  if (await page.getByRole("button", { name: "Session settings for Lifecycle renamed" }).count() !== 1) {
    throw new Error("restored session was not recataloged and selected");
  }

  await searchTrigger.focus();
  await searchTrigger.click();
  await page.getByRole("dialog", { name: "Search sessions" }).getByRole("button", { name: "Close session search" }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search sessions");

  const restoredSession = (await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  })).find((candidate) => candidate.title === "Lifecycle renamed");
  if (!restoredSession) throw new Error("restored session disappeared before stale-runtime retry proof");
  const actualRuntime = await page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/v2/session?session=${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, restoredSession.id);
  const replacementRuntime = {
    ...actualRuntime,
    workerId: `${actualRuntime.workerId}-replacement`,
    runtimeGeneration: actualRuntime.runtimeGeneration + 1,
  };
  let staleCommandAttempts = 0;
  const staleCommandBodies = [];
  await page.route("**/api/v2/session?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("session") !== restoredSession.id) return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(replacementRuntime),
    });
  });
  await page.route("**/api/v2/commands?*", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.text !== "Retarget this command") return route.continue();
    staleCommandAttempts += 1;
    staleCommandBodies.push(body);
    if (staleCommandAttempts === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "stale runtime target: worker incarnation changed",
          errorDetails: {
            kind: "Conflict",
            reason: "stale runtime target: worker incarnation changed",
          },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commandId: body.commandId, state: "dispatched", duplicate: false }),
      });
    }
  });
  await page.getByRole("textbox", { name: "Message agent" }).fill("Retarget this command");
  await page.locator("form.composer").evaluate((form) => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
  try {
    await page.getByRole("button", { name: "Retry same command" }).waitFor();
  } catch (error) {
    throw new Error(`${error.message}\nattempts: ${JSON.stringify(staleCommandBodies)}\nbody: ${await page.locator("body").innerText()}`);
  }
  await page.getByText(/The runtime is refreshing; retry the same command/).waitFor();
  if (staleCommandBodies.length !== 1) {
    throw new Error(`rapid duplicate submission allocated multiple command identities: ${JSON.stringify(staleCommandBodies)}`);
  }
  await page.getByRole("button", { name: "Session settings for Lifecycle renamed" }).click();
  await page.getByRole("menu", { name: "Lifecycle renamed session settings" }).getByRole("menuitem", { name: "Archive session" }).click();
  if (await page.getByRole("alertdialog", { name: "Archive session?" }).count() !== 0) {
    throw new Error("pending command allowed its session to be archived");
  }
  await page.getByText(/Retry or abandon the uncertain command before archiving/).waitFor();
  await page.getByRole("button", { name: "Retry same command" }).click();
  await page.getByRole("button", { name: "Retry same command" }).waitFor({ state: "detached" });
  if (
    staleCommandBodies.length !== 2
    || staleCommandBodies[0].commandId !== staleCommandBodies[1].commandId
    || staleCommandBodies[0].text !== staleCommandBodies[1].text
    || JSON.stringify(staleCommandBodies[0].target) === JSON.stringify(staleCommandBodies[1].target)
    || staleCommandBodies[1].target.workerId !== replacementRuntime.workerId
    || staleCommandBodies[1].target.runtimeGeneration !== replacementRuntime.runtimeGeneration
  ) {
    throw new Error(`stale-runtime retry did not preserve and retarget the command: ${JSON.stringify(staleCommandBodies)}`);
  }
  await page.unroute("**/api/v2/commands?*");
  await page.unroute("**/api/v2/session?*");

  const rememberedSession = await page.evaluate(() => localStorage.getItem("piss:last-opened-session"));
  if (rememberedSession !== restoredSession.id) {
    throw new Error(`selected session was not persisted: ${rememberedSession}`);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle renamed" }).waitFor();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage();
  mobile.on("console", (message) => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  mobile.on("pageerror", (error) => errors.push(`mobile page: ${error.message}`));
  await mobile.goto(url, { waitUntil: "domcontentloaded" });
  const mobileMenu = mobile.locator("#mobile-menu-button");
  await assertPaintedSvg(mobileMenu.locator("svg"), "mobile menu trigger");
  await mobile.getByRole("button", { name: "Open workspaces and sessions" }).tap();
  await mobile.waitForFunction(() => document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "true");
  if (await mobileMenu.getAttribute("aria-label") !== "Close workspaces and sessions") {
    throw new Error("open mobile menu button did not expose its close action");
  }
  await mobileMenu.tap();
  await mobile.waitForFunction(() =>
    document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "false"
    && document.activeElement?.id === "mobile-menu-button",
  );
  await mobile.getByRole("button", { name: "Open workspaces and sessions" }).tap();
  await mobile.waitForFunction(() => document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "true");
  await mobile.getByRole("button", { name: /^Pi \/ deployed idle \/ opencode$/ }).tap();
  await mobile.waitForFunction(() => document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "false");
  if (await mobile.locator(".conversation-heading").count() !== 0) {
    throw new Error("mobile layout retained the duplicate conversation header");
  }
  if (await mobile.getByRole("button", { name: "Mention a workspace file" }).count() !== 0) {
    throw new Error("mobile composer retained the redundant mention button");
  }
  const composerLayout = await mobile.locator(".composer-footer").evaluate((footer) => {
    const bounds = footer.getBoundingClientRect();
    const controls = [...footer.querySelectorAll(".composer-config-trigger")].map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    const send = footer.querySelector(".send-action")?.getBoundingClientRect();
    return {
      footer: { left: bounds.left, right: bounds.right },
      controls,
      send: send ? { left: send.left, right: send.right } : null,
    };
  });
  if (
    composerLayout.controls.length !== 2
    || composerLayout.controls.some((control) => control.width < 60)
    || composerLayout.controls[0].right > composerLayout.controls[1].left
    || composerLayout.controls[0].left < composerLayout.footer.left
    || composerLayout.controls[1].right > (composerLayout.send?.left ?? composerLayout.footer.right)
  ) {
    throw new Error(`mobile composer controls overlap: ${JSON.stringify(composerLayout)}`);
  }
  for (const [triggerSelector, menuSelector] of [
    [".composer-config-trigger.model", ".composer-config-menu.model-menu"],
    [".composer-config-trigger.thinking", ".composer-config-menu.thinking-menu"],
  ]) {
    const trigger = mobile.locator(triggerSelector);
    await trigger.tap();
    const menu = mobile.locator(menuSelector);
    await menu.waitFor();
    const bounds = await menu.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    });
    if (bounds.top < 8 || bounds.left < 8 || bounds.right > 382 || bounds.bottom > 770) {
      throw new Error(`mobile config menu escaped the viewport: ${JSON.stringify({ menuSelector, bounds })}`);
    }
    await trigger.tap();
    await menu.waitFor({ state: "detached" });
  }
  const viewportHeight = await mobile.evaluate(() => ({
    css: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")),
    visible: window.visualViewport?.height ?? window.innerHeight,
  }));
  if (Math.abs(viewportHeight.css - viewportHeight.visible) > 1) {
    throw new Error(`app height did not follow visualViewport: ${JSON.stringify(viewportHeight)}`);
  }
  await mobile.getByRole("button", { name: "Search sessions" }).tap();
  const mobileSearch = mobile.getByRole("dialog", { name: "Search sessions" });
  const mobileBounds = await mobileSearch.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  if (Math.abs(mobileBounds.width - 390) > 1 || Math.abs(mobileBounds.height - viewportHeight.visible) > 1) {
    throw new Error(`mobile modal did not fill the visual viewport: ${JSON.stringify(mobileBounds)}`);
  }
  await mobile.keyboard.press("Escape");
  await mobileSearch.waitFor({ state: "detached" });
  await mobileContext.close();

  const keptArchived = await page.evaluate(async (sessionId) => {
    const createResponse = await fetch("/api/v2/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "test-workspace", title: "Keep archived", harness: "opencode" }),
    });
    if (!createResponse.ok) throw new Error(await createResponse.text());
    const created = await createResponse.json();
    for (const id of [sessionId, created.id]) {
      const response = await fetch(`/api/v2/sessions/${encodeURIComponent(id)}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(await response.text());
    }
    return created;
  }, restoredSession.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();
  await searchTrigger.click();
  const deleteSearch = page.getByRole("dialog", { name: "Search sessions" });
  await deleteSearch.getByRole("button", { name: /Archived \(2\)/ }).click();
  const selectLifecycle = deleteSearch.getByRole("button", { name: "Select archived session Lifecycle renamed" });
  if (await selectLifecycle.getAttribute("aria-pressed") !== "false") {
    throw new Error("archived session checkbox started selected");
  }
  await selectLifecycle.click();
  await deleteSearch.getByRole("button", { name: "Deselect archived session Lifecycle renamed" }).waitFor();
  const archivedAfterSelection = await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions?archived=true");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  if (archivedAfterSelection.length !== 2) {
    throw new Error(`selecting an archived session restored it: ${JSON.stringify(archivedAfterSelection)}`);
  }
  const selectedDeleteRequestPromise = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === "/api/v2/sessions/delete-archived" && candidate.method() === "POST",
  );
  await deleteSearch.getByRole("button", { name: "Delete selected (1)" }).click();
  const deleteSelected = page.getByRole("alertdialog", { name: "Delete selected sessions?" });
  await deleteSelected.getByText(/1 selected archived session and all of their conversation data will be permanently deleted/).waitFor();
  await deleteSelected.getByRole("button", { name: "DELETE SELECTED SESSIONS" }).click();
  const selectedDeleteRequest = await selectedDeleteRequestPromise;
  if (JSON.stringify(selectedDeleteRequest.postDataJSON()) !== JSON.stringify({ ids: [restoredSession.id] })) {
    throw new Error(`unexpected selected delete request: ${selectedDeleteRequest.postData()}`);
  }
  await deleteSelected.waitFor({ state: "detached" });
  const archivedAfterSelectedDelete = await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions?archived=true");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  if (archivedAfterSelectedDelete.length !== 1 || archivedAfterSelectedDelete[0].id !== keptArchived.id) {
    throw new Error(`selected deletion affected unselected sessions: ${JSON.stringify(archivedAfterSelectedDelete)}`);
  }
  await searchTrigger.click();
  const remainingSearch = page.getByRole("dialog", { name: "Search sessions" });
  await remainingSearch.getByRole("button", { name: /Archived \(1\)/ }).click();
  await remainingSearch.getByRole("button", { name: "Delete all archived sessions" }).click();
  const deleteArchived = page.getByRole("alertdialog", { name: "Delete archived sessions?" });
  await deleteArchived.getByRole("button", { name: "DELETE ARCHIVED SESSIONS" }).click();
  await deleteArchived.waitFor({ state: "detached" });
  const archivedAfterDelete = await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions?archived=true");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  if (archivedAfterDelete.length !== 0) {
    throw new Error(`archived sessions remained after bulk deletion: ${JSON.stringify(archivedAfterDelete)}`);
  }
  if (await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).count() !== 1) {
    throw new Error("deleting archived sessions affected the active session");
  }
  if (intentionalNetworkFailures !== 1) {
    throw new Error(`expected one discarded command response, observed ${intentionalNetworkFailures}`);
  }
  if (intentionalAuditFailures !== 1) {
    throw new Error(`expected one readable Audit failure, observed ${intentionalAuditFailures}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Bonsai session browser proof passed: release-sized bundle, remembered session reload, catalog, lifecycle create/rename/archive/restore/selective-delete/bulk-delete, workspace conflict/add/remove, global search, Agent/Audit/Details keyboard tabs, session-bound real-file Audit journey and returned-file ledger at desktop/mobile widths, config, images, response-loss/stale-runtime same-ID retry, steer/follow-up, cancel, runtime details, accessible mobile modal/drawer, viewport sync, aggregation, sticky follow, permissions, and streaming");
} finally {
  if (browser) await browser.close();
  await Promise.all(auditProofFiles.map(async (file) => {
    try { await unlink(join(workspace, file.relative)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));
}
