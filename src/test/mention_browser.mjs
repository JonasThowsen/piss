import { createRequire } from "node:module";

const [url, workspace] = process.argv.slice(2);
if (!url || !workspace) throw new Error("browser test URL and workspace are required");
const require = createRequire(import.meta.url);
const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH;
if (!playwrightCorePath) throw new Error("PLAYWRIGHT_CORE_PATH is required");
const { chromium } = require(playwrightCorePath);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required");

const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktopContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const desktop = await desktopContext.newPage();
  desktop.on("console", (message) => {
    if (message.type() === "error") errors.push(`desktop console: ${message.text()}`);
  });
  desktop.on("pageerror", (error) => errors.push(`desktop page: ${error.message}`));
  await desktop.goto(url, { waitUntil: "domcontentloaded" });
  const textarea = desktop.getByRole("textbox", { name: "Message agent" });
  await textarea.fill("Review @web/main before release");
  await textarea.evaluate((field) => {
    field.focus();
    field.setSelectionRange(16, 16);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  const appOption = desktop.getByRole("option", { name: /^main\.ml web\/main\.ml$/ });
  await appOption.waitFor();
  await desktop.locator("#file-mention-options").ariaSnapshot();
  await textarea.press("ArrowDown");
  await desktop.waitForFunction(
    () => document.querySelector("#file-mention-0")?.getAttribute("aria-selected") === "true",
  );
  await textarea.press("ArrowUp");
  await textarea.press("Escape");
  await desktop.locator("#file-mention-options").waitFor({ state: "detached" });
  await textarea.evaluate((field) =>
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })),
  );
  await appOption.waitFor();
  await textarea.press("Enter");
  const expected = "Review @web/main.ml before release";
  const inserted = await textarea.inputValue();
  if (inserted !== expected) {
    throw new Error(`keyboard mention insertion lost surrounding text: ${JSON.stringify(inserted)}`);
  }
  const requestPromise = desktop.waitForRequest(
    (request) => request.url().includes("/api/v2/commands") && request.method() === "POST",
  );
  await desktop.getByRole("button", { name: "Send message" }).click();
  const body = (await requestPromise).postDataJSON();
  if (body.text !== expected || body.resources?.[0]?.path !== "web/main.ml") {
    throw new Error(`typed ACP resource input missing: ${JSON.stringify(body)}`);
  }

  const agentResponse = "Received typed resource link: web/main.ml.";
  await desktop.getByText(agentResponse).waitFor({ timeout: 10000 });
  const firstTool = desktop.locator(".timeline-tool").last();
  const firstDisclosure = firstTool.locator("details.tool-disclosure");
  if (await firstDisclosure.getAttribute("open") !== null) throw new Error("tool call was expanded by default");
  await firstDisclosure.locator("summary").first().click();
  await firstTool.getByRole("button", { name: "Copy tool output" }).click();
  const toolClipboard = await desktop.evaluate(() => navigator.clipboard.readText());
  if (!toolClipboard.includes("dune runtest") || !toolClipboard.includes("2 tests passed")) {
    throw new Error(`tool copy returned the wrong text: ${toolClipboard}`);
  }
  await firstDisclosure.locator("summary").first().click();

  const message = desktop.locator(".timeline-agent").last();
  const messageCopy = message.getByRole("button", { name: "Copy message" });
  await messageCopy.click();
  if (await desktop.evaluate(() => navigator.clipboard.readText()) !== agentResponse) {
    throw new Error("message copy returned the wrong text");
  }
  await desktop.waitForTimeout(1000);
  await message.getByRole("button", { name: "Copied message" }).click();
  await desktop.waitForTimeout(1000);
  if (await message.getByRole("button", { name: "Copied message" }).count() !== 1) {
    throw new Error("repeated copy feedback reset too early");
  }

  const waitForIdle = () => desktop.waitForFunction(async () => {
    const response = await fetch("/api/v2/session?session=s-mention-browser");
    return response.ok && (await response.json()).status === "idle";
  });
  const dispatchPrompt = (text) => desktop.evaluate(async (prompt) => {
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
  const latestButton = desktop.getByRole("button", { name: "Jump to latest message" });
  if (await latestButton.isVisible()) await latestButton.click();
  await desktop.setViewportSize({ width: 1440, height: 500 });
  const timeline = desktop.locator("#timeline");
  await desktop.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight > value.clientHeight;
  });
  await desktop.waitForTimeout(500);
  await timeline.evaluate((value) => { value.scrollTop = value.scrollHeight; value.dispatchEvent(new Event("scroll")); });
  await desktop.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  await timeline.evaluate((value) => { value.scrollTop = 0; value.dispatchEvent(new Event("scroll")); });
  await desktop.getByRole("button", { name: "Jump to latest message" }).waitFor();
  const agentCount = await desktop.locator(".timeline-agent").count();
  await dispatchPrompt("manual scroll should stay put");
  await desktop.waitForFunction((count) => document.querySelectorAll(".timeline-agent").length > count, agentCount);
  if (await timeline.evaluate((value) => value.scrollTop) > 4) throw new Error("stream overrode the user's manual scroll position");

  await desktop.getByRole("button", { name: "Jump to latest message" }).click();
  await desktop.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  await waitForIdle();
  const nextAgentCount = await desktop.locator(".timeline-agent").count();
  await dispatchPrompt("follow this stream while typing");
  await textarea.fill("");
  const typingStarted = Date.now();
  await textarea.pressSequentially("responsive input ".repeat(20));
  const typingElapsed = Date.now() - typingStarted;
  if (typingElapsed > 1500) throw new Error(`composer typing remained laggy: ${typingElapsed}ms`);
  await desktop.waitForFunction((count) => document.querySelectorAll(".timeline-agent").length > count, nextAgentCount);
  await desktop.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  if (await desktop.locator("details.tool-disclosure[open]").count() !== 0) {
    throw new Error("a streamed tool call opened itself");
  }

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage();
  mobile.on("console", (message) => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  mobile.on("pageerror", (error) => errors.push(`mobile page: ${error.message}`));
  await mobile.goto(url, { waitUntil: "domcontentloaded" });
  const mobileTextarea = mobile.getByRole("textbox", { name: "Message agent" });
  if (await mobile.getByRole("button", { name: "Mention a workspace file" }).count() !== 0) {
    throw new Error("redundant composer mention button remained visible");
  }
  await mobileTextarea.fill("Touch mention @web/main");
  const mobileOption = mobile.getByRole("option", { name: /^main\.ml web\/main\.ml$/ });
  await mobileOption.waitFor();
  await mobile.locator("#file-mention-options").ariaSnapshot();
  await mobileOption.tap();
  if ((await mobileTextarea.inputValue()) !== "Touch mention @web/main.ml") {
    throw new Error("touch mention insertion failed");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`workbench browser proof passed: collapsed tools, reliable copy, responsive input (${typingElapsed}ms/340 characters), sticky streaming, manual-scroll escape, mentions, touch, accessibility, and console`);
} finally {
  await browser.close();
}
