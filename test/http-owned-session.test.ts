import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function* serverSentEvents(response: Response): AsyncGenerator<{ readonly id: number; readonly data: unknown }> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame || frame.startsWith(":")) continue;
        const id = Number(/^id: (\d+)$/mu.exec(frame)?.[1]);
        const data = /^data: (.+)$/mu.exec(frame)?.[1];
        if (Number.isSafeInteger(id) && data) yield { id, data: JSON.parse(data) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function fakePi(directory: string): Promise<string> {
  const path = join(directory, "fake-pi.mjs");
  await writeFile(path, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.env.FAKE_PI_CWD_FILE) writeFileSync(process.env.FAKE_PI_CWD_FILE, process.cwd());
const sessionFile = process.env.FAKE_PI_SESSION_DIR + "/" + encodeURIComponent(process.cwd()) + ".jsonl";
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "http-pi-session", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
const models = [
  { provider: "http", id: "model-a", name: "HTTP Model A", reasoning: true, baseUrl: "https://credential@example.invalid", headers: { Authorization: "Bearer super-secret" }, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
  { provider: "http", id: "model-b", name: "HTTP Model B", reasoning: false }
];
let currentModel = models[0];
let currentThinking = "medium";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (command.type === "get_state") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "http-pi-session", sessionFile, model: currentModel, thinkingLevel: currentThinking, isStreaming: false, autoCompactionEnabled: true, pendingMessageCount: 0 } }));
    if (command.type === "get_available_models") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_available_models", success: true, data: { models } }));
    if (command.type === "get_commands") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: [
      { name: "review", description: "Review through HTTP", source: "extension", sourceInfo: { path: "/private/review.ts", source: "test", scope: "project", origin: "top-level" } }
    ] } }));
    if (command.type === "get_session_stats") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 10, tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 50, total: 1750 }, cost: 0.25, contextUsage: { tokens: 30000, contextWindow: 200000, percent: 15 } } }));
    if (command.type === "compact") {
      console.log(JSON.stringify({ type: "compaction_start", reason: "manual" }));
      console.log(JSON.stringify({ id: command.id, type: "response", command: "compact", success: true, data: { tokensBefore: 30000, estimatedTokensAfter: 9000 } }));
      console.log(JSON.stringify({ type: "compaction_end", reason: "manual", result: { tokensBefore: 30000, estimatedTokensAfter: 9000 }, aborted: false, willRetry: false }));
    }
    if (command.type === "set_auto_compaction") console.log(JSON.stringify({ id: command.id, type: "response", command: "set_auto_compaction", success: true }));
    if (command.type === "get_entries") {
      const entries = readFileSync(sessionFile, "utf8").trim().split("\\n").slice(1).map(JSON.parse);
      console.log(JSON.stringify({ id: command.id, type: "response", command: "get_entries", success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } }));
    }
    if (command.type === "set_model") {
      currentModel = models.find((model) => model.provider === command.provider && model.id === command.modelId) ?? currentModel;
      currentThinking = currentModel.reasoning ? "medium" : "off";
      console.log(JSON.stringify({ id: command.id, type: "response", command: "set_model", success: true, data: currentModel }));
    }
    if (command.type === "set_thinking_level") {
      currentThinking = command.level;
      console.log(JSON.stringify({ id: command.id, type: "response", command: "set_thinking_level", success: true }));
    }
    if (command.type === "prompt") {
      appendFileSync(sessionFile, JSON.stringify({ type: "message", id: command.id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: command.message }] } }) + "\\n");
      console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [
        ...(command.message ? [{ type: "text", text: command.message }] : []),
        ...(command.images ?? [])
      ] } }));
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "HTTP tracer complete" } }));
      if (command.message === "Huge tool output") {
        console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "huge-call", toolName: "bash", args: { command: "generate" } }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "huge-call", toolName: "bash", result: { content: [{ type: "text", text: "UNICODE-OUTPUT-🧪".repeat(180000) + "END-OF-HUGE-OUTPUT" }] }, isError: false }));
      }
      if (command.message === "Request interactive input") {
        console.log(JSON.stringify({ type: "extension_ui_request", id: "http-request-confirm", method: "confirm", title: "Continue?", message: "Confirm through HTTP" }));
      } else {
        setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 500);
      }
    }
    if (command.type === "extension_ui_response") {
      console.log(JSON.stringify({ type: "agent_settled" }));
    }
    if (command.type === "steer") console.log(JSON.stringify({ id: command.id, type: "response", command: "steer", success: true }));
    if (command.type === "follow_up") console.log(JSON.stringify({ id: command.id, type: "response", command: "follow_up", success: true }));
    if (command.type === "abort") console.log(JSON.stringify({ id: command.id, type: "response", command: "abort", success: true }));
  }
});
`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("serves the authenticated owned-session tracer through HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-http-"));
  const publicDir = join(directory, "public");
  await mkdir(publicDir);
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>PISS</title>");
  const piCommand = await fakePi(directory);
  const port = await availablePort();
  const origin = "https://piss.example.ts.net";
  const identityHeaders = {
    "Tailscale-User-Login": "owner@example.com",
    "X-Forwarded-Host": "piss.example.ts.net",
  };
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PISS_HOST: "127.0.0.1",
      PISS_PORT: String(port),
      PISS_ALLOWED_USERS: "owner@example.com",
      PISS_PUBLIC_DIR: publicDir,
      PISS_STATE_DIR: join(directory, "state"),
      PISS_PI_COMMAND: piCommand,
      PISS_PI_SESSION_ROOTS: JSON.stringify([directory]),
      PISS_WORKSPACE_DISCOVERY_ROOTS: JSON.stringify([directory]),
      PISS_WORKSPACES: JSON.stringify([{ name: "HTTP test", root: directory, trustProjectResources: false }]),
      FAKE_PI_CWD_FILE: join(directory, "fake-pi-cwd"),
      FAKE_PI_SESSION_DIR: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString("utf8"); });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) break;
      } catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const unauthenticatedNotifications = await fetch(`${base}/api/notifications`);
    assert.equal(unauthenticatedNotifications.status, 401);
    const notificationCapability = await fetch(`${base}/api/notifications`, { headers: identityHeaders });
    assert.equal(notificationCapability.status, 200);
    const capability = await notificationCapability.json() as { supported: boolean; vapidPublicKey: string };
    assert.equal(capability.supported, true);
    assert.ok(capability.vapidPublicKey.length > 20);
    const invalidSubscription = await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ action: "subscribe", subscription: { endpoint: "http://unsafe.invalid", expirationTime: null, keys: { p256dh: "key", auth: "auth" } } }),
    });
    assert.equal(invalidSubscription.status, 400);
    const subscription = { endpoint: "https://push.example.test/device-one", expirationTime: null, keys: { p256dh: "test-public-key", auth: "test-auth" } };
    const subscribed = await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ action: "subscribe", subscription }),
    });
    assert.equal(subscribed.status, 200, await subscribed.text());
    assert.match(await readFile(join(directory, "state", "push-subscriptions.json"), "utf8"), /push\.example\.test/);
    const unsubscribed = await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }),
    });
    assert.equal(unsubscribed.status, 200);
    assert.doesNotMatch(await readFile(join(directory, "state", "push-subscriptions.json"), "utf8"), /push\.example\.test/);

    const workspaceResponse = await fetch(`${base}/api/workspaces`, { headers: identityHeaders });
    assert.equal(workspaceResponse.status, 200, logs);
    const workspaceBody = await workspaceResponse.json() as { workspaces: Array<{ id: string }> };
    const workspaceId = workspaceBody.workspaces[0]?.id;
    assert.ok(workspaceId);

    const unauthenticatedDirectories = await fetch(`${base}/api/directories?query=public`);
    assert.equal(unauthenticatedDirectories.status, 401);

    const directoryResponse = await fetch(`${base}/api/directories?query=public`, { headers: identityHeaders });
    if (directoryResponse.status !== 200) assert.fail(`Directory search failed: ${await directoryResponse.text()}`);
    const directoryBody = await directoryResponse.json() as { candidates: Array<{ path: string }> };
    assert.ok(directoryBody.candidates.some((candidate) => candidate.path === publicDir));

    const workspaceMutationBody = JSON.stringify({ name: "Created through HTTP", path: directory, createDirectory: true, directoryName: "created-workspace", trustProjectResources: false });
    const unauthenticatedWorkspace = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: workspaceMutationBody,
    });
    assert.equal(unauthenticatedWorkspace.status, 401);
    const wrongOriginWorkspace = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...identityHeaders },
      body: workspaceMutationBody,
    });
    assert.equal(wrongOriginWorkspace.status, 403);

    const createdWorkspaceResponse = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: workspaceMutationBody,
    });
    if (createdWorkspaceResponse.status !== 201) assert.fail(`Workspace creation failed: ${await createdWorkspaceResponse.text()}`);
    const createdWorkspace = await createdWorkspaceResponse.json() as { workspace: { id: string; name: string; root: string } };
    assert.equal(createdWorkspace.workspace.root, join(directory, "created-workspace"));
    await execFileAsync("git", ["init", "-q"], { cwd: createdWorkspace.workspace.root });
    await execFileAsync("git", ["config", "user.email", "piss@example.test"], { cwd: createdWorkspace.workspace.root });
    await execFileAsync("git", ["config", "user.name", "PISS test"], { cwd: createdWorkspace.workspace.root });
    await writeFile(join(createdWorkspace.workspace.root, "tracked.ts"), "export const value = 1;\n");
    await execFileAsync("git", ["add", "tracked.ts"], { cwd: createdWorkspace.workspace.root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: createdWorkspace.workspace.root });
    await writeFile(join(createdWorkspace.workspace.root, "tracked.ts"), "export const value = 2;\n");
    await writeFile(join(createdWorkspace.workspace.root, "untracked.md"), "# Untracked\n");

    const unauthenticatedRename = await fetch(`${base}/api/workspaces/${createdWorkspace.workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ name: "Renamed through HTTP" }),
    });
    assert.equal(unauthenticatedRename.status, 401);
    const wrongOriginRename = await fetch(`${base}/api/workspaces/${createdWorkspace.workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...identityHeaders },
      body: JSON.stringify({ name: "Renamed through HTTP" }),
    });
    assert.equal(wrongOriginRename.status, 403);
    const renamedWorkspaceResponse = await fetch(`${base}/api/workspaces/${createdWorkspace.workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ name: "Renamed through HTTP" }),
    });
    if (renamedWorkspaceResponse.status !== 200) assert.fail(`Workspace rename failed: ${await renamedWorkspaceResponse.text()}`);
    const renamedWorkspace = await renamedWorkspaceResponse.json() as { workspace: { id: string; name: string } };
    assert.equal(renamedWorkspace.workspace.id, createdWorkspace.workspace.id);
    assert.equal(renamedWorkspace.workspace.name, "Renamed through HTTP");

    const removableWorkspaceResponse = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ name: "Removable", path: directory, createDirectory: true, directoryName: "removable-workspace", trustProjectResources: false }),
    });
    if (removableWorkspaceResponse.status !== 201) assert.fail(`Removable workspace creation failed: ${await removableWorkspaceResponse.text()}`);
    const removableWorkspace = await removableWorkspaceResponse.json() as { workspace: { id: string } };
    const removedWorkspaceResponse = await fetch(`${base}/api/workspaces/${removableWorkspace.workspace.id}`, {
      method: "DELETE",
      headers: { Origin: origin, ...identityHeaders },
    });
    if (removedWorkspaceResponse.status !== 200) assert.fail(`Workspace removal failed: ${await removedWorkspaceResponse.text()}`);
    assert.deepEqual(await removedWorkspaceResponse.json(), { deleted: true });
    const workspacesAfterRemoval = await fetch(`${base}/api/workspaces`, { headers: identityHeaders });
    const workspacesAfterRemovalBody = await workspacesAfterRemoval.json() as { workspaces: Array<{ id: string }> };
    assert.ok(!workspacesAfterRemovalBody.workspaces.some((workspace) => workspace.id === removableWorkspace.workspace.id));

    const racedWorkspaceResponse = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ name: "Race", path: directory, createDirectory: true, directoryName: "race-workspace", trustProjectResources: false }),
    });
    if (racedWorkspaceResponse.status !== 201) assert.fail(`Race workspace creation failed: ${await racedWorkspaceResponse.text()}`);
    const racedWorkspace = await racedWorkspaceResponse.json() as { workspace: { id: string } };
    const [racedRemoval, racedCreation] = await Promise.all([
      fetch(`${base}/api/workspaces/${racedWorkspace.workspace.id}`, { method: "DELETE", headers: { Origin: origin, ...identityHeaders } }),
      fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
        body: JSON.stringify({ workspaceId: racedWorkspace.workspace.id, name: "Raced session" }),
      }),
    ]);
    assert.ok(
      racedRemoval.status === 200 && racedCreation.status === 404
      || racedRemoval.status === 409 && racedCreation.status === 201,
      `Unexpected workspace/session race result: remove=${racedRemoval.status}, create=${racedCreation.status}`,
    );
    if (racedCreation.status === 201) {
      const racedSession = await racedCreation.json() as { session: { id: string; runtimeId: string } };
      await fetch(`${base}/api/sessions/${racedSession.session.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
        body: JSON.stringify({ runtimeId: racedSession.session.runtimeId, action: "stop" }),
      });
      await fetch(`${base}/api/sessions/${racedSession.session.id}?runtimeId=${racedSession.session.runtimeId}`, { method: "DELETE", headers: { Origin: origin, ...identityHeaders } });
      const cleanupWorkspace = await fetch(`${base}/api/workspaces/${racedWorkspace.workspace.id}`, { method: "DELETE", headers: { Origin: origin, ...identityHeaders } });
      assert.equal(cleanupWorkspace.status, 200);
    }

    const rejected = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...identityHeaders },
      body: JSON.stringify({ workspaceId, name: "Rejected", prompt: "No origin" }),
    });
    assert.equal(rejected.status, 403);

    const createdResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id, name: "HTTP owned session", prompt: "Complete the tracer" }),
    });
    if (createdResponse.status !== 201) assert.fail(`Create failed: ${await createdResponse.text()}`);
    const created = await createdResponse.json() as { session: { id: string; runtimeId: string } };
    const occupiedWorkspaceRemoval = await fetch(`${base}/api/workspaces/${createdWorkspace.workspace.id}`, {
      method: "DELETE",
      headers: { Origin: origin, ...identityHeaders },
    });
    assert.equal(occupiedWorkspaceRemoval.status, 409);

    let summary: { status: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${base}/api/sessions`, { headers: identityHeaders });
      const body = await response.json() as { sessions: Array<{ status: string }> };
      summary = body.sessions[0];
      if (summary?.status === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(summary?.status, "finished", logs);
    const acknowledgedResponse = await fetch(`${base}/api/sessions/${created.session.id}/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId }),
    });
    assert.equal(acknowledgedResponse.status, 200);
    const acknowledged = await acknowledgedResponse.json() as { session: { status: string } };
    assert.equal(acknowledged.session.status, "idle");
    assert.equal(await readFile(join(directory, "fake-pi-cwd"), "utf8"), join(directory, "created-workspace"));
    const detailResponse = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: identityHeaders });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { session: { events: Array<{ sequence: number; type: string }> } };
    assert.ok(detail.session.events.some((event) => event.type === "message_update"));
    const latestSequence = detail.session.events.at(-1)?.sequence ?? 0;
    const incrementalDetailResponse = await fetch(`${base}/api/sessions/${created.session.id}?afterSequence=${latestSequence}`, { headers: identityHeaders });
    assert.equal(incrementalDetailResponse.status, 200);
    const incrementalDetail = await incrementalDetailResponse.json() as { session: { events: unknown[] } };
    assert.deepEqual(incrementalDetail.session.events, []);
    const invalidIncrementalDetail = await fetch(`${base}/api/sessions/${created.session.id}?afterSequence=old`, { headers: identityHeaders });
    assert.equal(invalidIncrementalDetail.status, 400);

    const eventAbort = new AbortController();
    const eventResponse = await fetch(`${base}/api/sessions/${created.session.id}/events?afterSequence=${latestSequence}`, {
      headers: identityHeaders,
      signal: eventAbort.signal,
    });
    assert.equal(eventResponse.status, 200);
    assert.match(eventResponse.headers.get("content-type") ?? "", /^text\/event-stream/u);
    const eventStream = serverSentEvents(eventResponse);
    const initialEvent = await eventStream.next();
    assert.equal(initialEvent.done, false);
    assert.equal(initialEvent.value?.id, latestSequence);
    assert.equal((initialEvent.value?.data as { reset?: boolean }).reset, false);
    const liveCommand = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "prompt", text: "Stream this update" }),
    });
    assert.equal(liveCommand.status, 202);
    let liveEvent: { readonly id: number; readonly data: unknown } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await eventStream.next();
      if (next.done) break;
      const response = next.value.data as { session?: { events?: Array<{ type?: string }> } };
      if (response.session?.events?.some((event) => event.type === "agent_settled")) {
        liveEvent = next.value;
        break;
      }
    }
    assert.ok(liveEvent, "session event stream pushes new timeline events");
    assert.ok(liveEvent.id > latestSequence);
    await eventStream.return(undefined);
    eventAbort.abort();

    const resetAbort = new AbortController();
    const resetResponse = await fetch(`${base}/api/sessions/${created.session.id}/events?afterSequence=999999`, {
      headers: identityHeaders,
      signal: resetAbort.signal,
    });
    const resetStream = serverSentEvents(resetResponse);
    const resetEvent = await resetStream.next();
    const resetPayload = resetEvent.value?.data as { reset?: boolean; session?: { events?: unknown[] } };
    assert.equal(resetPayload.reset, true);
    assert.ok((resetPayload.session?.events?.length ?? 0) > 0, "cursor mismatch falls back to a complete retained snapshot");
    await resetStream.return(undefined);
    resetAbort.abort();

    const hugeCommand = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "prompt", text: "Huge tool output" }),
    });
    assert.equal(hugeCommand.status, 202, await hugeCommand.text());
    await new Promise((resolve) => setTimeout(resolve, 750));
    const compactSnapshotResponse = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: identityHeaders });
    const compactSnapshotText = await compactSnapshotResponse.text();
    assert.ok(Buffer.byteLength(compactSnapshotText) < 512 * 1024, "normal snapshots exclude multi-megabyte tool output");
    assert.doesNotMatch(compactSnapshotText, /END-OF-HUGE-OUTPUT/u);
    const compactSnapshot = JSON.parse(compactSnapshotText) as { session: { events: Array<{ data?: { outputRef?: string; outputBytes?: number } }> } };
    const detached = compactSnapshot.session.events.find((item) => item.data?.outputRef)?.data;
    assert.ok(detached?.outputRef);
    assert.ok((detached.outputBytes ?? 0) > 2 * 1024 * 1024);
    const outputResponse = await fetch(`${base}/api/sessions/${created.session.id}/outputs/${encodeURIComponent(detached.outputRef)}`, { headers: identityHeaders });
    const outputText = await outputResponse.text();
    assert.equal(outputResponse.status, 200, outputText);
    assert.match(outputText, /END-OF-HUGE-OUTPUT/u);

    const timelineResponse = await fetch(`${base}/api/sessions/${created.session.id}/timeline?beforeSequence=999999&limit=5`, { headers: identityHeaders });
    const timelineText = await timelineResponse.text();
    assert.equal(timelineResponse.status, 200, timelineText);
    const timelinePage = JSON.parse(timelineText) as { events: Array<{ sequence: number }>; nextBeforeSequence: number | null };
    assert.ok(timelinePage.events.length > 0 && timelinePage.events.length <= 5);
    assert.deepEqual(timelinePage.events.map((item) => item.sequence), [...timelinePage.events].map((item) => item.sequence).sort((a, b) => a - b));
    assert.equal(timelinePage.nextBeforeSequence, timelinePage.events[0]?.sequence ?? null);

    const staleRename = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: "stale", name: "Must not apply" }),
    });
    assert.equal(staleRename.status, 409);
    const renameResponse = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, name: "Renamed HTTP session" }),
    });
    assert.equal(renameResponse.status, 200);
    const renamed = await renameResponse.json() as { session: { name: string } };
    assert.equal(renamed.session.name, "Renamed HTTP session");

    const reviewPath = `${base}/api/sessions/${created.session.id}/review?runtimeId=${created.session.runtimeId}`;
    const unauthenticatedReview = await fetch(reviewPath);
    assert.equal(unauthenticatedReview.status, 401);
    const staleReview = await fetch(`${base}/api/sessions/${created.session.id}/review?runtimeId=stale`, { headers: identityHeaders });
    assert.equal(staleReview.status, 409);
    const reviewResponse = await fetch(reviewPath, { headers: identityHeaders });
    if (reviewResponse.status !== 200) assert.fail(`Review failed: ${await reviewResponse.text()}`);
    const reviewBody = await reviewResponse.json() as { review: { totalFiles: number; files: Array<{ path: string; patch: string }> } };
    assert.equal(reviewBody.review.totalFiles, 2);
    assert.deepEqual(reviewBody.review.files.map((file) => file.path).sort(), ["tracked.ts", "untracked.md"]);
    assert.match(reviewBody.review.files.find((file) => file.path === "tracked.ts")?.patch ?? "", /-export const value = 1;/);
    assert.match(reviewBody.review.files.find((file) => file.path === "tracked.ts")?.patch ?? "", /\+export const value = 2;/);
    assert.doesNotMatch(JSON.stringify(reviewBody), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const filterMarker = join(directory, "filter-command-ran");
    await writeFile(join(createdWorkspace.workspace.root, ".gitattributes"), "tracked.ts filter=unsafe\n");
    await execFileAsync("git", ["config", "filter.unsafe.clean", `touch ${filterMarker}; cat`], { cwd: createdWorkspace.workspace.root });
    const filteredReview = await fetch(reviewPath, { headers: identityHeaders });
    assert.equal(filteredReview.status, 422);
    assert.match(await filteredReview.text(), /executable Git filters/i);
    await assert.rejects(readFile(filterMarker));
    await execFileAsync("git", ["config", "--unset-all", "filter.unsafe.clean"], { cwd: createdWorkspace.workspace.root });
    await rm(join(createdWorkspace.workspace.root, ".gitattributes"));

    const outsideRepository = join(directory, "outside-repository");
    await mkdir(outsideRepository);
    await execFileAsync("git", ["init", "-q"], { cwd: outsideRepository });
    await execFileAsync("git", ["config", "user.email", "piss@example.test"], { cwd: outsideRepository });
    await execFileAsync("git", ["config", "user.name", "PISS test"], { cwd: outsideRepository });
    await writeFile(join(outsideRepository, "private.txt"), "outside workspace secret\n");
    await execFileAsync("git", ["add", "private.txt"], { cwd: outsideRepository });
    await execFileAsync("git", ["commit", "-qm", "outside"], { cwd: outsideRepository });
    await rename(join(createdWorkspace.workspace.root, ".git"), join(createdWorkspace.workspace.root, ".git-saved"));
    await symlink(join(outsideRepository, ".git"), join(createdWorkspace.workspace.root, ".git"), "dir");
    const escapedReview = await fetch(reviewPath, { headers: identityHeaders });
    assert.equal(escapedReview.status, 422);
    assert.doesNotMatch(await escapedReview.text(), /outside workspace secret/);
    await rm(join(createdWorkspace.workspace.root, ".git"));
    await rename(join(createdWorkspace.workspace.root, ".git-saved"), join(createdWorkspace.workspace.root, ".git"));

    const savedWorkspaceGit = join(directory, "workspace-git-saved");
    await rename(join(createdWorkspace.workspace.root, ".git"), savedWorkspaceGit);
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "piss@example.test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "PISS test"], { cwd: directory });
    await execFileAsync("git", ["add", "created-workspace/tracked.ts"], { cwd: directory });
    await execFileAsync("git", ["commit", "-qm", "parent repository"], { cwd: directory });
    await writeFile(join(createdWorkspace.workspace.root, "tracked.ts"), "export const value = 3;\n");
    const parentReviewResponse = await fetch(reviewPath, { headers: identityHeaders });
    if (parentReviewResponse.status !== 200) assert.fail(`Parent review failed: ${await parentReviewResponse.text()}`);
    const parentReview = await parentReviewResponse.json() as { review: { files: Array<{ path: string; patch: string }> } };
    assert.ok(parentReview.review.files.every((file) => !file.path.startsWith("../")));
    assert.match(parentReview.review.files.find((file) => file.path === "tracked.ts")?.patch ?? "", /\+export const value = 3;/);
    await rm(join(directory, ".git"), { recursive: true });
    await rename(savedWorkspaceGit, join(createdWorkspace.workspace.root, ".git"));
    await writeFile(join(createdWorkspace.workspace.root, "tracked.ts"), "export const value = 2;\n");

    const originalCheckout = `${createdWorkspace.workspace.root}-original`;
    await rename(createdWorkspace.workspace.root, originalCheckout);
    await mkdir(createdWorkspace.workspace.root);
    await execFileAsync("git", ["init", "-q"], { cwd: createdWorkspace.workspace.root });
    const replacedReview = await fetch(reviewPath, { headers: identityHeaders });
    assert.equal(replacedReview.status, 422);
    assert.match(await replacedReview.text(), /checkout changed on disk/i);
    await rm(createdWorkspace.workspace.root, { recursive: true });
    await rename(originalCheckout, createdWorkspace.workspace.root);

    await writeFile(join(directory, "created-workspace", "mention-target.ts"), "export const mentionTarget = true;\n");
    const unauthenticatedMentions = await fetch(`${base}/api/sessions/${created.session.id}/mentions?runtimeId=${created.session.runtimeId}&query=mention`);
    assert.equal(unauthenticatedMentions.status, 401);
    const staleMentions = await fetch(`${base}/api/sessions/${created.session.id}/mentions?runtimeId=stale&query=mention`, { headers: identityHeaders });
    assert.equal(staleMentions.status, 409);
    const mentionsResponse = await fetch(`${base}/api/sessions/${created.session.id}/mentions?runtimeId=${created.session.runtimeId}&query=mention`, { headers: identityHeaders });
    if (mentionsResponse.status !== 200) assert.fail(`Mention search failed: ${await mentionsResponse.text()}`);
    const mentions = await mentionsResponse.json() as { mentions: Array<{ path: string; kind: string }> };
    assert.ok(mentions.mentions.some((mention) => mention.path === "mention-target.ts" && mention.kind === "file"));

    const unauthenticatedModels = await fetch(`${base}/api/sessions/${created.session.id}/models?runtimeId=${created.session.runtimeId}`);
    assert.equal(unauthenticatedModels.status, 401);
    const staleModels = await fetch(`${base}/api/sessions/${created.session.id}/models?runtimeId=stale`, { headers: identityHeaders });
    assert.equal(staleModels.status, 409);
    const modelsResponse = await fetch(`${base}/api/sessions/${created.session.id}/models?runtimeId=${created.session.runtimeId}`, { headers: identityHeaders });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as { models: Array<{ id: string; thinkingLevels: string[] }> };
    assert.deepEqual(models.models.map((model) => model.id), ["model-a", "model-b"]);
    assert.deepEqual(models.models[0]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);

    const unauthenticatedCommands = await fetch(`${base}/api/sessions/${created.session.id}/commands?runtimeId=${created.session.runtimeId}`);
    assert.equal(unauthenticatedCommands.status, 401);
    const staleCommands = await fetch(`${base}/api/sessions/${created.session.id}/commands?runtimeId=stale`, { headers: identityHeaders });
    assert.equal(staleCommands.status, 409);
    const commandsResponse = await fetch(`${base}/api/sessions/${created.session.id}/commands?runtimeId=${created.session.runtimeId}`, { headers: identityHeaders });
    if (commandsResponse.status !== 200) assert.fail(`Command catalog failed: ${await commandsResponse.text()}`);
    assert.deepEqual(await commandsResponse.json(), { commands: [{ name: "review", description: "Review through HTTP", source: "extension", scope: "project" }] });

    const thinkingMutation = JSON.stringify({ runtimeId: created.session.runtimeId, action: "setThinkingLevel", level: "high" });
    const unauthenticatedConfiguration = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: thinkingMutation,
    });
    assert.equal(unauthenticatedConfiguration.status, 401);
    const wrongOriginConfiguration = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...identityHeaders },
      body: thinkingMutation,
    });
    assert.equal(wrongOriginConfiguration.status, 403);
    const staleConfiguration = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: "stale", action: "setThinkingLevel", level: "high" }),
    });
    assert.equal(staleConfiguration.status, 409);
    const thinkingResponse = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: thinkingMutation,
    });
    if (thinkingResponse.status !== 200) assert.fail(`Thinking configuration failed: ${await thinkingResponse.text()}`);
    const thinking = await thinkingResponse.json() as { session: { thinkingLevel: string } };
    assert.equal(thinking.session.thinkingLevel, "high");

    const modelResponse = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "setModel", provider: "http", modelId: "model-b" }),
    });
    if (modelResponse.status !== 200) assert.fail(`Model configuration failed: ${await modelResponse.text()}`);
    const configured = await modelResponse.json() as { session: { model: { id: string }; thinkingLevel: string } };
    assert.equal(configured.session.model.id, "model-b");
    assert.equal(configured.session.thinkingLevel, "off");
    const configuredDetail = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: identityHeaders });
    assert.doesNotMatch(await configuredDetail.text(), /super-secret|credential@example/);

    const usageResponse = await fetch(`${base}/api/sessions/${created.session.id}/stats?runtimeId=${created.session.runtimeId}`, { headers: identityHeaders });
    assert.equal(usageResponse.status, 200);
    const usage = await usageResponse.json() as { session: { usage: { cost: number; contextUsage: { percent: number } } } };
    assert.equal(usage.session.usage.cost, 0.25);
    assert.equal(usage.session.usage.contextUsage.percent, 15);
    const autoCompactionResponse = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "setAutoCompaction", enabled: false }),
    });
    assert.equal(autoCompactionResponse.status, 200);
    const autoCompaction = await autoCompactionResponse.json() as { session: { autoCompactionEnabled: boolean } };
    assert.equal(autoCompaction.session.autoCompactionEnabled, false);
    const compactionResponse = await fetch(`${base}/api/sessions/${created.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "compact" }),
    });
    assert.equal(compactionResponse.status, 200);
    const compaction = await compactionResponse.json() as { session: { compaction: { status: string; tokensBefore: number; estimatedTokensAfter: number } } };
    assert.equal(compaction.session.compaction.status, "succeeded");
    assert.equal(compaction.session.compaction.tokensBefore, 30000);
    assert.equal(compaction.session.compaction.estimatedTokensAfter, 9000);

    const siblingResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id, name: "Sibling session" }),
    });
    if (siblingResponse.status !== 201) assert.fail(`Sibling session creation failed: ${await siblingResponse.text()}`);
    const sibling = await siblingResponse.json() as { session: { id: string; runtimeId: string; workspaceId: string; status: string } };
    assert.equal(sibling.session.workspaceId, createdWorkspace.workspace.id);
    assert.equal(sibling.session.status, "idle");

    const unauthenticatedDelete = await fetch(`${base}/api/sessions/${created.session.id}?runtimeId=${created.session.runtimeId}`, {
      method: "DELETE",
      headers: { Origin: origin },
    });
    assert.equal(unauthenticatedDelete.status, 401);
    const crossOriginDelete = await fetch(`${base}/api/sessions/${created.session.id}?runtimeId=${created.session.runtimeId}`, {
      method: "DELETE",
      headers: { Origin: "https://evil.example", ...identityHeaders },
    });
    assert.equal(crossOriginDelete.status, 403);
    const staleDelete = await fetch(`${base}/api/sessions/${created.session.id}?runtimeId=stale-runtime`, {
      method: "DELETE",
      headers: { Origin: origin, ...identityHeaders },
    });
    assert.equal(staleDelete.status, 409);
    const archiveTargetResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id, name: "Archive while active" }),
    });
    if (archiveTargetResponse.status !== 201) assert.fail(`Archive target creation failed: ${await archiveTargetResponse.text()}`);
    const archiveTarget = await archiveTargetResponse.json() as { session: { id: string; runtimeId: string; status: string } };
    assert.equal(archiveTarget.session.status, "idle");
    const activeArchive = await fetch(`${base}/api/sessions/${archiveTarget.session.id}?runtimeId=${archiveTarget.session.runtimeId}`, {
      method: "DELETE",
      headers: { Origin: origin, ...identityHeaders },
    });
    if (activeArchive.status !== 200) assert.fail(`Active session archive failed: ${await activeArchive.text()}`);
    assert.deepEqual(await activeArchive.json(), { deleted: true });
    const archivedDetail = await fetch(`${base}/api/sessions/${archiveTarget.session.id}`, { headers: identityHeaders });
    assert.equal(archivedDetail.status, 404);

    const stale = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: "stale", action: "abort" }),
    });
    assert.equal(stale.status, 409);

    const stopped = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "stop" }),
    });
    assert.equal(stopped.status, 202, await stopped.text());
    const resumedResponse = await fetch(`${base}/api/sessions/${created.session.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId }),
    });
    if (resumedResponse.status !== 200) assert.fail(`Resume failed: ${await resumedResponse.text()}`);
    const resumed = await resumedResponse.json() as { session: { runtimeId: string; events: Array<{ type: string }> } };
    assert.notEqual(resumed.session.runtimeId, created.session.runtimeId);
    assert.ok(resumed.session.events.some((event) => event.type === "message_end"));
    const staleAfterResume = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: created.session.runtimeId, action: "abort" }),
    });
    assert.equal(staleAfterResume.status, 409);
    const restopped = await fetch(`${base}/api/sessions/${created.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: resumed.session.runtimeId, action: "stop" }),
    });
    assert.equal(restopped.status, 202, await restopped.text());
    const deleted = await fetch(`${base}/api/sessions/${created.session.id}?runtimeId=${resumed.session.runtimeId}`, {
      method: "DELETE",
      headers: { Origin: origin, ...identityHeaders },
    });
    if (deleted.status !== 200) assert.fail(`Session deletion failed: ${await deleted.text()}`);
    assert.deepEqual(await deleted.json(), { deleted: true });
    const deletedDetail = await fetch(`${base}/api/sessions/${created.session.id}`, { headers: identityHeaders });
    assert.equal(deletedDetail.status, 404);
    const sessionsAfterDelete = await fetch(`${base}/api/sessions`, { headers: identityHeaders });
    const sessionsAfterDeleteBody = await sessionsAfterDelete.json() as { sessions: Array<{ id: string }> };
    assert.ok(!sessionsAfterDeleteBody.sessions.some((session) => session.id === created.session.id));

    const siblingStopped = await fetch(`${base}/api/sessions/${sibling.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: sibling.session.runtimeId, action: "stop" }),
    });
    assert.equal(siblingStopped.status, 202, await siblingStopped.text());

    const emptyResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id, name: "" }),
    });
    if (emptyResponse.status !== 201) assert.fail(`Empty session creation failed: ${await emptyResponse.text()}`);
    const empty = await emptyResponse.json() as { session: { id: string; runtimeId: string; name: string; status: string; events: unknown[] } };
    assert.equal(empty.session.name, "New session");
    assert.equal(empty.session.status, "idle");
    assert.deepEqual(empty.session.events, []);

    const firstPrompt = await fetch(`${base}/api/sessions/${empty.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({
        runtimeId: empty.session.runtimeId,
        action: "prompt",
        text: "Sent after startup",
        images: [{
          mediaType: "image/png",
          name: "pixel.png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        }],
      }),
    });
    assert.equal(firstPrompt.status, 202, await firstPrompt.text());
    const configurationWhileWorking = await fetch(`${base}/api/sessions/${empty.session.id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: empty.session.runtimeId, action: "setThinkingLevel", level: "low" }),
    });
    assert.equal(configurationWhileWorking.status, 409);
    for (const [action, text] of [["steer", "Steer while working"], ["followUp", "Follow up after settling"]] as const) {
      const queued = await fetch(`${base}/api/sessions/${empty.session.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
        body: JSON.stringify({ runtimeId: empty.session.runtimeId, action, text }),
      });
      assert.equal(queued.status, 202, `${action} failed: ${await queued.text()}`);
    }
    let emptyEvents: Array<{ type: string; data: unknown }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${base}/api/sessions/${empty.session.id}`, { headers: identityHeaders });
      const body = await response.json() as { session: { events: Array<{ type: string; data: unknown }> } };
      emptyEvents = body.session.events;
      if (emptyEvents.some((event) => event.type === "message_update")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(emptyEvents.some((event) => event.type === "message_update"));
    const imageEvent = emptyEvents.find((event) => event.type === "message_end" && JSON.stringify(event.data).includes("image/png"));
    assert.ok(imageEvent, "Pi should receive and project the image message");
    assert.doesNotMatch(JSON.stringify(imageEvent.data), /iVBORw0KGgo/);

    const interactiveCreate = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id, name: "Interactive HTTP" }),
    });
    const interactive = await interactiveCreate.json() as { session: { id: string; runtimeId: string } };
    const interactivePrompt = await fetch(`${base}/api/sessions/${interactive.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: interactive.session.runtimeId, commandId: "interactive-command", action: "prompt", text: "Request interactive input" }),
    });
    assert.equal(interactivePrompt.status, 202);
    let blocked: { status: string; interactiveRequests: Array<{ id: string; method: string }> } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${base}/api/sessions/${interactive.session.id}`, { headers: identityHeaders });
      blocked = (await response.json() as { session: typeof blocked }).session;
      if (blocked?.status === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.interactiveRequests.length, 1);
    assert.equal(blocked?.interactiveRequests[0]?.id, "http-request-confirm");
    assert.equal(blocked?.interactiveRequests[0]?.method, "confirm");
    const staleInteractiveResponse = await fetch(`${base}/api/sessions/${interactive.session.id}/interactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: "stale", requestId: "http-request-confirm", confirmed: true }),
    });
    assert.equal(staleInteractiveResponse.status, 409);
    const invalidInteractiveResponse = await fetch(`${base}/api/sessions/${interactive.session.id}/interactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: interactive.session.runtimeId, requestId: "http-request-confirm", value: "wrong shape" }),
    });
    assert.equal(invalidInteractiveResponse.status, 409);
    const answeredInteractive = await fetch(`${base}/api/sessions/${interactive.session.id}/interactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: interactive.session.runtimeId, requestId: "http-request-confirm", confirmed: true }),
    });
    if (answeredInteractive.status !== 200) assert.fail(`Interactive response failed: ${await answeredInteractive.text()}`);
    const answeredBody = await answeredInteractive.json() as { session: { interactiveRequests: unknown[] } };
    assert.deepEqual(answeredBody.session.interactiveRequests, []);
    const stopInteractive = await fetch(`${base}/api/sessions/${interactive.session.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ runtimeId: interactive.session.runtimeId, action: "stop" }),
    });
    assert.equal(stopInteractive.status, 202);

    const importedSessionFile = join(directory, "http-import.jsonl");
    await writeFile(importedSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "http-imported-pi-session", timestamp: new Date().toISOString(), cwd: directory })}\n`);
    const unauthenticatedImport = await fetch(`${base}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, name: "Imported through HTTP", sessionFile: importedSessionFile }),
    });
    assert.equal(unauthenticatedImport.status, 401);
    const importResponse = await fetch(`${base}/api/sessions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...identityHeaders },
      body: JSON.stringify({ workspaceId, name: "Imported through HTTP", sessionFile: importedSessionFile }),
    });
    if (importResponse.status !== 201) assert.fail(`Import failed: ${await importResponse.text()}`);
    const imported = await importResponse.json() as { session: { id: string; runtimeId: string; status: string; piSessionId: string } };
    assert.equal(imported.session.status, "stopped");
    assert.equal(imported.session.piSessionId, "http-imported-pi-session");
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    await rm(directory, { recursive: true, force: true });
  }
});
