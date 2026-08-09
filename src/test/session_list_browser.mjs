import { createRequire } from "node:module";

const [url, workspace] = process.argv.slice(2);
if (!url || !workspace) throw new Error("browser test URL and workspace are required");

const require = createRequire(import.meta.url);
const { chromium } = require(`${workspace}/node_modules/playwright-core`);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required");

const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const page = await context.newPage();
  const eventPageRequests = [];
  const eventStreamRequests = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/api/v2/events") eventPageRequests.push(request.url());
    if (requestUrl.pathname === "/api/v2/event-stream") eventStreamRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const session = page.getByRole("button", { name: /Pi \/ deployed/ });
  try {
    await session.waitFor();
  } catch (error) {
    throw new Error(`${error.message}\n${errors.join("\n")}\nbody: ${await page.locator("body").innerText()}`);
  }
  await page.getByText("session / s-mention-browser", { exact: true }).waitFor();
  if (eventStreamRequests.length === 0) {
    await page.waitForRequest((request) => request.url().includes("/api/v2/event-stream"));
  }
  if (
    eventPageRequests.length !== 1
    || !eventPageRequests[0].includes("recent=500")
    || !eventPageRequests[0].includes("session=s-mention-browser")
  ) {
    throw new Error(`unexpected initial event requests: ${JSON.stringify(eventPageRequests)}`);
  }
  const streamUrl = new URL(eventStreamRequests.at(-1));
  if (
    streamUrl.searchParams.get("session") !== "s-mention-browser"
    || !/^\d+$/.test(streamUrl.searchParams.get("after") ?? "")
  ) {
    throw new Error(`unexpected event stream request: ${streamUrl}`);
  }
  const sessions = await page.evaluate(async () => {
    const response = await fetch("/api/v2/sessions");
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  if (sessions.length !== 1 || sessions[0].id !== "s-mention-browser") {
    throw new Error(`unexpected session response: ${JSON.stringify(sessions)}`);
  }
  const prompt = "Render the deterministic Bonsai response";
  await page.getByRole("textbox", { name: "Message agent" }).fill(prompt);
  const requestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/commands") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await requestPromise;
  const body = request.postDataJSON();
  if (
    !body.commandId?.startsWith("web-")
    || body.text !== prompt
    || body.action !== "prompt"
    || body.images?.length !== 0
    || body.resources?.length !== 0
    || !request.url().includes("session=s-mention-browser")
  ) {
    throw new Error(`unexpected command request: ${JSON.stringify(body)}`);
  }
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 10000 });
  await page.getByText("Running durability tests", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.getByText("The worker retained ownership while the control plane was replaceable.", { exact: true }).waitFor({ timeout: 10000 });
  await page.getByText("state / completed", { exact: true }).waitFor({ timeout: 10000 });
  const firstTool = page.locator(".timeline-tool");
  if (await firstTool.count() !== 1) throw new Error("tool lifecycle did not aggregate into one row");
  const disclosure = firstTool.locator("details.tool-disclosure");
  if (await disclosure.getAttribute("open") !== null) throw new Error("tool call was expanded by default");
  await disclosure.locator("summary").click();
  await firstTool.getByRole("button", { name: "Copy tool output" }).click();
  const toolClipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (!toolClipboard.includes("dune runtest") || !toolClipboard.includes("2 tests passed")) {
    throw new Error(`aggregated tool copy was incomplete: ${toolClipboard}`);
  }
  await disclosure.locator("summary").click();

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
  if (eventPageRequests.length !== 1) {
    throw new Error(`post-submit polling remained active: ${JSON.stringify(eventPageRequests)}`);
  }

  const permissionPrompt = "permission: render the browser decision path";
  await page.getByRole("textbox", { name: "Message agent" }).fill(permissionPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const permissionCard = page.locator(".timeline-permission");
  await permissionCard.getByText("Allow the stability proof", { exact: true }).waitFor();
  await page.getByText("requires_action", { exact: true }).waitFor();
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
  await page.getByText("state / completed", { exact: true }).last().waitFor({ timeout: 10000 });
  if (eventPageRequests.length !== 1) {
    throw new Error(`permission flow polled event pages: ${JSON.stringify(eventPageRequests)}`);
  }

  const waitForIdle = () => page.waitForFunction(async () => {
    const response = await fetch("/api/v2/session?session=s-mention-browser");
    return response.ok && (await response.json()).status === "idle";
  });
  const dispatchPrompt = (text) => page.evaluate(async (prompt) => {
    const response = await fetch("/api/v2/commands?session=s-mention-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: `browser-${crypto.randomUUID()}`, text: prompt, images: [], resources: [], action: "prompt" }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, text);
  await waitForIdle();
  await page.waitForTimeout(1600);
  await page.setViewportSize({ width: 1280, height: 500 });
  const timeline = page.locator("#timeline");
  await page.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight > value.clientHeight;
  });
  await page.waitForTimeout(500);
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
  await page.getByRole("button", { name: "Jump to latest message" }).waitFor();
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
  if (await page.locator("details.tool-disclosure[open]").count() !== 0) {
    throw new Error("streamed tool updates opened a collapsed disclosure");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Bonsai session browser proof passed: aggregation, collapsed tools, copy reset, sticky follow, manual-scroll escape, permissions, and streaming");
} finally {
  await browser.close();
}
