import { expect, test, type Page, type Route } from "@playwright/test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type SessionStatus = "starting" | "working" | "idle" | "blocked" | "finished" | "stopping" | "stopped" | "crashed";

type TestSession = {
  id: string;
  runtimeId: string;
  workspaceId: string;
  name: string;
  branch: string | null;
  status: SessionStatus;
  pid: number | null;
  piSessionId: string | null;
  sessionFile: string | null;
  model: TestModel | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  usage: {
    userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number | null;
    contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
    updatedAt: string;
  } | null;
  autoCompactionEnabled: boolean | null;
  pendingMessageCount: number;
  compaction: { status: "idle" | "running" | "succeeded" | "failed"; reason: string | null; tokensBefore: number | null; estimatedTokensAfter: number | null; error: string | null; updatedAt: string | null };
  createdAt: string;
  lastActivityAt: string;
  events: unknown[];
  interactiveRequests: Array<{
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
    timeout?: number;
    receivedAt: string;
  }>;
  error: string | null;
};

type TestModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
};

const workspace = {
  id: "erp-deadbeef",
  name: "erp",
  root: "/home/jonas/coding/erp",
  trustProjectResources: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  sessionCount: 0,
  activeSessionCount: 0,
};

const models: TestModel[] = [
  { provider: "test", id: "gpt-5.4", name: "GPT-5.4", reasoning: true, thinkingLevels: ["off", "low", "medium", "high"] },
  { provider: "test", id: "gpt-5.6", name: "GPT-5.6", reasoning: false, thinkingLevels: ["off"] },
  { provider: "test", id: "gpt-5.9", name: "GPT-5.9", reasoning: true, thinkingLevels: ["off", "medium", "high"] },
  { provider: "test", id: "gpt-5.10", name: "GPT-5.10", reasoning: true, thinkingLevels: ["off", "medium", "high"] },
];

function sessionSummary(session: TestSession) {
  const { events, ...summary } = session;
  return { ...summary, eventCount: events.length };
}

async function installApi(page: Page, options: { readonly empty?: boolean; readonly emptyReview?: boolean; readonly notifications?: boolean } = {}) {
  let sessions: TestSession[] = [];
  const workspaces: Array<typeof workspace> = options.empty ? [] : [{ ...workspace }];
  const commands: Array<Record<string, unknown>> = [];
  const piCommands = [
    { name: "review", description: "Review the current changes", source: "extension", scope: null },
    { name: "fix-tests", description: "Fix failing tests", source: "prompt", scope: "project" },
    { name: "skill:web-search", description: "Search the web", source: "skill", scope: "user" },
  ];
  const mentionSearches: Array<{ readonly query: string; readonly runtimeId: string | null }> = [];
  const interactiveResponses: Array<Record<string, unknown>> = [];
  const notificationMutations: Array<Record<string, unknown>> = [];
  let failNextCommand = false;
  let delayNextCommand = false;
  let delayNextMentionSearch = false;
  let delayedSessionLoadId: string | undefined;
  let reviewRequests = 0;

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "POST" || method === "PATCH" ? request.postDataJSON() as Record<string, unknown> : undefined;

    if (path === "/api/notifications" && method === "GET") {
      await route.fulfill({ json: options.notifications ? { supported: true, vapidPublicKey: "AQ" } : { supported: false } });
      return;
    }
    if (path === "/api/notifications" && method === "POST") {
      notificationMutations.push(body ?? {});
      await route.fulfill({ json: { enabled: body?.action === "subscribe" } });
      return;
    }
    if (path === "/api/workspaces" && method === "GET") {
      await route.fulfill({ json: { workspaces: workspaces.map((item) => ({
        ...item,
        sessionCount: sessions.filter((session) => session.workspaceId === item.id).length,
        activeSessionCount: sessions.filter((session) => session.workspaceId === item.id && !["stopped", "crashed"].includes(session.status)).length,
      })) } });
      return;
    }
    if (path === "/api/workspaces" && method === "POST") {
      const name = typeof body?.name === "string" ? body.name : "new-project";
      const created = {
        id: `${name}-deadbeef`,
        name,
        root: typeof body?.path === "string" ? body.path : "/home/jonas/coding/new-project",
        trustProjectResources: body?.trustProjectResources === true,
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionCount: 0,
        activeSessionCount: 0,
      };
      workspaces.push(created);
      await route.fulfill({ status: 201, json: { workspace: created } });
      return;
    }
    const workspaceId = path.split("/")[3];
    const workspaceIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const matchedWorkspace = workspaces[workspaceIndex];
    if (matchedWorkspace && path === `/api/workspaces/${matchedWorkspace.id}` && method === "PATCH") {
      const renamed = { ...matchedWorkspace, name: typeof body?.name === "string" ? body.name : matchedWorkspace.name };
      workspaces[workspaceIndex] = renamed;
      await route.fulfill({ json: { workspace: renamed } });
      return;
    }
    if (matchedWorkspace && path === `/api/workspaces/${matchedWorkspace.id}` && method === "DELETE") {
      const sessionCount = sessions.filter((session) => session.workspaceId === matchedWorkspace.id).length;
      if (sessionCount > 0) await route.fulfill({ status: 409, json: { error: `Delete ${sessionCount} sessions before removing this workspace` } });
      else {
        workspaces.splice(workspaceIndex, 1);
        await route.fulfill({ json: { deleted: true } });
      }
      return;
    }
    if (path === "/api/directories" && method === "GET") {
      await route.fulfill({ json: { candidates: [{ path: "/home/jonas/coding/new-project", name: "new-project", root: "/home/jonas/coding", relativePath: "new-project" }] } });
      return;
    }
    if (path === "/api/sessions" && method === "GET") {
      await route.fulfill({ json: { sessions: sessions.map(sessionSummary) } });
      return;
    }
    if (path === "/api/sessions" && method === "POST") {
      const number = sessions.length + 1;
      const created: TestSession = {
        id: `session-${number}`,
        runtimeId: `runtime-${number}`,
        workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId : workspace.id,
        name: typeof body?.name === "string" ? body.name : "New session",
        branch: "feat/browser-test",
        status: "finished",
        pid: 1234 + number,
        piSessionId: `pi-session-${number}`,
        sessionFile: `/tmp/pi-session-${number}.jsonl`,
        model: models[0]!,
        thinkingLevel: "medium",
        usage: null,
        autoCompactionEnabled: true,
        pendingMessageCount: 0,
        compaction: { status: "idle", reason: null, tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: null },
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: new Date().toISOString(),
        events: [],
        interactiveRequests: [],
        error: null,
      };
      sessions = [...sessions, created];
      await route.fulfill({ status: 201, json: { session: created } });
      return;
    }
    const sessionId = path.split("/")[3];
    const sessionIndex = sessions.findIndex((session) => session.id === sessionId);
    const session = sessions[sessionIndex];
    if (session && path === `/api/sessions/${session.id}` && method === "GET") {
      if (delayedSessionLoadId === session.id) {
        delayedSessionLoadId = undefined;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.fulfill({ json: { session } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}` && method === "PATCH") {
      const renamed = { ...session, name: typeof body?.name === "string" ? body.name : session.name };
      sessions[sessionIndex] = renamed;
      await route.fulfill({ json: { session: renamed } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}` && method === "DELETE") {
      sessions.splice(sessionIndex, 1);
      await route.fulfill({ json: { deleted: true } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/mentions` && method === "GET") {
      mentionSearches.push({ query: url.searchParams.get("query") ?? "", runtimeId: url.searchParams.get("runtimeId") });
      if (delayNextMentionSearch) {
        delayNextMentionSearch = false;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await route.fulfill({ json: { mentions: [
        { path: "src/App.tsx", name: "App.tsx", kind: "file" },
        { path: "src/chat components/", name: "chat components", kind: "directory" },
      ] } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/review` && method === "GET") {
      reviewRequests += 1;
      if (options.emptyReview) {
        await route.fulfill({ json: { review: { generatedAt: Date.now(), totalFiles: 0, truncated: false, files: [] } } });
        return;
      }
      await route.fulfill({ json: { review: {
        generatedAt: Date.now(),
        totalFiles: 2,
        truncated: false,
        files: [
          { path: "web/src/App.tsx", indexStatus: " ", worktreeStatus: "M", patch: "diff --git a/web/src/App.tsx b/web/src/App.tsx\n--- a/web/src/App.tsx\n+++ b/web/src/App.tsx\n@@ -1,2 +1,2 @@\n-old line\n+new line", truncated: false, binary: false },
          { path: "docs/review-notes.md", indexStatus: "?", worktreeStatus: "?", patch: "diff --git a/docs/review-notes.md b/docs/review-notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/review-notes.md\n@@ -0,0 +1 @@\n+Review notes", truncated: false, binary: false },
        ],
      } } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/stats` && method === "GET") {
      const withUsage = { ...session, usage: {
        userMessages: 3, assistantMessages: 3, toolCalls: 4, toolResults: 4, totalMessages: 14,
        tokens: { input: 1200, output: 345, cacheRead: 800, cacheWrite: 100, total: 2445 },
        cost: 0.42,
        contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 },
        updatedAt: new Date().toISOString(),
      } };
      sessions[sessionIndex] = withUsage;
      await route.fulfill({ json: { session: withUsage } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/models` && method === "GET") {
      await route.fulfill({ json: { models } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/configuration` && method === "POST") {
      let configured = body?.action === "setModel"
        ? { ...session, model: models.find((model) => model.provider === body.provider && model.id === body.modelId) ?? session.model, thinkingLevel: body.modelId === "gpt-5.6" ? "off" as const : session.thinkingLevel }
        : body?.action === "setThinkingLevel" && typeof body.level === "string"
          ? { ...session, thinkingLevel: body.level as TestSession["thinkingLevel"] }
          : body?.action === "setAutoCompaction" && typeof body.enabled === "boolean"
            ? { ...session, autoCompactionEnabled: body.enabled }
            : session;
      if (body?.action === "compact") {
        configured = { ...session, compaction: { status: "running" as const, reason: "manual", tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: new Date().toISOString() } };
        sessions[sessionIndex] = configured;
        await new Promise((resolve) => setTimeout(resolve, 1_800));
        configured = { ...configured, usage: configured.usage ? { ...configured.usage, contextUsage: configured.usage.contextUsage ? { ...configured.usage.contextUsage, tokens: null, percent: null } : null } : null, compaction: { status: "succeeded" as const, reason: "manual", tokensBefore: 42000, estimatedTokensAfter: 12000, error: null, updatedAt: new Date().toISOString() } };
      }
      sessions[sessionIndex] = configured;
      await route.fulfill({ json: { session: configured } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/interactive` && method === "POST") {
      const pending = session.interactiveRequests[0];
      if (body?.runtimeId !== session.runtimeId || body?.requestId !== pending?.id) {
        await route.fulfill({ status: 409, json: { error: "stale interactive request" } });
      } else {
        interactiveResponses.push({ ...body, sessionId: session.id });
        const remaining = session.interactiveRequests.slice(1);
        const answered = { ...session, status: remaining.length > 0 ? "blocked" as const : "working" as const, interactiveRequests: remaining, lastActivityAt: new Date().toISOString() };
        sessions[sessionIndex] = answered;
        await route.fulfill({ json: { session: answered } });
      }
      return;
    }
    if (session && path === `/api/sessions/${session.id}/acknowledge` && method === "POST") {
      if (body?.runtimeId !== session.runtimeId) {
        await route.fulfill({ status: 409, json: { error: "stale runtime" } });
      } else {
        const acknowledged = { ...session, status: session.status === "finished" ? "idle" as const : session.status, lastActivityAt: new Date().toISOString() };
        sessions[sessionIndex] = acknowledged;
        await route.fulfill({ json: { session: acknowledged } });
      }
      return;
    }
    if (session && path === `/api/sessions/${session.id}/resume` && method === "POST") {
      if (body?.runtimeId !== session.runtimeId) {
        await route.fulfill({ status: 409, json: { error: "stale runtime" } });
      } else {
        const resumed = { ...session, runtimeId: `${session.runtimeId}-resumed`, status: "finished" as const, pid: 2234, error: null, lastActivityAt: new Date().toISOString() };
        sessions[sessionIndex] = resumed;
        await route.fulfill({ json: { session: resumed } });
      }
      return;
    }
    if (session && path === `/api/sessions/${session.id}/commands` && method === "GET") {
      await route.fulfill({ json: { commands: piCommands } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}/commands` && method === "POST") {
      commands.push({ ...body, sessionId: session.id });
      if (body?.action === "stop") sessions[sessionIndex] = { ...session, status: "stopped", lastActivityAt: new Date().toISOString() };
      if (delayNextCommand) {
        delayNextCommand = false;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (failNextCommand) {
        failNextCommand = false;
        await route.fulfill({ status: 409, json: { error: "simulated failure" } });
      } else {
        await route.fulfill({ status: 202, json: { accepted: true } });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${path}` } });
  });

  return {
    commands,
    mentionSearches,
    interactiveResponses,
    notificationMutations,
    setStatus(status: SessionStatus) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, status, lastActivityAt: new Date().toISOString() };
    },
    setInteractiveRequests(requests: TestSession["interactiveRequests"]) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, status: requests.length > 0 ? "blocked" : "working", interactiveRequests: requests, lastActivityAt: new Date().toISOString() };
    },
    setEvents(events: unknown[]) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, events, lastActivityAt: new Date().toISOString() };
    },
    failNextCommand() {
      failNextCommand = true;
    },
    delayAndFailNextCommand() {
      delayNextCommand = true;
      failNextCommand = true;
    },
    delayNextMentionSearch() {
      delayNextMentionSearch = true;
    },
    delaySessionLoad(name: string) {
      delayedSessionLoadId = sessions.find((session) => session.name === name)?.id;
    },
    reviewRequestCount() {
      return reviewRequests;
    },
  };
}

