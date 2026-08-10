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

const command = (sequence, label = `history-${sequence}`) => ({
  sequence,
  kind: "command.accepted",
  payload: {
    commandId: `command-${sequence}`,
    requestId: `request-${sequence}`,
    action: "prompt",
    text: label,
    imageCount: 0,
    images: [],
    resourceCount: 0,
    resources: [],
  },
  createdAt: 1_723_123_456 + sequence,
});

const agent = (sequence, sessionId) => ({
  sequence,
  kind: "acp.agent_message_chunk",
  payload: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "# Browser Markdown\n\nSafe [link](https://example.test) and unsafe [label](javascript:alert(1)).\n\n```js\nconst proof = true;\n```",
        },
      },
    },
  },
  createdAt: 1_723_123_456 + sequence,
});

const permission = (sequence, sessionId) => ({
  sequence,
  kind: "acp.permission.requested",
  payload: {
    jsonrpc: "2.0",
    id: "permission-before-recent-window",
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "old-tool",
        title: "Recover retained permission",
        kind: "execute",
        status: "pending",
        rawInput: { command: "retained-proof" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  },
  createdAt: 1_723_123_456 + sequence,
});

const configure = async (context, mode) => {
  const sessionsResponse = await context.request.get(`${url}/api/v2/sessions`);
  if (!sessionsResponse.ok()) throw new Error(await sessionsResponse.text());
  const sessions = await sessionsResponse.json();
  if (!sessions.length) throw new Error("timeline proof requires an active session");
  const selected = sessions[0];
  const snapshotResponse = await context.request.get(
    `${url}/api/v2/session?session=${encodeURIComponent(selected.id)}`,
  );
  if (!snapshotResponse.ok()) throw new Error(await snapshotResponse.text());
  const snapshot = await snapshotResponse.json();
  const requiresAction = mode !== "history";
  const firstSequence = requiresAction ? 1 : 2;
  const runtime = {
    ...snapshot,
    status: requiresAction ? "requires_action" : "idle",
    firstSequence,
    lastSequence: 701,
    retentionPruned: mode === "history",
  };
  const summary = { ...selected, ...runtime, status: runtime.status };
  const requests = [];

  await context.route("**/api/v2/sessions*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const body = requestUrl.searchParams.get("archived") === "true" ? [] : [summary];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await context.route("**/api/v2/session?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runtime) })
  );
  await context.route("**/api/v2/events?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    requests.push(requestUrl);
    let events;
    if (requestUrl.searchParams.has("recent")) {
      events = Array.from({ length: 500 }, (_, index) => command(index + 202));
      if (mode === "history") events[499] = agent(701, selected.id);
    } else {
      const before = Number(requestUrl.searchParams.get("before"));
      if (mode === "history" && before === 202) {
        events = Array.from({ length: 200 }, (_, index) => command(index + 2));
      } else if (requiresAction && before === 202) {
        events = Array.from({ length: 200 }, (_, index) => command(index + 2));
      } else if (mode === "permission" && before === 2) {
        events = [permission(1, selected.id)];
      } else {
        events = [];
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(events) });
  });
  return { selected, requests };
};

