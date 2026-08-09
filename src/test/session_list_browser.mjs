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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Bonsai operational session browser proof passed");
} finally {
  await browser.close();
}