test("empty first-run mobile state exposes workspace creation directly", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page, { empty: true });
  await page.goto("/");

  await expect(page.locator(".brand b")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No workspaces" })).toBeVisible();
  const createWorkspace = page.getByRole("button", { name: "CREATE WORKSPACE" });
  await createWorkspace.click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeHidden();
  await expect(createWorkspace).toBeFocused();
});

test("long workspace paths keep their final directories visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto("/");
  const root = "/home/jonas/coding/worktrees/sirkusagio/deeply-nested/visible-tail";
  await page.evaluate(async ({ root }) => {
    await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tail-project", path: root, trustProjectResources: true }),
    });
  }, { root });
  await page.reload();
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();

  const path = page.getByRole("button", { name: /tail-project.*visible-tail/i }).locator(".workspace-path");
  await expect(path).toHaveText(root);
  await expect(path).toHaveAttribute("title", root);
  const clipping = await path.evaluate((element) => {
    const text = element.querySelector("span")!.firstChild!;
    const bounds = element.getBoundingClientRect();
    const segmentBounds = (start: number, end: number) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      return range.getBoundingClientRect();
    };
    const beginning = segmentBounds(0, "/home".length);
    const tailStart = text.textContent!.lastIndexOf("visible-tail");
    const tail = segmentBounds(tailStart, text.textContent!.length);
    const intersects = (segment: DOMRect) => segment.right > bounds.left && segment.left < bounds.right;
    return {
      overflows: element.scrollWidth > element.clientWidth,
      beginningVisible: intersects(beginning),
      tailVisible: intersects(tail),
      containerDirection: getComputedStyle(element).direction,
      textDirection: getComputedStyle(element.querySelector("span")!).direction,
    };
  });
  expect(clipping).toEqual({
    overflows: true,
    beginningVisible: false,
    tailVisible: true,
    containerDirection: "rtl",
    textDirection: "ltr",
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail")).toHaveAttribute("data-closed", "");
  await expect(page.getByRole("button", { name: "Open workspaces and sessions" })).toBeFocused();
});