try {
  const historyContext = await browser.newContext({ viewport: { width: 1280, height: 600 } });
  await historyContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const history = await configure(historyContext, "history");
  const page = await historyContext.newPage();
  page.on("pageerror", (error) => errors.push(`history page: ${error.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const timeline = page.locator("#timeline");
  await page.getByText("Retained history begins at sequence 2", { exact: false }).waitFor();
  await page.getByText("Browser Markdown", { exact: true }).waitFor();
  const loadEarlier = page.getByRole("button", { name: "Load earlier activity" });
  await page.waitForFunction(() => {
    const element = document.getElementById("timeline");
    return element && element.scrollHeight > element.clientHeight;
  });
  await page.waitForFunction(() => {
    const element = document.getElementById("timeline");
    return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  }, undefined, { timeout: 5_000 });
  const initialPosition = await timeline.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight,
  }));
  if (initialPosition.height - initialPosition.top - initialPosition.client > 2) {
    throw new Error(`initial history did not open at the latest event: ${JSON.stringify(initialPosition)}`);
  }
  if (await loadEarlier.count()) {
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const anchor = await timeline.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const item = [...element.querySelectorAll(".timeline-item[data-timeline-key]")]
        .find((candidate) => candidate.getBoundingClientRect().bottom > top);
      if (!item) throw new Error("no visible history anchor");
      return {
        key: item.getAttribute("data-timeline-key"),
        offset: item.getBoundingClientRect().top - top,
      };
    });
    await loadEarlier.click();
    await page.waitForFunction(({ key, offset }) => {
      const timelineElement = document.getElementById("timeline");
      const item = [...document.querySelectorAll(".timeline-item[data-timeline-key]")]
        .find((candidate) => candidate.getAttribute("data-timeline-key") === key);
      return timelineElement && item
        && Math.abs(
          item.getBoundingClientRect().top - timelineElement.getBoundingClientRect().top - offset,
        ) <= 0.5;
    }, anchor, { timeout: 5_000 });
  }
  const beforeRequests = history.requests.filter((request) => request.searchParams.has("before"));
  const beforeSequences = beforeRequests.map((request) => request.searchParams.get("before"));
  if (
    ![JSON.stringify(["202"]), JSON.stringify(["202", "2"])].includes(JSON.stringify(beforeSequences))
    || beforeRequests.some((request) =>
      request.searchParams.get("limit") !== "200"
      || request.searchParams.get("session") !== history.selected.id)
  ) throw new Error(`unexpected history pages: ${beforeRequests.join(",")}`);
  if (await page.locator('a[href^="javascript:"]').count()) {
    throw new Error("unsafe Markdown link was rendered as an anchor");
  }
  const safeLink = page.locator('a[href="https://example.test"]');
  if (
    await safeLink.getAttribute("target") !== "_blank"
    || await safeLink.getAttribute("rel") !== "noopener noreferrer"
  ) throw new Error("safe Markdown link omitted isolation attributes");
  const codeCopy = page.getByRole("button", { name: "Copy code block" });
  await codeCopy.click();
  if (await page.evaluate(() => navigator.clipboard.readText()) !== "const proof = true;") {
    throw new Error("fenced-code copy omitted or changed code");
  }
  await page.getByRole("button", { name: "Copied code block" }).waitFor();
  await historyContext.close();

  const mobileHistoryContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await configure(mobileHistoryContext, "history");
  const mobileHistoryPage = await mobileHistoryContext.newPage();
  mobileHistoryPage.on("pageerror", (error) => errors.push(`mobile history page: ${error.message}`));
  await mobileHistoryPage.goto(url, { waitUntil: "domcontentloaded" });
  await mobileHistoryPage.getByText("Browser Markdown", { exact: true }).waitFor();
  await mobileHistoryPage.waitForFunction(() => {
    const element = document.getElementById("timeline");
    return element && element.scrollHeight > element.clientHeight;
  });
  await mobileHistoryPage.waitForFunction(() => {
    const element = document.getElementById("timeline");
    return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  }, undefined, { timeout: 5_000 });
  const mobileInitialPosition = await mobileHistoryPage.locator("#timeline").evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight,
  }));
  if (mobileInitialPosition.height - mobileInitialPosition.top - mobileInitialPosition.client > 2) {
    throw new Error(`mobile history did not open at the latest event: ${JSON.stringify(mobileInitialPosition)}`);
  }
  await mobileHistoryContext.close();

  const permissionContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const recovery = await configure(permissionContext, "permission");
  const permissionPage = await permissionContext.newPage();
  permissionPage.on("pageerror", (error) => errors.push(`permission page: ${error.message}`));
  await permissionPage.goto(url, { waitUntil: "domcontentloaded" });
  await permissionPage.getByText("Recover retained permission", { exact: true }).waitFor();
  const recoveryBefore = recovery.requests
    .filter((request) => request.searchParams.has("before"))
    .map((request) => request.searchParams.get("before"));
  if (![JSON.stringify(["202", "2"]), JSON.stringify(["202", "2", "1"])].includes(JSON.stringify(recoveryBefore))) {
    throw new Error(`permission recovery did not page to firstSequence: ${JSON.stringify(recoveryBefore)}`);
  }
  if (await permissionPage.getByText("No approval was inferred", { exact: false }).count()) {
    throw new Error("resolved-gap warning remained after permission reconstruction");
  }
  await permissionContext.close();

  const missingContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const missing = await configure(missingContext, "missing");
  const missingPage = await missingContext.newPage();
  await missingPage.goto(url, { waitUntil: "domcontentloaded" });
  await missingPage.getByText("No approval was inferred", { exact: false }).waitFor();
  const missingBefore = missing.requests
    .filter((request) => request.searchParams.has("before"))
    .map((request) => request.searchParams.get("before"));
  if (
    missingBefore.length < 2
    || missingBefore.length > 3
    || missingBefore[0] !== "202"
    || missingBefore.slice(1).some((before) => !["2", "1"].includes(before))
  ) {
    throw new Error(`missing permission recovery was not bounded: ${JSON.stringify(missingBefore)}`);
  }
  if (await missingPage.locator(".timeline-permission").count()) {
    throw new Error("missing permission was inferred from requires_action status");
  }
  await missingContext.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Bonsai timeline browser proof passed: latest-first desktop/mobile load, exact history anchor, retention bound, safe code copy, and old permission reconstruction");
} finally {
  await browser.close();
}
