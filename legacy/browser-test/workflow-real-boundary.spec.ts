import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const apiPort = 4329;
const webPort = 4180;
let root = "";
let server: ChildProcess | undefined;
let vite: ChildProcess | undefined;
let serverLog = "";
let viteLog = "";

async function waitFor(url: string, child: () => ChildProcess | undefined, log: () => string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child()?.exitCode !== null) throw new Error(`Process exited before ${url}\n${log()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}\n${log()}`);
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveDone) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveDone(); }, 3_000);
    child.once("exit", () => { clearTimeout(timer); resolveDone(); });
  });
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "piss-real-workflow-"));
  const sessionRoot = join(root, "sessions");
  const publicRoot = join(root, "public");
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(publicRoot, { recursive: true });
  await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>PISS fixture</title>");
  const fakePi = resolve("browser-test/fixtures/fake-workflow-pi.mjs");
  await chmod(fakePi, 0o755);
  const common = { ...process.env, NODE_ENV: "development", PISS_DEV_BYPASS_AUTH: "1" };
  server = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: resolve("."),
    env: {
      ...common,
      PISS_PORT: String(apiPort),
      PISS_DEV_WEB_PORT: String(webPort),
      PISS_STATE_DIR: join(root, "state"),
      PISS_PUBLIC_DIR: publicRoot,
      PISS_PI_COMMAND: fakePi,
      PISS_PI_SESSION_ROOTS: JSON.stringify([sessionRoot]),
      FAKE_PI_SESSION_ROOT: sessionRoot,
      PISS_WORKSPACES: JSON.stringify([{ name: "PISS fixture", root: resolve("."), trustProjectResources: true }]),
      PISS_WORKSPACE_DISCOVERY_ROOTS: JSON.stringify([resolve("..")] ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { serverLog += String(chunk); });
  server.stderr?.on("data", (chunk) => { serverLog += String(chunk); });
  vite = spawn(resolve("node_modules/.bin/vite"), ["--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(webPort)], {
    cwd: resolve("."), env: { ...common, PISS_PORT: String(apiPort), PISS_DEV_WEB_PORT: String(webPort) }, stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stdout?.on("data", (chunk) => { viteLog += String(chunk); });
  vite.stderr?.on("data", (chunk) => { viteLog += String(chunk); });
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`, () => server, () => serverLog),
    waitFor(`http://127.0.0.1:${webPort}/`, () => vite, () => viteLog),
  ]);
});

test.afterAll(async () => {
  await stop(vite);
  await stop(server);
});

test("actual server and Pi RPC complete the plan-first workflow across refinement, authority, guidance, repair, and reload", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`http://127.0.0.1:${webPort}/`);
  const workspaceId = await page.evaluate(async () => {
    const response = await fetch("/api/workspaces");
    const body = await response.json();
    return body.workspaces[0].id as string;
  });
  await page.evaluate(async (id) => {
    const response = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: id, name: "Real plan-first workflow" }) });
    if (!response.ok) throw new Error(await response.text());
  }, workspaceId);
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const starter = page.getByRole("dialog", { name: "Define, build, prove" });
  await starter.getByLabel("Objective").fill("Make the workflow reliable even when authority and recovery requirements are ambiguous");
  await starter.getByRole("button", { name: /start define/i }).click();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("Which reliability boundary matters most?");
  await workflow.getByRole("button", { name: "GUIDE CURRENT WORKFLOW" }).click();
  let guidance = page.getByRole("dialog", { name: "Guide current workflow" });
  await guidance.getByRole("textbox", { name: "Guidance", exact: true }).fill("Prioritize exact structured authority matching.");
  await guidance.getByRole("button", { name: /send guidance/i }).click();

  await expect(workflow).toContainText("Should recoverable failures enter bounded Repair automatically?");
  await workflow.getByRole("button", { name: "GUIDE CURRENT WORKFLOW" }).click();
  guidance = page.getByRole("dialog", { name: "Guide current workflow" });
  await guidance.getByRole("textbox", { name: "Guidance", exact: true }).fill("Yes, use one bounded automatic repair before blocking.");
  await guidance.getByRole("button", { name: /send guidance/i }).click();

  await expect(workflow).toContainText("Final approval", { timeout: 20_000 });
  await workflow.getByText("STRUCTURED APPROVAL DOSSIER").click();
  await expect(workflow).toContainText("Receipt required · Idempotency key: approved-edit-once");
  await expect(workflow.getByRole("button", { name: "APPROVE & RUN" })).toBeEnabled();
  await workflow.getByRole("button", { name: "APPROVE & RUN" }).click();

  const outside = page.getByRole("dialog", { name: "Confirm production deployment" });
  await expect(outside).toContainText("outside the approved plan");
  await outside.getByRole("button", { name: "NO", exact: true }).click();
  await expect(outside).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Confirm approved workspace edit" })).toHaveCount(0);
  await expect(page.getByText("Approved plan authority applied")).toBeVisible();

  await expect(workflow).toContainText("1/2", { timeout: 20_000 });
  await page.reload();
  await expect(workflow).toContainText("Completed the first of two slices");
  await workflow.getByRole("button", { name: "GUIDE CURRENT WORKFLOW" }).click();
  guidance = page.getByRole("dialog", { name: "Guide current workflow" });
  await guidance.getByRole("textbox", { name: "Guidance", exact: true }).fill("Keep the recovery evidence concise and preserve the authority audit.");
  await guidance.getByRole("button", { name: /send guidance/i }).click();

  await expect(workflow).toContainText("Ready to ship", { timeout: 30_000 });
  await expect(workflow).toContainText("2/2");
  await expect(workflow).toContainText("1/3 REPAIRS");
  await expect(workflow).toContainText("0Q · 0D · 3A");
  await expect(workflow).toContainText("PHASE RUN");
  await expect(workflow).toContainText("TRANSIENT RETRY");
  await expect(workflow.getByText("COMPLETE SPECIFICATION")).toBeVisible();
  await expect(workflow.getByText("EXECUTABLE PLAN & AUTONOMY ENVELOPE")).toBeVisible();
  await workflow.getByText(/CRITERIA & EVIDENCE/).click();
  await expect(workflow).toContainText("Approved authority auto-resolved while production stayed blocked");
  await workflow.getByText(/GUIDANCE LOG/).click();
  await expect(workflow).toContainText("Keep the recovery evidence concise and preserve the authority audit.");
  await workflow.getByText(/OPERATION RECEIPTS/).click();
  await expect(workflow).toContainText("approved-edit-once");
  await page.reload();
  await expect(workflow).toContainText("Ready to ship");
  await expect(workflow).toContainText("2/2");
  await expect(workflow.getByText(/CRITERIA & EVIDENCE/)).toBeVisible();
  await expect(workflow.getByText(/GUIDANCE LOG/)).toBeVisible();
  await expect(workflow.getByText(/OPERATION RECEIPTS/)).toBeVisible();
  await expect(page.getByText("The previous run ended after tool execution without a final response.", { exact: false })).toHaveCount(0);
});