test("global picker fuzzily finds and opens sessions across workspaces", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  await installApi(page);
  await page.goto("/");

  await page.evaluate(async () => {
    const paymentResponse = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "payments", path: "/home/jonas/coding/payments", trustProjectResources: true }),
    });
    const payment = await paymentResponse.json();
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Authentication refactor" }),
    });
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: payment.workspace.id, name: "Invoice migration" }),
    });
  });
  await page.reload();
  await expect(page.getByLabel("Message Pi")).toBeVisible();

  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press("Meta+k");
  const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
  const search = picker.getByLabel("Search sessions");
  const options = picker.getByRole("option");
  await expect(picker).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(options.first()).toHaveCSS("background-color", "rgb(231, 240, 234)");
  await page.keyboard.press("Control+n");
  await expect(options.nth(1)).toHaveCSS("background-color", "rgb(231, 240, 234)");
  await page.keyboard.press("Control+p");
  await expect(options.first()).toHaveCSS("background-color", "rgb(231, 240, 234)");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveCSS("background-color", "rgb(231, 240, 234)");
  await page.keyboard.press("ArrowUp");
  await expect(options.first()).toHaveCSS("background-color", "rgb(231, 240, 234)");
  await search.fill("pay inv");
  await expect(picker.getByRole("option", { name: /Invoice migration.*payments/i })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Authentication refactor/i })).toHaveCount(0);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/session=session-2/);
  await expect(page.locator(".brand b")).toHaveText("Invoice migration");
  await expect(picker).toBeHidden();

  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press("Meta+k");
  await expect(search).toBeFocused();
  await search.fill("auth feat");
  await expect(picker.getByRole("option", { name: /Authentication refactor.*feat\/browser-test/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(page.getByLabel("Message Pi")).toBeFocused();

  const pickerTrigger = page.getByRole("button", { name: "Search sessions" });
  await pickerTrigger.click();
  await expect(picker.getByRole("option")).toHaveCount(2);
  await page.mouse.click(2, 2);
  await expect(picker).toBeHidden();
  await expect(pickerTrigger).toBeFocused();
});

test("slash picker discovers and runs commands through the owned Pi runtime", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  const api = await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New session in erp" }).click();
  const createDialog = page.getByRole("dialog", { name: "New session" });
  await createDialog.getByLabel("Session name").fill("Command session");
  await createDialog.getByRole("button", { name: /start session/i }).click();

  await page.setViewportSize({ width: 390, height: 520 });
  const composer = page.getByLabel("Message Pi");
  await composer.fill("/");
  const commandDialog = page.getByRole("dialog", { name: "Pi commands" });
  const commandSearch = commandDialog.getByLabel("Filter Pi commands");
  const commandList = commandDialog.getByRole("listbox", { name: "Pi commands" });
  await expect(commandDialog).toBeVisible();
  await expect(commandSearch).toBeFocused();
  await expect(commandList.getByRole("option")).toHaveCount(9);
  await expect(commandList.getByRole("option", { name: /resume.*built-in/i })).toBeVisible();
  await expect(commandList.getByRole("option", { name: /review.*extension/i })).toBeVisible();

  await commandSearch.press("Backspace");
  await expect(commandDialog).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");

  await composer.fill("/");
  await expect(commandDialog).toBeVisible();
  await expect(commandSearch).toBeFocused();
  await expect(commandList.getByRole("option")).toHaveCount(9);
  const commandLayout = await commandDialog.evaluate((dialog) => {
    const first = dialog.querySelector<HTMLElement>("[role=option]")!.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, firstTop: first.top, firstBottom: first.bottom };
  });
  expect(commandLayout.top).toBeGreaterThanOrEqual(0);
  expect(commandLayout.bottom).toBeLessThanOrEqual(521);
  expect(commandLayout.firstTop).toBeGreaterThanOrEqual(commandLayout.top);
  expect(commandLayout.firstBottom).toBeLessThanOrEqual(commandLayout.bottom);

  await commandSearch.fill("resume");
  await expect(commandList.getByRole("option", { name: /resume.*built-in/i })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/resume ");
  await page.getByRole("button", { name: "Run Pi command" }).click();
  const sessionPicker = page.getByRole("dialog", { name: "Sessions", exact: true });
  await expect(sessionPicker).toBeVisible();
  const mobilePickerChrome = await sessionPicker.evaluate((picker) => {
    const header = picker.querySelector<HTMLElement>(":scope > header")!;
    const footer = picker.querySelector<HTMLElement>(":scope > footer")!;
    const search = picker.querySelector<HTMLElement>(".global-picker-search")!;
    return {
      headerHeight: header.getBoundingClientRect().height,
      searchHeight: search.getBoundingClientRect().height,
      footerDisplay: getComputedStyle(footer).display,
    };
  });
  expect(mobilePickerChrome.headerHeight).toBeLessThanOrEqual(43);
  expect(mobilePickerChrome.searchHeight).toBeLessThanOrEqual(44);
  expect(mobilePickerChrome.footerDisplay).toBe("none");
  expect(api.commands).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(sessionPicker).toBeHidden();
  await expect(composer).toHaveValue("");

  await composer.fill("/");
  await expect(commandDialog).toBeVisible();
  await commandSearch.fill("fix");
  await expect(commandList.getByRole("option", { name: /fix-tests.*prompt.*project/i })).toBeVisible();
  await expect(commandList.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/fix-tests ");
  await expect(commandList).toHaveCount(0);
  await composer.fill("/fix-tests unit");
  await page.getByRole("button", { name: "Run Pi command" }).click();
  await expect.poll(() => api.commands.at(-1)?.text).toBe("/fix-tests unit");
  await expect.poll(() => api.commands.at(-1)?.action).toBe("prompt");

  api.setStatus("working");
  await expect(page.getByRole("button", { name: "FOLLOW-UP" })).toBeVisible({ timeout: 5_000 });
  await composer.fill("/review");
  await expect(commandList.getByRole("option", { name: /review/i })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Run Pi command" }).click();
  await expect.poll(() => api.commands.at(-1)?.text).toBe("/review");
  await expect.poll(() => api.commands.at(-1)?.action).toBe("prompt");
});

test("workspace creation stays stable and defaults project trust on", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Trust project-local Pi resources/)).toBeChecked();

  const results = dialog.locator(".directory-results");
  const initialHeight = await results.evaluate((element) => element.getBoundingClientRect().height);
  await dialog.getByRole("textbox", { name: "Directory", exact: true }).fill("new-project");
  await dialog.getByRole("button", { name: /new-project/ }).click();
  const selectedHeight = await results.evaluate((element) => element.getBoundingClientRect().height);
  expect(selectedHeight).toBe(initialHeight);
  await expect(dialog.getByLabel("Workspace name")).toHaveValue("new-project");
  await dialog.getByRole("button", { name: /create workspace/i }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".rail")).toHaveClass(/mobile-open/);
  await expect(page.getByRole("button", { name: /new-project.*home\/jonas\/coding\/new-project/i })).toBeVisible();

  const workspaceSettings = page.getByRole("button", { name: "Workspace settings for new-project" });
  await page.setViewportSize({ width: 390, height: 360 });
  await workspaceSettings.scrollIntoViewIfNeeded();
  await workspaceSettings.click();
  const settingsMenu = page.getByRole("menu", { name: "new-project workspace settings" });
  const renameItem = settingsMenu.getByRole("menuitem", { name: "RENAME" });
  const removeItem = settingsMenu.getByRole("menuitem", { name: "REMOVE" });
  await expect(settingsMenu).toBeVisible();
  const menuBounds = await settingsMenu.evaluate((element) => {
    const menu = element.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>(".workspace-list")!.getBoundingClientRect();
    return { menuTop: menu.top, menuBottom: menu.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
  });
  expect(menuBounds.menuTop).toBeGreaterThanOrEqual(menuBounds.viewportTop - 1);
  expect(menuBounds.menuBottom).toBeLessThanOrEqual(menuBounds.viewportBottom + 1);
  await page.keyboard.press("ArrowDown");
  await expect(renameItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(removeItem).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settingsMenu).toBeHidden();
  await expect(page.getByRole("button", { name: "New session in new-project" })).toBeFocused();
  await workspaceSettings.click();
  await settingsMenu.getByRole("menuitem", { name: "RENAME" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename workspace" });
  await renameDialog.getByLabel("Workspace name").fill("renamed-project");
  await renameDialog.getByRole("button", { name: "SAVE" }).click();
  await expect(renameDialog).toBeHidden();
  await expect(page.getByRole("button", { name: /renamed-project.*home\/jonas\/coding\/new-project/i })).toBeVisible();

  await page.getByRole("button", { name: "Workspace settings for renamed-project" }).click();
  await page.getByRole("menuitem", { name: "REMOVE" }).click();
  const removeDialog = page.getByRole("alertdialog", { name: "Remove workspace?" });
  await expect(removeDialog).toContainText("directory and files will remain untouched");
  await removeDialog.getByRole("button", { name: "REMOVE WORKSPACE" }).click();
  await expect(removeDialog).toBeHidden();
  await expect(page.getByRole("button", { name: /renamed-project.*home\/jonas\/coding\/new-project/i })).toHaveCount(0);
  await expect(page.locator(".brand")).toBeFocused();
});

test("session menus stay above neighboring controls and flip away from the sidebar edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto("/");

  await page.evaluate(async () => {
    const createWorkspace = (name: string) => fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path: `/home/jonas/coding/${name}`, trustProjectResources: true }),
    }).then((response) => response.json());
    const target = await createWorkspace("target-project");
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: target.workspace.id, name: "Edge session" }),
    });
    await createWorkspace("neighbor-project");
  });
  await page.reload();
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();

  const sessionSettings = page.getByRole("button", { name: "Session settings for Edge session" });
  const neighboringSettings = page.getByRole("button", { name: "Workspace settings for neighbor-project" });
  await sessionSettings.click();
  const menu = page.getByRole("menu", { name: "Edge session session settings" });
  await expect(menu).toBeVisible();
  const overlap = await menu.evaluate((element, neighboringLabel) => {
    const menuBounds = element.getBoundingClientRect();
    const neighbor = document.querySelector<HTMLElement>(`[aria-label="${neighboringLabel}"]`)!;
    const neighborBounds = neighbor.getBoundingClientRect();
    const left = Math.max(menuBounds.left, neighborBounds.left);
    const right = Math.min(menuBounds.right, neighborBounds.right);
    const top = Math.max(menuBounds.top, neighborBounds.top);
    const bottom = Math.min(menuBounds.bottom, neighborBounds.bottom);
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    return {
      width: right - left,
      height: bottom - top,
      menuOwnsTopLayer: element.contains(document.elementFromPoint(point.x, point.y)),
    };
  }, "Workspace settings for neighbor-project");
  expect(overlap.width).toBeGreaterThan(0);
  expect(overlap.height).toBeGreaterThan(0);
  expect(overlap.menuOwnsTopLayer).toBe(true);

  await page.setViewportSize({ width: 390, height: 360 });
  await sessionSettings.scrollIntoViewIfNeeded();
  const edgeBounds = await menu.evaluate((element) => {
    const menuBounds = element.getBoundingClientRect();
    const triggerBounds = document.querySelector<HTMLElement>("[aria-label='Session settings for Edge session']")!.getBoundingClientRect();
    const viewportBounds = document.querySelector<HTMLElement>(".workspace-list")!.getBoundingClientRect();
    return {
      menuTop: menuBounds.top,
      menuBottom: menuBounds.bottom,
      triggerTop: triggerBounds.top,
      viewportTop: viewportBounds.top,
      viewportBottom: viewportBounds.bottom,
    };
  });
  expect(edgeBounds.menuTop).toBeLessThan(edgeBounds.triggerTop);
  expect(edgeBounds.menuTop).toBeGreaterThanOrEqual(edgeBounds.viewportTop);
  expect(edgeBounds.menuBottom).toBeLessThanOrEqual(edgeBounds.viewportBottom);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(sessionSettings).toBeFocused();
});

