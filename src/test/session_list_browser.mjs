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
    if (message.type() === "error" && !message.text().includes("409 (Conflict)")) errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const session = page.getByRole("button", { name: /^Pi \/ deployed idle \/ mock$/ });
  try {
    await session.waitFor();
  } catch (error) {
    throw new Error(`${error.message}\n${errors.join("\n")}\nbody: ${await page.locator("body").innerText()}`);
  }
  await page.getByText("session / s-mention-browser", { exact: true }).waitFor();
  await page.locator(".app-header").getByRole("heading", { name: "Pi / deployed" }).waitFor();
  await page.locator(".app-header").getByText(/PISS rewrite \/ \/home/).waitFor();
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
  const tabs = page.getByRole("tablist", { name: "Session views" }).getByRole("tab");
  const tabLabels = await tabs.allTextContents();
  if (JSON.stringify(tabLabels) !== JSON.stringify(["Agent", "Working", "Changes", "Details"])) {
    throw new Error(`unexpected session tabs: ${JSON.stringify(tabLabels)}`);
  }
  if (!(await page.getByRole("tab", { name: "Changes" }).isDisabled())) {
    throw new Error("Changes tab was enabled before its product slice exists");
  }
  const agentTab = page.getByRole("tab", { name: "Agent" });
  const workingTab = page.getByRole("tab", { name: "Working" });
  const detailsTab = page.getByRole("tab", { name: "Details" });
  await agentTab.focus();
  await agentTab.press("ArrowRight");
  await page.waitForFunction(() => document.getElementById("session-tab-working")?.getAttribute("aria-selected") === "true");
  await workingTab.press("ArrowLeft");
  const modelButton = page.getByRole("button", { name: "Model: Mock Fast" });
  await modelButton.click();
  const modelRequestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/config-options") && request.method() === "POST",
  );
  await page.getByRole("menu", { name: "Model options" }).getByRole("menuitemradio", { name: /Mock Deep/ }).click();
  const modelRequest = await modelRequestPromise;
  if (JSON.stringify(modelRequest.postDataJSON()) !== JSON.stringify({ configId: "model", value: "mock/deep" })) {
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
  if (
    JSON.stringify(configRequest.postDataJSON()) !== JSON.stringify({ configId: "thought_level", value: "high" })
    || new URL(configRequest.url()).searchParams.get("session") !== "s-mention-browser"
  ) {
    throw new Error(`unexpected config request: ${configRequest.postData()}`);
  }
  await page.getByRole("button", { name: "Thinking: high" }).waitFor();
  await detailsTab.click();
  await page.getByRole("region", { name: "Session runtime details" }).getByText("worker-s-mention-browser", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Configuration options" }).getByText("Mock Fast", { exact: false }).waitFor();
  await agentTab.click();
  const returnToAgentAfterRun = async (required = false) => {
    try {
      await page.waitForFunction(
        () => document.getElementById("session-tab-working")?.getAttribute("aria-selected") === "true",
        undefined,
        { timeout: 3_000 },
      );
    } catch (error) {
      if (required) throw error;
    }
    if (await workingTab.getAttribute("aria-selected") === "true") await agentTab.click();
  };
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
  await page.getByRole("textbox", { name: "Message agent" }).fill(prompt);
  const requestPromise = page.waitForRequest(
    (request) => request.url().includes("/api/v2/commands") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await returnToAgentAfterRun(true);
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
  await disclosure.locator(":scope > summary").click();
  await firstTool.getByRole("button", { name: "Copy tool output" }).click();
  const toolClipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (!toolClipboard.includes("dune runtest") || !toolClipboard.includes("2 tests passed")) {
    throw new Error(`aggregated tool copy was incomplete: ${toolClipboard}`);
  }
  await disclosure.locator(":scope > summary").click();

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
  await returnToAgentAfterRun();
  await page.getByText("Received 1 image attachment.", { exact: true }).waitFor({ timeout: 10000 });
  if ((await page.locator("body").innerText()).includes(gifData)) {
    throw new Error("base64 image data was rendered into the timeline");
  }

  await waitForIdle();
  const permissionPrompt = "permission: render the browser decision path";
  await page.getByRole("textbox", { name: "Message agent" }).fill(permissionPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await returnToAgentAfterRun();
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
  await returnToAgentAfterRun();
  await page.getByRole("button", { name: "Steer next" }).waitFor();
  if (!(await page.getByRole("button", { name: "Send message" }).isDisabled())) {
    throw new Error("permission resolution inferred a running delivery action");
  }
  await page.getByText("state / completed", { exact: true }).last().waitFor({ timeout: 10000 });
  if (eventPageRequests.length !== 1) {
    throw new Error(`permission flow polled event pages: ${JSON.stringify(eventPageRequests)}`);
  }

  await waitForIdle();
  await page.getByRole("textbox", { name: "Message agent" }).fill("hold active for steering");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() =>
    document.getElementById("session-tab-working")?.getAttribute("aria-selected") === "true"
    || [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Steer next")),
  );
  if (await workingTab.getAttribute("aria-selected") === "true") await agentTab.click();
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
  if (
    JSON.stringify(cancelRequest.postDataJSON()) !== "{}"
    || new URL(cancelRequest.url()).searchParams.get("session") !== "s-mention-browser"
  ) {
    throw new Error(`unexpected cancel request: ${cancelRequest.postData()}`);
  }
  await page.getByText("Cancellation requested. Waiting for session events.", { exact: false }).waitFor();

  await waitForIdle();
  await page.getByRole("textbox", { name: "Message agent" }).fill("hold active for follow-up");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() =>
    document.getElementById("session-tab-working")?.getAttribute("aria-selected") === "true"
    || [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Follow-up")),
  );
  if (await workingTab.getAttribute("aria-selected") === "true") await agentTab.click();
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
    const response = await fetch("/api/v2/commands?session=s-mention-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: `browser-${crypto.randomUUID()}`, text: prompt, images: [], resources: [], action: "prompt" }),
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
    await page.getByRole("button", { name: "Jump to latest message" }).waitFor({ timeout: 3_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      tab: document.getElementById("session-tab-agent")?.getAttribute("aria-selected"),
      panelHidden: document.getElementById("session-panel-agent")?.hasAttribute("hidden"),
      buttonHidden: document.querySelector('[aria-label="Jump to latest message"]')?.hasAttribute("hidden"),
      scrollTop: document.getElementById("timeline")?.scrollTop,
    }));
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  const agentCount = await page.locator(".timeline-agent").count();
  await dispatchPrompt("manual scroll should stay put");
  await returnToAgentAfterRun();
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
  await returnToAgentAfterRun();
  await timeline.evaluate((value) => { value.scrollTop = value.scrollHeight; value.dispatchEvent(new Event("scroll")); });
  await page.locator('[aria-label="Jump to latest message"]').evaluate((button) => button.click());
  await page.waitForFunction((count) => document.querySelectorAll(".timeline-agent").length > count, nextAgentCount);
  await timeline.evaluate((value) => { value.scrollTop = value.scrollHeight; value.dispatchEvent(new Event("scroll")); });
  await page.waitForFunction(() => {
    const value = document.getElementById("timeline");
    return value && value.scrollHeight - value.scrollTop - value.clientHeight <= 2;
  });
  if (await page.locator("details.tool-disclosure[open]").count() !== 0) {
    throw new Error("streamed tool updates opened a collapsed disclosure");
  }

  const workspaceSettings = page.getByRole("button", { name: "Workspace settings for PISS rewrite" });
  await workspaceSettings.click();
  await page.getByRole("menu", { name: "PISS rewrite workspace settings" }).getByRole("menuitem", { name: "Remove workspace" }).click();
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

  await page.getByRole("button", { name: "New session in PISS rewrite" }).click();
  const creator = page.getByRole("dialog", { name: "New session" });
  await creator.getByLabel("Session title").fill("Lifecycle proof");
  if (await creator.getByRole("combobox", { name: "Session harness" }).inputValue() !== "mock") {
    throw new Error("session creator offered a harness not derived from the managed host");
  }
  const createRequestPromise = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === "/api/v2/sessions" && candidate.method() === "POST",
  );
  await creator.getByRole("button", { name: "START SESSION" }).click();
  const createRequest = await createRequestPromise;
  if (JSON.stringify(createRequest.postDataJSON()) !== JSON.stringify({ workspaceId: "test-workspace", title: "Lifecycle proof", harness: "mock" })) {
    throw new Error(`unexpected create request: ${createRequest.postData()}`);
  }
  await page.locator(".app-header").getByRole("heading", { name: "Lifecycle proof" }).waitFor({ timeout: 15_000 });

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
  await searchTrigger.focus();
  await page.keyboard.press("Control+K");
  const activeSearch = page.getByRole("dialog", { name: "Search sessions" });
  const sessionQuery = activeSearch.getByRole("combobox", { name: "Search sessions" });
  await page.waitForFunction(() => document.activeElement?.id === "global-session-query");
  await sessionQuery.fill("Lifecycle");
  await activeSearch.getByRole("option", { name: /Lifecycle renamed/ }).waitFor();
  const descendant = await sessionQuery.getAttribute("aria-activedescendant");
  if (!descendant || await page.locator(`#${descendant}[role=option][aria-selected=true]`).count() !== 1) {
    throw new Error(`invalid global search active descendant: ${descendant}`);
  }
  await activeSearch.getByRole("button", { name: "Close session search" }).focus();
  await page.keyboard.press("Shift+Tab");
  if (await page.locator("[role=option]:focus").count() !== 1) {
    throw new Error("modal focus trap did not wrap from its first to last control");
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

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage();
  mobile.on("console", (message) => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  mobile.on("pageerror", (error) => errors.push(`mobile page: ${error.message}`));
  await mobile.goto(url, { waitUntil: "domcontentloaded" });
  const mobileMenu = mobile.getByRole("button", { name: "Open workspaces and sessions" });
  await mobileMenu.tap();
  await mobile.waitForFunction(() => document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "true");
  await mobile.getByRole("button", { name: /^Pi \/ deployed idle \/ mock$/ }).tap();
  await mobile.waitForFunction(() => document.getElementById("mobile-menu-button")?.getAttribute("aria-expanded") === "false");
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
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Bonsai session browser proof passed: catalog, lifecycle create/rename/archive/restore, workspace conflict/add/remove, global search, tabs, config, images, steer/follow-up, cancel, runtime details, accessible mobile modal/drawer, viewport sync, aggregation, sticky follow, permissions, and streaming");
} finally {
  await browser.close();
}