test("selecting a session shows loading feedback while its details load", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const api = await installApi(page);
  await page.goto("/");

  const createSession = async (name: string) => {
    await page.getByRole("button", { name: "New session in erp" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await dialog.getByLabel("Session name").fill(name);
    await dialog.getByRole("button", { name: /start session/i }).click();
  };
  await createSession("First session");
  await createSession("Second session");

  api.delaySessionLoad("First session");
  await page.getByRole("button", { name: /First session.*finished/i }).click();
  const loading = page.locator(".session-loading");
  await expect(loading.getByRole("heading", { name: "Loading session" })).toBeVisible();
  await expect(loading).toContainText("Opening First session");
  await expect(page.getByRole("heading", { name: "No session selected" })).toHaveCount(0);
  await expect(page.locator(".brand b")).toHaveText("First session");
  await expect(loading).toHaveCount(0);
});

test("idle sessions can change their reasoning level", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const api = await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New session in erp" }).click();
  const createDialog = page.getByRole("dialog", { name: "New session" });
  await createDialog.getByLabel("Session name").fill("Reasoning controls");
  await createDialog.getByRole("button", { name: /start session/i }).click();
  api.setStatus("idle");
  await expect(page.locator(".runtime-state")).toContainText(/idle/i, { timeout: 5_000 });

  await page.getByRole("button", { name: "MODEL" }).click();
  const modelDialog = page.getByRole("dialog", { name: "Model & thinking" });
  const high = modelDialog.getByRole("button", { name: "high" });
  await high.click();
  await expect(high).toHaveAttribute("aria-pressed", "true");
});

test("mobile shell keeps bottom controls inside the visible viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  await expect(page.locator(".control-meta")).toBeVisible();

  const viewportLayout = () => page.evaluate(() => {
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    const shell = document.querySelector<HTMLElement>(".shell")!.getBoundingClientRect();
    const workspace = document.querySelector<HTMLElement>(".workspace")!.getBoundingClientRect();
    const deck = document.querySelector<HTMLElement>(".control-deck")!.getBoundingClientRect();
    const controls = document.querySelector<HTMLElement>(".control-meta")!.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
    const masthead = document.querySelector<HTMLElement>(".masthead")!.getBoundingClientRect();
    const tabs = document.querySelector<HTMLElement>(".capability-tabs")!.getBoundingClientRect();
    const timeline = document.querySelector<HTMLElement>(".timeline-wrap")!.getBoundingClientRect();
    const details = document.querySelector<HTMLElement>(".session-details-toggle")!.getBoundingClientRect();
    return {
      configuredHeight: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")),
      visibleHeight,
      shellBottom: shell.bottom,
      workspaceBottom: workspace.bottom,
      deckBottom: deck.bottom,
      controlsBottom: controls.bottom,
      controlsHeight: controls.height,
      composerBottom: composer.bottom,
      composerHeight: composer.height,
      detailsHeight: details.height,
      mastheadHeight: masthead.height,
      tabsHeight: tabs.height,
      timelineHeight: timeline.height,
    };
  });
  await expect.poll(viewportLayout).toMatchObject({ visibleHeight: 700, configuredHeight: 700 });
  let layout = await viewportLayout();
  expect(layout.shellBottom).toBeLessThanOrEqual(layout.visibleHeight + 1);
  expect(layout.workspaceBottom).toBeGreaterThanOrEqual(layout.visibleHeight - 1);
  expect(layout.deckBottom).toBeGreaterThanOrEqual(layout.visibleHeight - 1);
  expect(layout.controlsBottom).toBeLessThanOrEqual(layout.visibleHeight + 1);
  expect(layout.composerBottom).toBeLessThan(layout.controlsBottom);
  expect(layout.mastheadHeight).toBeLessThanOrEqual(52);
  expect(layout.tabsHeight).toBeLessThanOrEqual(44);
  expect(layout.composerHeight).toBeLessThanOrEqual(104);

  await page.setViewportSize({ width: 390, height: 520 });
  await expect.poll(viewportLayout).toMatchObject({ visibleHeight: 520, configuredHeight: 520 });
  layout = await viewportLayout();
  expect(layout.shellBottom).toBeLessThanOrEqual(layout.visibleHeight + 1);
  expect(layout.workspaceBottom).toBeGreaterThanOrEqual(layout.visibleHeight - 1);
  expect(layout.deckBottom).toBeGreaterThanOrEqual(layout.visibleHeight - 1);
  expect(layout.controlsBottom).toBeLessThanOrEqual(layout.visibleHeight + 1);

  const restingTimelineHeight = layout.timelineHeight;
  await page.getByLabel("Message Pi").focus();
  await expect.poll(viewportLayout).toMatchObject({ mastheadHeight: 0, tabsHeight: 0, detailsHeight: 0 });
  layout = await viewportLayout();
  expect(layout.controlsHeight).toBeGreaterThanOrEqual(40);
  expect(layout.timelineHeight).toBeGreaterThan(restingTimelineHeight + 100);

  await page.getByLabel("Message Pi").fill("Maybe we should be trying to be better with the space for the chat interface as well, quite little space on mobile for the actual messages");
  layout = await viewportLayout();
  expect(layout.composerHeight).toBeLessThanOrEqual(178);
  expect(layout.timelineHeight).toBeGreaterThanOrEqual(280);
});

test("mobile session tabs omit events and hide an empty review count", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page, { emptyReview: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const tabs = page.locator(".capability-tabs").getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.filter({ hasText: "Events" })).toHaveCount(0);
  const changes = tabs.filter({ hasText: "Changes" });
  await changes.click();
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toContainText("Working tree is clean");
  await expect(changes.locator("em")).toHaveCount(0);
});

test("mobile workbench keeps creation, models, queues, and navigation functional", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  const workspaceToggle = page.getByRole("button", { name: /erp.*home\/jonas\/coding\/erp/i });
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "true");
  const createWorkspaceButton = page.getByRole("button", { name: "Create workspace" });
  const createSessionButton = page.getByRole("button", { name: "New session in erp" });
  const plusLayout = await page.locator(".rail").evaluate((rail) => {
    const railBox = rail.getBoundingClientRect();
    const workspaceButton = rail.querySelector<HTMLElement>(".add-workspace")!;
    const workspacePlus = workspaceButton.getBoundingClientRect();
    const sessionPlus = rail.querySelector(".add-session")!.getBoundingClientRect();
    return {
      workspaceRight: workspacePlus.right,
      sessionRight: sessionPlus.right,
      workspaceSize: workspacePlus.width,
      workspaceTopGap: workspacePlus.top - railBox.top,
      plusFontSize: getComputedStyle(workspaceButton).fontSize,
    };
  });
  expect(Math.abs(plusLayout.workspaceRight - plusLayout.sessionRight)).toBeLessThanOrEqual(1);
  expect(plusLayout.workspaceSize).toBe(34);
  expect(plusLayout.workspaceTopGap).toBeGreaterThanOrEqual(12);
  expect(plusLayout.plusFontSize).toBe("17px");
  await expect(createSessionButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await createSessionButton.click();

  const createDialog = page.getByRole("dialog", { name: "New session" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByText(/initial instruction/i)).toHaveCount(0);
  await createDialog.getByLabel("Session name").fill("Utility session");
  await createDialog.getByRole("button", { name: /start session/i }).click();

  await expect(createDialog).toBeHidden();
  await expect(page.locator(".rail")).toBeHidden();
  await expect(page.locator(".brand b")).toHaveText("Utility session");
  const mobileChanges = page.locator(".capability-tabs").getByRole("tab", { name: /Changes/ });
  await expect(mobileChanges).toBeVisible();
  await mobileChanges.click();
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toBeVisible();
  await expect(page.getByText("App.tsx", { exact: true })).toBeVisible();
  await page.locator(".capability-tabs").getByRole("tab", { name: /Agent/ }).click();
  await expect(page.getByRole("button", { name: /Files/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await createSessionButton.click();
  await expect(createDialog.getByText(/1 other writable session is already using this checkout/)).toBeVisible();
  await expect(createDialog.getByText("SHARED CHECKOUT")).toHaveCount(0);
  await createDialog.getByRole("button", { name: "Close" }).click();

  await page.getByLabel("Attach images").setInputFiles({
    name: "screen.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  await expect(page.locator(".composer-images img")).toHaveCount(1);
  await page.getByLabel("Message Pi").fill("Inspect this screen");
  await page.locator(".send-button").click();
  await expect.poll(() => (api.commands.at(-1)?.images as Array<Record<string, unknown>> | undefined)?.[0]?.mediaType).toBe("image/png");
  await expect(page.locator(".composer-images")).toHaveCount(0);

  await page.getByLabel("Message Pi").fill("Undo @");
  const emptyMentionPicker = page.getByRole("dialog", { name: "Mention a file" });
  const emptyMentionSearch = emptyMentionPicker.getByLabel("Search workspace files");
  await expect(emptyMentionSearch).toHaveValue("");
  await emptyMentionSearch.press("Backspace");
  await expect(emptyMentionPicker).toHaveCount(0);
  await expect(page.getByLabel("Message Pi")).toHaveValue("Undo ");
  await expect(page.getByLabel("Message Pi")).toBeFocused();

  await page.getByLabel("Message Pi").fill("Close @");
  await page.getByRole("button", { name: "Close file mentions" }).click();
  await page.getByLabel("Message Pi").press("Backspace");
  await expect(page.getByLabel("Message Pi")).toHaveValue("Close ");
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toHaveCount(0);

  await page.getByLabel("Message Pi").fill("Review @app");
  const mentionPicker = page.getByRole("dialog", { name: "Mention a file" });
  await expect(mentionPicker).toBeVisible();
  await expect(mentionPicker.getByLabel("Search workspace files")).toHaveValue("app");
  await expect(mentionPicker.getByRole("option", { name: /App\.tsx/ })).toBeVisible();
  await expect.poll(() => api.mentionSearches.at(-1)).toEqual({ query: "app", runtimeId: "runtime-1" });
  await mentionPicker.getByLabel("Search workspace files").fill("chat components");
  await expect(page.getByLabel("Message Pi")).toHaveValue("Review @app");
  await expect.poll(() => api.mentionSearches.at(-1)?.query).toBe("chat components");
  await expect(mentionPicker.getByRole("option", { name: /chat components/ })).toBeVisible();
  await mentionPicker.getByLabel("Search workspace files").fill("ap");
  await mentionPicker.getByLabel("Search workspace files").fill("app");
  await expect(page.getByLabel("Message Pi")).toHaveValue("Review @app");
  await expect(mentionPicker.getByRole("option", { name: /App\.tsx/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Message Pi")).toHaveValue("Review @src/App.tsx");
  await expect(mentionPicker).toHaveCount(0);
  await page.locator(".send-button").click();
  await expect.poll(() => api.commands.at(-1)?.text).toBe("Review @src/App.tsx");

  api.delayNextMentionSearch();
  await page.getByLabel("Message Pi").fill("Race @late");
  await expect.poll(() => api.mentionSearches.at(-1)?.query).toBe("late");
  await page.getByRole("button", { name: "Close file mentions" }).click();
  await page.locator(".send-button").click();
  await expect.poll(() => api.commands.at(-1)?.text).toBe("Race @late");
  await page.waitForTimeout(400);
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toHaveCount(0);

  api.delayNextMentionSearch();
  await page.getByLabel("Message Pi").fill("Dismiss @escape");
  await expect.poll(() => api.mentionSearches.at(-1)?.query).toBe("escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toHaveCount(0);

  await page.getByLabel("Message Pi").fill("Rotate @app");
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toBeVisible();
  await page.setViewportSize({ width: 761, height: 658 });
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toHaveCount(0);
  await expect(page.getByLabel("Message Pi")).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Workspace files" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message Pi").fill("");

  await page.setViewportSize({ width: 360, height: 658 });
  await page.getByRole("button", { name: "MODEL" }).click();
  const modelDialog = page.getByRole("dialog", { name: "Model & thinking" });
  await expect(modelDialog).toBeVisible();
  await expect(modelDialog.locator(".model-option b")).toHaveText(["GPT-5.10", "GPT-5.9", "GPT-5.6", "GPT-5.4"]);
  const modelSections = await modelDialog.evaluate((element) => {
    const current = element.querySelector(".model-current")!.getBoundingClientRect();
    const catalog = element.querySelector(".model-catalog")!.getBoundingClientRect();
    return { currentBottom: current.bottom, catalogTop: catalog.top };
  });
  expect(modelSections.currentBottom).toBeLessThanOrEqual(modelSections.catalogTop + 1);
  await modelDialog.getByRole("button", { name: "high" }).click();
  await expect(modelDialog.getByRole("button", { name: "high" })).toHaveAttribute("aria-pressed", "true");
  await modelDialog.getByRole("option", { name: /GPT-5.6/ }).click();
  await expect(modelDialog.locator(".model-current > b")).toHaveText("GPT-5.6");
  await expect(modelDialog.getByRole("button", { name: "off" })).toHaveAttribute("aria-pressed", "true");
  await modelDialog.getByRole("button", { name: "DONE" }).click();

  api.setStatus("working");
  await expect(page.getByRole("button", { name: "FOLLOW-UP" })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "FOLLOW-UP" }).click();
  await page.getByLabel("Message Pi").fill("queue after completion");
  await page.locator(".send-button").click();
  await expect.poll(() => api.commands.at(-1)?.action).toBe("followUp");

  await page.getByRole("button", { name: "STEER NEXT" }).click();
  await page.getByLabel("Message Pi").fill("steer at next boundary");
  await page.locator(".send-button").click();
  await expect.poll(() => api.commands.at(-1)?.action).toBe("steer");
  await page.getByRole("button", { name: "ABORT RUN" }).click();
  await expect.poll(() => api.commands.at(-1)?.action).toBe("abort");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await workspaceToggle.click();
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Utility session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New session in erp" })).toBeEnabled();
  await page.getByRole("button", { name: "Workspace settings for erp" }).click();
  await page.getByRole("menuitem", { name: "REMOVE" }).click();
  const blockedRemoval = page.getByRole("alertdialog", { name: "Remove workspace?" });
  await expect(blockedRemoval).toContainText("Delete 1 session first");
  await expect(blockedRemoval.getByRole("button", { name: "REMOVE WORKSPACE" })).toBeDisabled();
  await blockedRemoval.getByRole("button", { name: "CANCEL" }).click();

  expect(await page.locator(".composer").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("8px");
  await expect(page.locator(".composer-insertions svg")).toHaveCount(2);
  expect(await page.locator(".attachment-trigger").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("50%");
  expect(await page.locator(".mention-trigger").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("50%");
  expect(await page.locator(".send-button").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("50%");
});

test("sessions can be renamed from the mobile drawer and stay renamed after reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  const createDialog = page.getByRole("dialog", { name: "New session" });
  await createDialog.getByLabel("Session name").fill("Before rename");
  await createDialog.getByRole("button", { name: /start session/i }).click();
  await expect(page.locator(".brand b")).toHaveText("Before rename");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "Session settings for Before rename" }).click();
  await page.getByRole("menuitem", { name: "RENAME" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename session" });
  await renameDialog.getByLabel("Session name").fill("Release guardian");
  await renameDialog.getByRole("button", { name: "SAVE" }).click();

  await expect(renameDialog).toBeHidden();
  await expect(page.locator(".brand b")).toHaveText("Release guardian");
  await expect(page.getByRole("button", { name: /Release guardian.*FINISHED/i })).toBeVisible();

  await page.reload();
  await expect(page.locator(".brand b")).toHaveText("Release guardian");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await expect(page.getByRole("button", { name: "Session settings for Release guardian" })).toBeVisible();
});

test("session drafts and delayed command failures stay scoped to their session", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const api = await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New session in erp" }).click();
  let dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByLabel("Name").fill("First");
  await dialog.getByRole("button", { name: /start session/i }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByLabel("Name").fill("Second");
  await dialog.getByRole("button", { name: /start session/i }).click();

  await page.getByLabel("Message Pi").fill("draft for second");
  await page.getByRole("button", { name: /First.*finished/i }).click();
  api.delayAndFailNextCommand();
  await page.getByLabel("Message Pi").fill("command from first");
  await page.locator(".send-button").click();
  await page.getByRole("button", { name: /Second.*finished/i }).click();
  await expect(page.getByLabel("Message Pi")).toHaveValue("draft for second");
  await page.waitForTimeout(650);
  await expect(page.locator(".operation-error")).toHaveCount(0);

  await page.getByRole("button", { name: /First.*idle/i }).click();
  await expect(page.locator(".operation-error")).toContainText("simulated failure");
  await expect(page.locator(".outbox-message")).toContainText("command from first");

  const firstSettings = page.getByRole("button", { name: "Session settings for First" });
  await firstSettings.click();
  await page.getByRole("menuitem", { name: "ARCHIVE" }).click();
  const archiveDialog = page.getByRole("alertdialog", { name: "Archive session?" });
  await expect(archiveDialog).toContainText("will stop running and be removed from PISS");
  await archiveDialog.getByRole("button", { name: "ARCHIVE SESSION" }).click();
  await expect(firstSettings).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("piss:draft:session-1"))).toBeNull();
  await expect(page.locator(".brand b")).toHaveText("Second");
  await expect(page.getByLabel("Message Pi")).toHaveValue("draft for second");
  await expect(page.locator(".operation-error")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".brand b")).toHaveText("Second");
  await expect(page.getByLabel("Message Pi")).toHaveValue("draft for second");
});

test("timeline follows growing content until the user scrolls up", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const api = await installApi(page);
  await page.route("**/delayed-timeline-image.svg", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="500"><rect width="20" height="500" fill="#dfe8df"/></svg>',
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const timestamp = new Date().toISOString();
  const events = Array.from({ length: 40 }, (_, index) => ({
    sequence: index + 1,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: `History ${index + 1}` }] } },
  }));
  api.setEvents(events);
  await expect(page.getByText("History 40", { exact: true })).toBeVisible();
  const distanceFromBottom = () => page.locator(".timeline").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromBottom).toBeLessThan(4);

  api.setEvents([...events, {
    sequence: 41,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: "Latest reply\n\n![Delayed chart](/delayed-timeline-image.svg)" }] } },
  }]);
  const delayedImage = page.getByAltText("Delayed chart");
  await expect(delayedImage).toHaveJSProperty("complete", true);
  await expect.poll(distanceFromBottom).toBeLessThan(4);

  await page.locator(".timeline").hover();
  await page.mouse.wheel(0, -24);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).not.toHaveClass(/at-bottom/);
  const manualScrollTop = await page.locator(".timeline").evaluate((element) => element.scrollTop);
  api.setEvents([...events, {
    sequence: 41,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: "Latest reply\n\n![Delayed chart](/delayed-timeline-image.svg)" }] } },
  }, {
    sequence: 42,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: "Do not pull the reader down" }] } },
  }]);
  await expect(page.getByText("Do not pull the reader down", { exact: true })).toHaveCount(1);
  await expect.poll(() => page.locator(".timeline").evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(manualScrollTop + 1);
});

test("conversation renders coding content and remains usable at constrained heights", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 800, height: 600 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const timestamp = new Date().toISOString();
  await page.evaluate(() => localStorage.setItem("piss:draft:session-1", JSON.stringify({ text: "Render the result", delivery: "steer", updatedAt: Date.now() })));
  api.setEvents([
    { sequence: 1, type: "message_end", timestamp, data: { message: { role: "user", content: [{ type: "text", text: "Render the result" }] } } },
    { sequence: 2, type: "message_end", timestamp, data: { message: { role: "assistant", content: [{ type: "text", text: "## Result\n\n- one\n- two\n\n```ts\nconst answer = 42\n```" }] } } },
    { sequence: 3, type: "tool_execution_start", timestamp, data: { toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } } },
    { sequence: 4, type: "tool_execution_end", timestamp, data: { toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "all tests passed" }] }, isError: false } },
    ...Array.from({ length: 35 }, (_, index) => ({ sequence: index + 5, type: "message_end", timestamp, data: { message: { role: "assistant", content: [{ type: "text", text: `Result ${index + 1}` }] } } })),
  ]);

  await expect(page.getByRole("heading", { name: "Result" })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("piss:draft:session-1"))).toBeNull();
  await expect(page.getByText("Result 35", { exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".timeline").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  await expect(page.locator("pre code")).toContainText("const answer = 42");
  const copyAssistant = page.getByRole("button", { name: "Copy PI message" }).first();
  await copyAssistant.click();
  await expect(page.getByRole("button", { name: "Copied PI message" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("## Result\n\n- one\n- two\n\n```ts\nconst answer = 42\n```");
  await page.getByText("bash", { exact: true }).click();
  await expect(page.locator(".tool-result pre")).toHaveText("all tests passed");
  await page.getByRole("button", { name: "Copy bash tool output" }).click();
  await expect(page.getByRole("button", { name: "Copied bash tool output" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("all tests passed");
  api.failNextCommand();
  await page.getByLabel("Message Pi").fill("fail this request");
  await page.locator(".send-button").click();
  await expect(page.locator(".operation-error")).toContainText("simulated failure");

  await page.setViewportSize({ width: 760, height: 600 });
  await expect(page.getByRole("button", { name: "Open workspaces and sessions" })).toBeVisible();
  await page.setViewportSize({ width: 761, height: 600 });
  await expect(page.getByRole("button", { name: "Open workspaces and sessions" })).toBeHidden();
});

test("desktop workbench contains only operational controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installApi(page);
  await page.goto("/");

  await expect(page.locator(".add-workspace svg")).toBeVisible();
  await expect(page.locator(".add-session svg")).toBeVisible();
  await expect(page.locator(".add-workspace svg path").first()).toHaveCSS("stroke", "rgb(49, 92, 70)");
  await page.getByRole("button", { name: "New session in erp" }).click();
  const createDialog = page.getByRole("dialog", { name: "New session" });
  await createDialog.getByLabel("Session name").fill("Desktop utility");
  await createDialog.getByRole("button", { name: /start session/i }).click();
  await expect(createDialog).toBeHidden();

  const sessionTabs = page.locator(".capability-tabs").getByRole("tab");
  await expect(sessionTabs).toHaveCount(2);
  await expect(sessionTabs.filter({ hasText: "Agent" })).toBeVisible();
  await expect(sessionTabs.filter({ hasText: "Events" })).toHaveCount(0);
  const changesTab = sessionTabs.filter({ hasText: "Changes" });
  await expect(changesTab).toBeVisible();
  await changesTab.click();
  await expect(changesTab.locator("em")).toHaveText("2");
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toBeVisible();
  await expect(page.getByText("web/src/", { exact: true })).toBeVisible();
  await expect(page.getByText("App.tsx", { exact: true })).toBeVisible();
  await expect(page.locator(".diff-patch .removed")).toContainText("old line");
  await expect(page.locator(".diff-patch .added").first()).toContainText("new line");
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect.poll(() => api.reviewRequestCount()).toBe(2);
  await page.locator(".capability-tabs").getByRole("tab", { name: /Agent/ }).click();
  await expect(page.getByText("Files", { exact: true })).toHaveCount(0);
  await expect(page.getByText("EFFECT 4", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/PI SIN SIDECAR/i)).toHaveCount(0);
  await expect(page.getByText(/first instruction|choose a trusted|later tracer/i)).toHaveCount(0);

  await page.getByLabel("Message Pi").fill("Desktop @app");
  await expect(page.getByRole("listbox", { name: "Workspace files" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Mention a file" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByLabel("Message Pi").fill("");

  await page.getByRole("button", { name: "MODEL" }).click();
  const modelDialog = page.getByRole("dialog", { name: "Model & thinking" });
  await expect(modelDialog).toBeVisible();
  const box = await modelDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);

  const dimensions = await page.locator(".shell").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(dimensions.scroll).toBe(dimensions.client);
  await modelDialog.getByRole("button", { name: "DONE" }).click();
  await expect(page.getByRole("button", { name: "STOP SESSION" })).toHaveCount(0);
  const sessionSettings = page.getByRole("button", { name: "Session settings for Desktop utility" });
  await sessionSettings.click();
  const archiveButton = page.getByRole("menuitem", { name: "ARCHIVE" });
  await expect(archiveButton).toBeVisible();
  await archiveButton.click();
  const archiveDialog = page.getByRole("alertdialog", { name: "Archive session?" });
  const closeArchive = archiveDialog.getByRole("button", { name: "Close" });
  const cancelArchive = archiveDialog.getByRole("button", { name: "CANCEL" });
  const confirmArchive = archiveDialog.getByRole("button", { name: "ARCHIVE SESSION" });
  await expect(archiveDialog).toContainText("will stop running and be removed from PISS");
  await expect(archiveDialog).toContainText("conversation file will remain on disk for recovery");
  await expect(cancelArchive).toBeFocused();
  await closeArchive.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmArchive).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeArchive).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(archiveDialog).toBeHidden();
  await expect(sessionSettings).toBeFocused();

  api.setStatus("stopped");
  await expect(page.locator(".runtime-state")).toContainText("Stopped", { timeout: 5_000 });
  const resumeButton = page.getByRole("button", { name: "RESUME SESSION" });
  await expect(resumeButton).toBeVisible();
  await resumeButton.click();
  await expect(page.getByLabel("Message Pi")).toBeEnabled();

  await sessionSettings.click();
  await page.getByRole("menuitem", { name: "ARCHIVE" }).click();
  await page.getByRole("alertdialog", { name: "Archive session?" }).getByRole("button", { name: "ARCHIVE SESSION" }).click();
  await expect(archiveDialog).toBeHidden();
  await expect(sessionSettings).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Desktop utility/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No session selected" })).toBeVisible();
  await expect(page.locator(".brand")).toBeFocused();
});

test("navigation exposes every deterministic attention state and acknowledges finished work", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  for (const [status, label] of [
    ["starting", "Starting"],
    ["working", "Working"],
    ["idle", "Idle"],
    ["blocked", "Needs input"],
    ["finished", "Finished"],
    ["stopping", "Stopping"],
    ["stopped", "Stopped"],
    ["crashed", "Crashed"],
  ] as const) {
    api.setStatus(status);
    await expect(page.locator(".runtime-state")).toContainText(label, { timeout: 5_000 });
    await expect(page.locator(".session-card .session-copy small")).toContainText(label);
  }

  api.setStatus("finished");
  const card = page.locator(".session-card").filter({ hasText: "New session" });
  await expect(card).toContainText("Finished");
  await card.click();
  await expect(card).toContainText("Idle");
  await expect(page.locator(".runtime-state")).toContainText("Idle");
});

test("interactive Pi requests restore on refresh and support select, confirm, input, editor, and cancel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const request = (id: string, method: "select" | "confirm" | "input" | "editor", title: string, extra: Record<string, unknown> = {}) => ({
    id, method, title, receivedAt: new Date().toISOString(), ...extra,
  });
  api.setInteractiveRequests([
    request("select-1", "select", "Choose deployment", { message: "<img src=x onerror=alert(1)>", options: ["Preview", "Production"] }),
    request("confirm-queued", "confirm", "Confirm queued action", { message: "This follows the selection." }),
  ] as Parameters<typeof api.setInteractiveRequests>[0]);

  let dialog = page.getByRole("dialog", { name: "Choose deployment" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toContainText("1 more request is queued");
  await expect(dialog).toContainText("<img src=x onerror=alert(1)>");
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(page.getByText("New session is Needs input", { exact: true })).toBeAttached();
  await page.reload();
  dialog = page.getByRole("dialog", { name: "Choose deployment" });
  await expect(dialog).toBeVisible();
  const select = dialog.getByLabel("Choose one");
  await expect(select).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await select.selectOption("Production");
  await dialog.getByRole("button", { name: "SUBMIT" }).click();
  await expect.poll(() => api.interactiveResponses.at(-1)?.value).toBe("Production");

  dialog = page.getByRole("dialog", { name: "Confirm queued action" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "YES" }).click();
  await expect.poll(() => api.interactiveResponses.at(-1)?.confirmed).toBe(true);

  api.setInteractiveRequests([request("input-1", "input", "Name the release", { placeholder: "release name" })] as Parameters<typeof api.setInteractiveRequests>[0]);
  dialog = page.getByRole("dialog", { name: "Name the release" });
  await dialog.getByLabel("Response").fill("stable");
  await page.keyboard.press("Enter");
  await expect.poll(() => api.interactiveResponses.at(-1)?.value).toBe("stable");

  api.setInteractiveRequests([request("editor-1", "editor", "Edit release notes", { prefill: "Line one" })] as Parameters<typeof api.setInteractiveRequests>[0]);
  dialog = page.getByRole("dialog", { name: "Edit release notes" });
  await expect(dialog.getByLabel("Response")).toHaveValue("Line one");
  await dialog.getByLabel("Response").fill("Line one\nLine two");
  await dialog.getByRole("button", { name: "SUBMIT" }).click();
  await expect.poll(() => api.interactiveResponses.at(-1)?.value).toBe("Line one\nLine two");

  api.setInteractiveRequests([request("cancel-1", "confirm", "Cancel explicitly") ] as Parameters<typeof api.setInteractiveRequests>[0]);
  dialog = page.getByRole("dialog", { name: "Cancel explicitly" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => api.interactiveResponses.at(-1)?.cancelled).toBe(true);
  await expect(dialog).toHaveCount(0);
});

test("notification permission and push subscription use separate user gestures", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { notificationRequests: number; subscriptionHadUserActivation: boolean; notificationPermission: NotificationPermission; notificationPermissionResult: NotificationPermission; fakePushSubscription?: PushSubscription };
    state.notificationRequests = 0;
    state.subscriptionHadUserActivation = false;
    state.notificationPermission = "default";
    state.notificationPermissionResult = "granted";
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => state.notificationPermission });
    Notification.requestPermission = async () => {
      state.notificationRequests += 1;
      state.notificationPermission = state.notificationPermissionResult;
      return state.notificationPermissionResult;
    };
    Object.defineProperty(PushManager.prototype, "getSubscription", { configurable: true, value: async () => state.fakePushSubscription ?? null });
    Object.defineProperty(PushManager.prototype, "subscribe", { configurable: true, value: async () => {
      state.subscriptionHadUserActivation = navigator.userActivation.isActive;
      if (state.notificationPermission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new DOMException("Permission denied", "NotAllowedError");
      }
      const fake = {
        endpoint: "https://push.example.test/browser",
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: () => null,
        toJSON: () => ({ endpoint: "https://push.example.test/browser", expirationTime: null, keys: { p256dh: "browser-key", auth: "browser-auth" } }),
        unsubscribe: async () => { state.fakePushSubscription = undefined; return true; },
      } as unknown as PushSubscription;
      state.fakePushSubscription = fake;
      return fake;
    } });
  });
  const api = await installApi(page, { notifications: true });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.register("/service-worker.js", { scope: "/" }));
  const toggle = page.getByRole("button", { name: /ATTENTION ALERTS/ });
  await expect(toggle).toContainText("OFF FOR THIS DEVICE");
  await expect.poll(() => page.evaluate(() => (window as unknown as { notificationRequests: number }).notificationRequests)).toBe(0);

  await toggle.click();
  await expect(toggle).toContainText("TAP TO FINISH SETUP");
  await expect.poll(() => page.evaluate(() => (window as unknown as { notificationRequests: number }).notificationRequests)).toBe(1);
  expect(api.notificationMutations).toHaveLength(0);

  await toggle.click();
  await expect(toggle).toContainText("ON FOR THIS DEVICE");
  await expect.poll(() => api.notificationMutations.at(-1)?.action).toBe("subscribe");
  expect(await page.evaluate(() => (window as unknown as { subscriptionHadUserActivation: boolean }).subscriptionHadUserActivation)).toBe(true);
  await page.getByRole("button", { name: "DISABLE" }).click();
  await expect(toggle).toContainText("TAP TO FINISH SETUP");
  await expect.poll(() => api.notificationMutations.at(-1)?.action).toBe("unsubscribe");

  await page.evaluate(() => {
    const state = window as unknown as { notificationPermission: NotificationPermission; notificationPermissionResult: NotificationPermission };
    state.notificationPermission = "default";
    state.notificationPermissionResult = "denied";
  });
  await toggle.click();
  await expect(toggle).toContainText("BLOCKED BY BROWSER");
  await expect.poll(() => page.evaluate(() => (window as unknown as { notificationRequests: number }).notificationRequests)).toBe(2);

  await page.getByRole("button", { name: "New session in erp" }).click();
  let sessionDialog = page.getByRole("dialog", { name: "New session" });
  await sessionDialog.getByLabel("Session name").fill("Notification target");
  await sessionDialog.getByRole("button", { name: /start session/i }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  sessionDialog = page.getByRole("dialog", { name: "New session" });
  await sessionDialog.getByLabel("Session name").fill("Other session");
  await sessionDialog.getByRole("button", { name: /start session/i }).click();
  await page.goto("/?session=session-1");
  await expect(page.locator(".brand b")).toHaveText("Notification target");
});

test("Chrome's quiet address-bar prompt explains and completes notification setup", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      notificationPermission: NotificationPermission;
      permissionState: PermissionState;
      permissionStatus: EventTarget;
      fakePushSubscription?: PushSubscription;
    };
    state.notificationPermission = "default";
    state.permissionState = "prompt";
    state.permissionStatus = new EventTarget();
    Object.defineProperty(state.permissionStatus, "state", { configurable: true, get: () => state.permissionState });
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => state.notificationPermission });
    Notification.requestPermission = async () => "default";
    Object.defineProperty(navigator.permissions, "query", { configurable: true, value: async () => state.permissionStatus });
    Object.defineProperty(PushManager.prototype, "getSubscription", { configurable: true, value: async () => state.fakePushSubscription ?? null });
    Object.defineProperty(PushManager.prototype, "subscribe", { configurable: true, value: async () => {
      const fake = {
        endpoint: "https://push.example.test/quiet-prompt",
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: () => null,
        toJSON: () => ({ endpoint: "https://push.example.test/quiet-prompt", expirationTime: null, keys: { p256dh: "quiet-key", auth: "quiet-auth" } }),
        unsubscribe: async () => { state.fakePushSubscription = undefined; return true; },
      } as unknown as PushSubscription;
      state.fakePushSubscription = fake;
      return fake;
    } });
  });
  const api = await installApi(page, { notifications: true });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.register("/service-worker.js", { scope: "/" }));
  const toggle = page.getByRole("button", { name: /ATTENTION ALERTS/ });
  await toggle.click();
  await expect(toggle).toContainText("TAP CROSSED-OUT BELL ABOVE");
  expect(api.notificationMutations).toHaveLength(0);

  await page.evaluate(() => {
    const state = window as unknown as { notificationPermission: NotificationPermission; permissionState: PermissionState; permissionStatus: EventTarget };
    state.notificationPermission = "granted";
    state.permissionState = "granted";
    state.permissionStatus.dispatchEvent(new Event("change"));
  });
  await expect(toggle).toContainText("ON FOR THIS DEVICE");
  await expect.poll(() => api.notificationMutations.at(-1)?.action).toBe("subscribe");
});

test("notification setup failures expose the browser error instead of hiding it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
    Notification.requestPermission = async () => "granted";
    Object.defineProperty(PushManager.prototype, "getSubscription", { configurable: true, value: async () => null });
    Object.defineProperty(PushManager.prototype, "subscribe", { configurable: true, value: async () => { throw new DOMException("Push service rejected registration", "AbortError"); } });
  });
  await installApi(page, { notifications: true });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.register("/service-worker.js", { scope: "/" }));
  const toggle = page.getByRole("button", { name: /ATTENTION ALERTS/ });
  await expect(toggle).toContainText("TAP TO FINISH SETUP");
  await toggle.click();
  await expect(toggle).toContainText("SETUP FAILED · TAP TO RETRY");
  await expect(toggle).toContainText("AbortError: Push service rejected registration");
});

test("session details show real usage and control Pi compaction", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const detailsToggle = page.getByRole("button", { name: /SESSION DETAILS/ });
  await detailsToggle.click();
  const details = page.getByRole("region", { name: "Session usage and compaction" });
  await expect(details).toContainText("42,000 / 200,000");
  await expect(details).toContainText("1,200 / 345");
  await expect(details).toContainText("$0.4200");
  const auto = details.getByRole("button", { name: /AUTO COMPACT: ON/ });
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await auto.click();
  await expect(details.getByRole("button", { name: /AUTO COMPACT: OFF/ })).toHaveAttribute("aria-pressed", "false");

  const compact = details.getByRole("button", { name: "COMPACT NOW" });
  await compact.click();
  const confirm = page.getByRole("alertdialog", { name: "Compact session context?" });
  await expect(confirm).toContainText("lossy");
  await expect(confirm).toContainText("complete append-only Pi transcript remains on disk");
  await confirm.getByRole("button", { name: "COMPACT NOW" }).click();
  await expect(details.getByRole("button", { name: "COMPACTING…" })).toBeVisible({ timeout: 5_000 });
  await expect(details).toContainText("succeeded · 42,000 → 12,000", { timeout: 5_000 });
  await expect(details).toContainText("Recalculating");

  api.setStatus("working");
  await expect(details.getByRole("button", { name: "COMPACT NOW" })).toBeDisabled({ timeout: 5_000 });
});

test("production PWA caches one complete build, updates atomically, and preserves offline drafts", async ({ page }) => {
  test.setTimeout(90_000);
  await execFileAsync("npm", ["run", "build:web"], { cwd: process.cwd() });
  const directory = await mkdtemp(join(tmpdir(), "piss-pwa-"));
  const buildRoot = join(directory, "public");
  await cp(resolve("dist/public"), buildRoot, { recursive: true });
  const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const body = url.pathname === "/api/notifications" ? { supported: false }
        : url.pathname === "/api/workspaces" ? { workspaces: [] }
          : url.pathname === "/api/sessions" ? { sessions: [] }
            : { ok: true, apiVersion: 1, architecture: "effect-v4" };
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      return;
    }
    let path = resolve(buildRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!path.startsWith(`${resolve(buildRoot)}/`)) { response.writeHead(404).end(); return; }
    try {
      if (!(await stat(path)).isFile()) path = join(buildRoot, "index.html");
    } catch { path = join(buildRoot, "index.html"); }
    const body = await readFile(path);
    const fileName = path.split("/").at(-1);
    response.writeHead(200, {
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
      "cache-control": fileName === "service-worker.js" || fileName === "index.html" || fileName === "manifest.webmanifest" ? "no-cache" : "public, max-age=31536000, immutable",
    }).end(body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PWA test server has no port");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    await page.goto(`${origin}/?session=offline-session`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!await page.evaluate(() => navigator.serviceWorker.controller !== null)) await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json() as { name: string; short_name: string; display: string; icons: unknown[] };
    expect(manifest.name).toBe("PISS");
    expect(manifest.short_name).toBe("PISS");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toHaveLength(2);

    const initialIndex = await readFile(join(buildRoot, "index.html"), "utf8");
    const initialAssets = [...initialIndex.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
    expect(initialAssets.some((asset) => asset.endsWith(".js"))).toBe(true);
    expect(initialAssets.some((asset) => asset.endsWith(".css"))).toBe(true);
    const initialCache = await page.evaluate(async () => {
      const keys = await caches.keys();
      const key = keys.find((candidate) => candidate.startsWith("piss-shell-"));
      const entries = key ? (await caches.open(key)).keys().then((requests) => requests.map((request) => new URL(request.url).pathname)) : [];
      return { keys, entries: await entries };
    });
    for (const asset of initialAssets) expect(initialCache.entries).toContain(asset);
    expect(initialCache.entries.some((path) => path.startsWith("/api/"))).toBe(false);

    await page.evaluate(() => localStorage.setItem("piss:draft:offline-session", JSON.stringify({ text: "offline draft survives", delivery: "steer", updatedAt: Date.now() })));
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Control plane unavailable" })).toBeVisible();
    await expect(page.getByLabel("Offline draft")).toHaveValue("offline draft survives");
    await page.getByLabel("Offline draft").fill("offline draft edited");
    await expect(page.getByRole("button", { name: "OFFLINE · NOT SENT" })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("piss:draft:offline-session") ?? "{}").text)).toBe("offline draft edited");
    await page.context().setOffline(false);

    let nextIndex = await readFile(join(buildRoot, "index.html"), "utf8");
    const replacements = new Map<string, string>();
    for (const asset of initialAssets) {
      const oldName = asset.slice("/assets/".length);
      const dot = oldName.lastIndexOf(".");
      const newName = `${oldName.slice(0, dot)}-next${oldName.slice(dot)}`;
      await rename(join(buildRoot, "assets", oldName), join(buildRoot, "assets", newName));
      replacements.set(asset, `/assets/${newName}`);
      nextIndex = nextIndex.replaceAll(asset, `/assets/${newName}`);
    }
    await writeFile(join(buildRoot, "index.html"), nextIndex);
    let nextWorker = await readFile(join(buildRoot, "service-worker.js"), "utf8");
    nextWorker = nextWorker.replace(/piss-shell-[a-f0-9]+/, "piss-shell-nextbuild");
    for (const [oldAsset, newAsset] of replacements) nextWorker = nextWorker.replaceAll(oldAsset, newAsset);
    await writeFile(join(buildRoot, "service-worker.js"), nextWorker);

    await page.evaluate(() => navigator.serviceWorker.getRegistration("/").then((registration) => registration?.update()));
    const updateButton = page.getByRole("button", { name: "APPLY UPDATE" });
    await expect(updateButton).toBeVisible({ timeout: 15_000 });
    await updateButton.click();
    await page.waitForLoadState("load");
    await expect.poll(() => page.locator("script[type=module]").getAttribute("src")).toContain("-next.js");
    const finalCaches = await page.evaluate(async () => ({
      keys: await caches.keys(),
      entries: await Promise.all((await caches.keys()).map(async (key) => (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname))),
    }));
    expect(finalCaches.keys.filter((key) => key.startsWith("piss-shell-"))).toEqual(["piss-shell-nextbuild"]);
    for (const asset of replacements.values()) expect(finalCaches.entries.flat()).toContain(asset);
    for (const asset of replacements.keys()) expect(finalCaches.entries.flat()).not.toContain(asset);
    expect(finalCaches.entries.flat().some((path) => path.startsWith("/api/"))).toBe(false);
  } finally {
    await page.context().setOffline(false);
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});
