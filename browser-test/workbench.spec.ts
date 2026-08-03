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
  workflow: null | {
    id: string;
    phase: "defining" | "awaitingSpecApproval" | "planning" | "awaitingPlanApproval" | "building" | "verifying" | "reviewing" | "repairing" | "readyToShip" | "accepted" | "blocked" | "cancelled" | "failed";
    objective: string;
    repairAttempts: number;
    maxRepairAttempts: number;
    specification: string | null;
    plan: string | null;
    checkpoint: null | { stage: "define" | "plan" | "build" | "verify" | "review"; outcome: "ready" | "passed" | "failed" | "blocked"; summary: string; artifact: string | null; toolCallId: string; sequence: number; receivedAt: string };
    blockedFromPhase: string | null;
    queuedIntervention?: string;
    executionAuthority?: { mode: "approved_plan"; grantedAt: string };
    supervisor?: {
      sessionId: string;
      status: "idle" | "consulting";
      consultations: number;
      blockerFingerprint: string | null;
      repeatedBlockerCount: number;
      pendingGuidance: string | null;
      lastAdvice: null | { action: "resume_with_guidance" | "retry_transient" | "enter_repair" | "human_authority_required" | "unsafe_stop"; problem?: string; summary: string; guidance: string | null; basis: string; receivedAt: string };
    };
    createdAt: string;
    updatedAt: string;
    error: string | null;
  };
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

async function installApi(page: Page, options: { readonly empty?: boolean; readonly emptyReview?: boolean; readonly notifications?: boolean; readonly delaySessionCreationMs?: number } = {}) {
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
  const workflowMutations: Array<Record<string, unknown>> = [];
  const sessionLoads: Array<{ readonly sessionId: string; readonly afterSequence?: number }> = [];
  let failNextCommand = false;
  let delayNextCommand = false;
  let delayNextWorkflowMutationMs = 0;
  let delayNextMentionSearch = false;
  let delayedSessionLoadId: string | undefined;
  let delayedSessionLoadMs = 500;
  let historicalEvents: Array<{ readonly sequence: number; readonly type: string; readonly timestamp: string; readonly data: unknown }> = [];
  const detachedOutputs = new Map<string, unknown>();
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
      if (options.delaySessionCreationMs) await new Promise((resolve) => setTimeout(resolve, options.delaySessionCreationMs));
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
        workflow: null,
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
    if (session && path === `/api/sessions/${session.id}/timeline` && method === "GET") {
      const before = Number(url.searchParams.get("beforeSequence") ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const candidates = historicalEvents.filter((event) => event.sequence < before).sort((left, right) => left.sequence - right.sequence);
      const page = candidates.slice(-limit);
      await route.fulfill({ json: { events: page, hasMore: candidates.length > page.length, nextBeforeSequence: page[0]?.sequence ?? null } });
      return;
    }
    if (session && path.startsWith(`/api/sessions/${session.id}/artifacts/`) && (method === "GET" || method === "HEAD")) {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      await route.fulfill({ status: 200, contentType: "image/png", headers: { "cache-control": "private, no-store" }, body: method === "HEAD" ? "" : png });
      return;
    }
    if (session && path.startsWith(`/api/sessions/${session.id}/outputs/`) && method === "GET") {
      const ref = decodeURIComponent(path.slice(`/api/sessions/${session.id}/outputs/`.length));
      const value = detachedOutputs.get(ref);
      if (value === undefined) await route.fulfill({ status: 404, json: { error: "output not found" } });
      else await route.fulfill({ json: { ref, byteCount: Buffer.byteLength(JSON.stringify(value)), value } });
      return;
    }
    if (session && path === `/api/sessions/${session.id}` && method === "GET") {
      const afterSequenceParameter = url.searchParams.get("afterSequence");
      const afterSequence = afterSequenceParameter === null ? undefined : Number(afterSequenceParameter);
      sessionLoads.push({ sessionId: session.id, ...(afterSequence === undefined ? {} : { afterSequence }) });
      if (delayedSessionLoadId === session.id) {
        delayedSessionLoadId = undefined;
        await new Promise((resolve) => setTimeout(resolve, delayedSessionLoadMs));
      }
      const events = afterSequence === undefined
        ? session.events
        : session.events.filter((event) => typeof event === "object" && event !== null && "sequence" in event && typeof event.sequence === "number" && event.sequence > afterSequence);
      await route.fulfill({ json: { session: { ...session, events } } });
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
    if (session && path === `/api/sessions/${session.id}/workflow` && method === "POST") {
      const timestamp = new Date().toISOString();
      const workflowMutationDelay = delayNextWorkflowMutationMs;
      delayNextWorkflowMutationMs = 0;
      workflowMutations.push(body ?? {});
      let workflow = session.workflow;
      if (body?.action === "start") {
        const specification = `# Specification\n\n${Array.from({ length: 40 }, (_, index) => `${index + 1}. Verify a durable, accessible workflow acceptance criterion.`).join("\n")}`;
        workflow = {
          id: "browser-workflow-1",
          phase: "awaitingSpecApproval",
          objective: typeof body.objective === "string" ? body.objective : "Build the workflow",
          repairAttempts: 0,
          maxRepairAttempts: typeof body.maxRepairAttempts === "number" ? body.maxRepairAttempts : 3,
          specification,
          plan: null,
          checkpoint: { stage: "define", outcome: "ready", summary: "Specification is ready for approval", artifact: specification, toolCallId: "define-checkpoint", sequence: 1, receivedAt: timestamp },
          blockedFromPhase: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          error: null,
        };
      } else if (workflow && body?.action === "approve" && workflow.phase === "awaitingSpecApproval") {
        workflow = { ...workflow, phase: "planning", updatedAt: timestamp };
      } else if (workflow && body?.action === "approve" && workflow.phase === "awaitingPlanApproval") {
        workflow = { ...workflow, phase: "readyToShip", executionAuthority: { mode: "approved_plan", grantedAt: timestamp }, checkpoint: { stage: "review", outcome: "passed", summary: "Build, verification, and review passed", artifact: null, toolCallId: "review-checkpoint", sequence: 5, receivedAt: timestamp }, updatedAt: timestamp };
      } else if (workflow && body?.action === "accept" && workflow.phase === "readyToShip") {
        workflow = { ...workflow, phase: "accepted", updatedAt: timestamp };
      } else if (workflow && body?.action === "intervene") {
        workflow = {
          ...workflow,
          ...(session.status === "working" ? {} : { queuedIntervention: String(body.feedback ?? "Queued guidance") }),
          updatedAt: timestamp,
        };
      } else if (workflow && body?.action === "resume" && ((workflow.phase === "blocked" && workflow.blockedFromPhase) || (workflow.phase === "cancelled" && workflow.error?.includes("runtime stopped")))) {
        workflow = {
          ...workflow,
          phase: (workflow.phase === "blocked" ? workflow.blockedFromPhase : "building") as NonNullable<TestSession["workflow"]>["phase"],
          blockedFromPhase: null,
          error: null,
          updatedAt: timestamp,
        };
      } else if (workflow && body?.action === "continueRepairs" && workflow.phase === "failed") {
        workflow = {
          ...workflow,
          phase: "repairing",
          maxRepairAttempts: Math.max(workflow.maxRepairAttempts, workflow.repairAttempts) + Number(body.additionalRepairAttempts ?? 1),
          error: null,
          updatedAt: timestamp,
        };
      } else if (workflow && body?.action === "cancel") {
        workflow = { ...workflow, phase: "cancelled", updatedAt: timestamp };
      }
      const updated = { ...session, status: body?.action === "continueRepairs" || body?.action === "resume" ? "working" as const : "finished" as const, workflow, lastActivityAt: timestamp };
      sessions[sessionIndex] = updated;
      if (workflowMutationDelay > 0) await new Promise((resolve) => setTimeout(resolve, workflowMutationDelay));
      await route.fulfill({ json: { session: updated } });
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
      if (body?.text === "/review") {
        const latest = session.events.at(-1) as { readonly sequence?: unknown } | undefined;
        const sequence = (typeof latest?.sequence === "number" ? latest.sequence : 0) + 1;
        sessions[sessionIndex] = { ...session, events: [...session.events, {
          sequence,
          type: "extension_ui_request",
          timestamp: new Date().toISOString(),
          data: { method: "notify", message: "Review extension output", notifyType: "info" },
        }], lastActivityAt: new Date().toISOString() };
      }
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
    workflowMutations,
    sessionLoads,
    setStatus(status: SessionStatus) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, status, lastActivityAt: new Date().toISOString() };
    },
    setStatusFor(name: string, status: SessionStatus) {
      const index = sessions.findIndex((session) => session.name === name);
      if (index >= 0) sessions[index] = { ...sessions[index]!, status, lastActivityAt: new Date().toISOString() };
    },
    setWorkflowPhase(phase: NonNullable<TestSession["workflow"]>["phase"]) {
      if (sessions.length === 0 || !sessions.at(-1)!.workflow) return;
      const timestamp = new Date().toISOString();
      const workflow = sessions.at(-1)!.workflow!;
      sessions[sessions.length - 1] = {
        ...sessions.at(-1)!,
        status: "finished",
        workflow: phase === "awaitingPlanApproval"
          ? { ...workflow, phase, plan: "# Complete delivery plan\n\nImplement every approved criterion through ordered vertical slices.", checkpoint: { stage: "plan", outcome: "ready", summary: "Complete delivery plan is ready for approval", artifact: "# Complete delivery plan\n\nImplement every approved criterion through ordered vertical slices.", toolCallId: "plan-checkpoint", sequence: 2, receivedAt: timestamp }, updatedAt: timestamp }
          : { ...workflow, phase, updatedAt: timestamp },
        lastActivityAt: timestamp,
      };
    },
    setWorkflowBlocked(summary = "Build needs an operator-approved production procedure", supervisorConsulting = false) {
      if (sessions.length === 0 || !sessions.at(-1)!.workflow) return;
      const timestamp = new Date().toISOString();
      const current = sessions.at(-1)!;
      sessions[sessions.length - 1] = {
        ...current,
        status: "finished",
        workflow: {
          ...current.workflow!,
          phase: "blocked",
          blockedFromPhase: "building",
          checkpoint: { stage: "build", outcome: "blocked", summary, artifact: null, toolCallId: "blocked-build", sequence: 7, receivedAt: timestamp },
          supervisor: {
            sessionId: "supervisor-session-1",
            status: supervisorConsulting ? "consulting" as const : "idle" as const,
            consultations: 1,
            blockerFingerprint: "blocker-fingerprint",
            repeatedBlockerCount: 1,
            pendingGuidance: null,
            lastAdvice: supervisorConsulting ? null : {
              action: "human_authority_required" as const,
              problem: "The workflow needs your permission before it deploys the production revision.",
              summary,
              guidance: null,
              basis: "The approved plan requires operator confirmation before deployment.",
              receivedAt: timestamp,
            },
          },
          updatedAt: timestamp,
          error: summary,
        },
        lastActivityAt: timestamp,
      };
    },
    setWorkflowRuntimeCancelled() {
      if (sessions.length === 0 || !sessions.at(-1)!.workflow) return;
      const timestamp = new Date().toISOString();
      const current = sessions.at(-1)!;
      sessions[sessions.length - 1] = {
        ...current,
        status: "working",
        workflow: {
          ...current.workflow!,
          phase: "cancelled",
          blockedFromPhase: null,
          error: "The workflow was cancelled when its runtime stopped",
          updatedAt: timestamp,
        },
        lastActivityAt: timestamp,
      };
    },
    setWorkflowFailure(repairAttempts = 3, maxRepairAttempts = 2) {
      if (sessions.length === 0 || !sessions.at(-1)!.workflow) return;
      const timestamp = new Date().toISOString();
      const current = sessions.at(-1)!;
      sessions[sessions.length - 1] = {
        ...current,
        status: "finished",
        workflow: {
          ...current.workflow!,
          phase: "failed",
          repairAttempts,
          maxRepairAttempts,
          checkpoint: { stage: "review", outcome: "failed", summary: "Final review found blocking durability defects", artifact: null, toolCallId: "failed-review", sequence: 9, receivedAt: timestamp },
          updatedAt: timestamp,
          error: "Repair budget exhausted: blocking durability defects remain",
        },
        lastActivityAt: timestamp,
      };
    },
    setWorkflowPhaseFor(name: string, phase: NonNullable<TestSession["workflow"]>["phase"]) {
      const index = sessions.findIndex((session) => session.name === name);
      if (index < 0) return;
      const timestamp = new Date().toISOString();
      sessions[index] = {
        ...sessions[index]!,
        workflow: {
          id: `workflow-${sessions[index]!.id}`,
          phase,
          objective: "Exercise the session workflow badge",
          repairAttempts: 0,
          maxRepairAttempts: 2,
          specification: null,
          plan: null,
          checkpoint: null,
          blockedFromPhase: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          error: null,
        },
        lastActivityAt: timestamp,
      };
    },
    setInteractiveRequests(requests: TestSession["interactiveRequests"]) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, status: requests.length > 0 ? "blocked" : "working", interactiveRequests: requests, lastActivityAt: new Date().toISOString() };
    },
    setEvents(events: unknown[]) {
      if (sessions.length > 0) sessions[sessions.length - 1] = { ...sessions.at(-1)!, events, lastActivityAt: new Date().toISOString() };
    },
    setEventsFor(name: string, events: unknown[]) {
      const index = sessions.findIndex((session) => session.name === name);
      if (index >= 0) sessions[index] = { ...sessions[index]!, events, lastActivityAt: new Date().toISOString() };
    },
    setHistoricalEvents(events: typeof historicalEvents) {
      historicalEvents = events;
    },
    setDetachedOutput(ref: string, value: unknown) {
      detachedOutputs.set(ref, value);
    },
    failNextCommand() {
      failNextCommand = true;
    },
    delayAndFailNextCommand() {
      delayNextCommand = true;
      failNextCommand = true;
    },
    delayNextWorkflowMutation(milliseconds: number) {
      delayNextWorkflowMutationMs = milliseconds;
    },
    delayNextMentionSearch() {
      delayNextMentionSearch = true;
    },
    delaySessionLoad(name: string, delayMs = 500) {
      delayedSessionLoadId = sessions.find((session) => session.name === name)?.id;
      delayedSessionLoadMs = delayMs;
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

test("desktop keeps session navigation left of the active chat", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  await expect(page.getByLabel("Message Pi")).toBeVisible();

  const layout = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".rail")!.getBoundingClientRect();
    const workspace = document.querySelector<HTMLElement>(".workspace")!.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
    return {
      railLeft: rail.left,
      railRight: rail.right,
      railWidth: rail.width,
      workspaceLeft: workspace.left,
      workspaceRight: workspace.right,
      composerLeft: composer.left,
    };
  });

  expect(layout.railLeft).toBe(0);
  expect(layout.railWidth).toBe(320);
  expect(layout.workspaceLeft).toBe(layout.railRight);
  expect(layout.workspaceRight).toBe(1180);
  expect(layout.composerLeft).toBeGreaterThanOrEqual(layout.workspaceLeft);
});

test("mobile session creation stays content-sized while the request is pending", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page, { delaySessionCreationMs: 600 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();

  const dialog = page.getByRole("dialog", { name: "New session" });
  await expect(dialog).toHaveClass(/modal-surface-content/);
  const initialBounds = await dialog.boundingBox();
  expect(initialBounds?.height).toBeLessThan(420);
  expect(initialBounds?.y).toBeGreaterThan(150);

  await dialog.getByRole("button", { name: /start session/i }).click();
  await expect(dialog.getByRole("button", { name: /starting/i })).toBeVisible();
  const pendingBounds = await dialog.boundingBox();
  expect(pendingBounds?.height).toBeLessThan(420);
  expect(Math.abs((pendingBounds?.height ?? 0) - (initialBounds?.height ?? 0))).toBeLessThanOrEqual(2);
  await expect(dialog).toBeHidden();
});

test("browser evidence renders inline and remains contained on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  api.setEvents([{
    sequence: 1,
    type: "browser_artifact_created",
    timestamp: "2026-04-15T10:00:00.000Z",
    data: { artifact: {
      id: "2c240f9a-6091-49a9-bcfa-0c49e6e3aa41",
      kind: "browser-screenshot",
      mediaType: "image/png",
      byteCount: 68,
      width: 390,
      height: 844,
      pageUrl: "http://127.0.0.1:4000/settings",
      pageTitle: "Settings",
      label: "Mobile settings",
      createdAt: "2026-04-15T10:00:00.000Z",
    } },
  }]);
  await page.reload();

  const evidence = page.locator(".browser-evidence");
  await expect(evidence).toBeVisible();
  await expect(evidence.getByRole("img", { name: "Mobile settings" })).toBeVisible();
  await expect(evidence).toContainText("390 × 844");
  await expect(evidence.getByRole("link", { name: "DOWNLOAD" })).toHaveAttribute("download", /browser-evidence-/);
  const bounds = await evidence.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});

test("browser video evidence uses bounded native controls on a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  api.setEvents([{
    sequence: 1, type: "browser_artifact_created", timestamp: "2026-04-15T10:00:00.000Z",
    data: { artifact: {
      id: "663dd98b-a517-48f6-a85d-639ae76077e9", kind: "browser-video", mediaType: "video/webm", byteCount: 8192,
      width: 800, height: 600, durationMs: 1250, pageUrl: "http://127.0.0.1:4000/demo", pageTitle: "Demo",
      label: "Interaction sequence", createdAt: "2026-04-15T10:00:00.000Z",
    } },
  }]);
  await page.reload();

  const evidence = page.locator(".browser-video-evidence");
  await expect(evidence).toBeVisible();
  const video = evidence.getByLabel("Browser recording: Interaction sequence");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("playsinline", "");
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect(evidence).toContainText("1.3s");
  await expect(evidence.getByRole("link", { name: "DOWNLOAD" })).toHaveAttribute("download", /\.webm$/);
  const bounds = await evidence.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
});

test("workflow-phase badge stays accessible and contained in desktop and mobile session navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const api = await installApi(page);
  await page.goto("/");

  const verifyingName = "Verification session with a deliberately long descriptive title";
  const approvalName = "Specification approval session with another deliberately long title";
  await page.evaluate(async ({ names }) => {
    for (const name of names) {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "erp-deadbeef", name }),
      });
    }
  }, { names: [verifyingName, approvalName, "Plain session", "Terminal session"] });
  api.setWorkflowPhaseFor(verifyingName, "verifying");
  api.setWorkflowPhaseFor(approvalName, "awaitingSpecApproval");
  api.setWorkflowPhaseFor("Terminal session", "readyToShip");
  await page.reload();

  const sessionCard = (name: string) => page.locator(".session-card").filter({ hasText: name });
  const verifyingCard = sessionCard(verifyingName);
  const approvalCard = sessionCard(approvalName);
  await expect(verifyingCard.locator(".workflow-phase-badge")).toHaveText("LOOP · VERIFY");
  await expect(verifyingCard).toHaveAccessibleName(/LOOP · VERIFY/);
  await expect(approvalCard.locator(".workflow-phase-badge")).toHaveText("LOOP · SPEC APPROVAL");
  await expect(sessionCard("Plain session").locator(".workflow-phase-badge")).toHaveCount(0);
  await expect(sessionCard("Terminal session").locator(".workflow-phase-badge")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await expect(verifyingCard.locator(".workflow-phase-badge")).toBeVisible();
  await expect(verifyingCard).toHaveAccessibleName(/LOOP · VERIFY/);
  await expect(approvalCard.locator(".workflow-phase-badge")).toHaveText("LOOP · SPEC APPROVAL");

  const layout = await approvalCard.evaluate((card) => {
    const rail = card.closest<HTMLElement>(".rail")!;
    const row = card.closest<HTMLElement>(".session-row")!;
    const badge = card.querySelector<HTMLElement>(".workflow-phase-badge")!;
    const name = card.querySelector<HTMLElement>("strong")!;
    const action = row.querySelector<HTMLElement>(".session-menu-trigger")!;
    const bounds = (element: Element) => element.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      railClientWidth: rail.clientWidth,
      railScrollWidth: rail.scrollWidth,
      rail: bounds(rail),
      row: bounds(row),
      card: bounds(card),
      badge: bounds(badge),
      badgeClientWidth: badge.clientWidth,
      badgeScrollWidth: badge.scrollWidth,
      action: bounds(action),
      nameClientWidth: name.clientWidth,
      nameScrollWidth: name.scrollWidth,
    };
  });
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.railScrollWidth).toBeLessThanOrEqual(layout.railClientWidth);
  expect(layout.row.left).toBeGreaterThanOrEqual(layout.rail.left);
  expect(layout.row.right).toBeLessThanOrEqual(layout.rail.right + 1);
  expect(layout.card.right).toBeLessThanOrEqual(layout.row.right + 1);
  expect(layout.badge.left).toBeGreaterThanOrEqual(layout.card.left);
  expect(layout.badge.right).toBeLessThanOrEqual(layout.card.right + 1);
  expect(layout.badgeScrollWidth).toBeLessThanOrEqual(layout.badgeClientWidth);
  expect(layout.action.right).toBeLessThanOrEqual(layout.row.right + 1);
  expect(layout.nameScrollWidth).toBeGreaterThan(layout.nameClientWidth);
});

test("mobile composer starts and approves a guided engineering workflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Workflow session" }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const dialog = page.getByRole("dialog", { name: "Define, build, prove" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/modal-surface/);
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds?.y).toBeLessThanOrEqual(8);
  expect(dialogBounds?.height).toBeGreaterThanOrEqual(828);
  const repairBudget = dialog.getByLabel("Repair budget");
  await repairBudget.fill("");
  await expect(repairBudget).toHaveValue("");
  await repairBudget.fill("2");
  await expect(repairBudget).toHaveValue("2");
  await dialog.getByLabel("Objective").fill("Add a durable guided workflow with visible approval gates");
  await dialog.getByRole("button", { name: /start define/i }).click();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("0/2 REPAIRS");
  await expect(workflow).toContainText("Spec approval");
  await expect(workflow).toContainText("Specification is ready for approval");
  await workflow.locator("summary").click();
  await expect(workflow.locator(".workflow-artifact")).toBeVisible();
  const approvalLayout = await workflow.evaluate((element) => {
    const artifact = element.querySelector<HTMLElement>(".workflow-artifact")!;
    const footer = element.querySelector<HTMLElement>(":scope > footer")!;
    return { artifactHeight: artifact.clientHeight, artifactScrollHeight: artifact.scrollHeight, footerBottom: footer.getBoundingClientRect().bottom, viewportHeight: window.innerHeight };
  });
  expect(approvalLayout.artifactHeight).toBeGreaterThanOrEqual(350);
  expect(approvalLayout.artifactScrollHeight).toBeGreaterThan(approvalLayout.artifactHeight);
  expect(approvalLayout.viewportHeight - approvalLayout.footerBottom).toBeGreaterThanOrEqual(16);
  const specificationOverflow = await workflow.locator(".workflow-artifact").evaluate((artifact) => {
    const longValue = `/dev/site/${"unbroken-component-route-".repeat(18)}`;
    const paragraph = document.createElement("p");
    paragraph.dataset.testid = "long-spec-prose";
    paragraph.textContent = `A readable requirement containing ${longValue} must wrap inside the specification card.`;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = longValue;
    pre.append(code);
    artifact.append(paragraph, pre);
    const artifactBounds = artifact.getBoundingClientRect();
    const paragraphBounds = paragraph.getBoundingClientRect();
    pre.scrollLeft = 120;
    return {
      artifactRight: artifactBounds.right,
      paragraphRight: paragraphBounds.right,
      artifactClientWidth: artifact.clientWidth,
      detailsClientWidth: artifact.parentElement?.clientWidth ?? 0,
      artifactTouchAction: getComputedStyle(artifact).touchAction,
      preClientWidth: pre.clientWidth,
      preScrollWidth: pre.scrollWidth,
      preScrollLeft: pre.scrollLeft,
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(specificationOverflow.artifactClientWidth).toBeLessThanOrEqual(specificationOverflow.detailsClientWidth);
  expect(specificationOverflow.paragraphRight).toBeLessThanOrEqual(specificationOverflow.artifactRight + 1);
  expect(specificationOverflow.preScrollWidth).toBeGreaterThan(specificationOverflow.preClientWidth);
  expect(specificationOverflow.preScrollLeft).toBeGreaterThan(0);
  expect(specificationOverflow.artifactTouchAction).toContain("pan-x");
  expect(specificationOverflow.documentScrollWidth).toBeLessThanOrEqual(specificationOverflow.viewportWidth);
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
  await workflow.getByRole("button", { name: "APPROVE SPEC" }).click();
  await expect(workflow).toContainText("Planning");
  await expect(workflow).toContainText("Pi is preparing the complete delivery plan");
  await expect(workflow.locator("details")).not.toHaveAttribute("open");
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
  const planningLayout = await workflow.evaluate((element) => ({ footerBottom: element.querySelector<HTMLElement>(":scope > footer")!.getBoundingClientRect().bottom, viewportHeight: window.innerHeight }));
  expect(planningLayout.viewportHeight - planningLayout.footerBottom).toBeGreaterThanOrEqual(6);
  expect(await page.locator(".timeline").evaluate((element) => element.clientHeight)).toBeGreaterThan(100);

  api.setWorkflowPhase("awaitingPlanApproval");
  await page.reload();
  await expect(workflow).toContainText("Plan approval");
  await expect(workflow).toContainText("FINAL APPROVAL");
  await expect(workflow).toContainText("execute every listed operation unattended");
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
  await workflow.getByRole("button", { name: "APPROVE & RUN" }).click();
  await expect(workflow).toContainText("Ready to ship");
  await expect(page.getByLabel("Message Pi")).toBeVisible();
  await expect(workflow.getByRole("button", { name: "REVIEW CHANGES" })).toBeVisible();
  await workflow.getByRole("button", { name: "ACCEPT RESULT" }).click();
  await expect(workflow).toHaveCount(0);
  await expect(page.getByLabel("Message Pi")).toBeVisible();
  await page.reload();
  await expect(workflow).toHaveCount(0);
});

test("a new approval gate unlocks while the preceding mutation response is still settling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Lagging workflow mutation" }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const starter = page.getByRole("dialog", { name: "Define, build, prove" });
  await starter.getByLabel("Objective").fill("Keep authoritative approval gates actionable");
  await starter.getByRole("button", { name: /start define/i }).click();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("Spec approval");
  api.delayNextWorkflowMutation(10_000);
  await workflow.getByRole("button", { name: "APPROVE SPEC" }).click();
  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "approve" });
  api.setWorkflowPhase("awaitingPlanApproval");

  await expect(workflow).toContainText("Plan approval", { timeout: 5_000 });
  await expect(workflow.getByRole("button", { name: "APPROVE & RUN" })).toBeEnabled();
  await expect(workflow.getByRole("button", { name: "REQUEST CHANGES" })).toBeEnabled();
});

test("blocked workflows collect operator guidance before resuming the phase", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Blocked workflow guidance" }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const starter = page.getByRole("dialog", { name: "Define, build, prove" });
  await starter.getByLabel("Objective").fill("Run a production bootstrap safely");
  await starter.getByRole("button", { name: /start define/i }).click();
  api.setWorkflowBlocked("Build needs an operator-approved production procedure", true);
  await page.reload();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("Blocked");
  await expect(workflow).toContainText("Loop supervisor is reviewing this blocker");
  await expect(workflow.getByRole("button", { name: "PROVIDE GUIDANCE" })).toHaveCount(0);

  api.setWorkflowBlocked();
  await page.reload();
  await expect(workflow).toContainText("The workflow needs your permission before it deploys the production revision.");
  await expect(workflow).toContainText("Would you like the workflow to continue?");
  await expect(workflow.getByText("Build needs an operator-approved production procedure", { exact: true })).not.toBeVisible();
  await expect(workflow.getByRole("button", { name: "CONTINUE" })).toBeEnabled();
  await expect(workflow.getByRole("button", { name: "GIVE FEEDBACK" })).toBeEnabled();
  await workflow.getByRole("button", { name: "CONTINUE" }).click();
  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "resume", feedback: expect.stringContaining("operator chose to continue") });
  await expect(workflow).toContainText("Building");

  api.setWorkflowBlocked();
  await page.reload();
  await workflow.getByRole("button", { name: "GIVE FEEDBACK" }).click();

  const dialog = page.getByRole("dialog", { name: "Unblock Building" });
  await expect(dialog).toContainText("Do not paste credentials or secret values");
  await expect(dialog.getByRole("button", { name: "RESUME WITH GUIDANCE" })).toBeDisabled();
  const guidance = "Use the approved bounded read procedure in /runbooks/bootstrap.md; backup job bootstrap-2026-08-02 completed and production superadmin authorization is recorded in change CHG-42.";
  await dialog.getByLabel("Unblock guidance").fill(guidance);
  await dialog.getByRole("button", { name: "RESUME WITH GUIDANCE" }).click();

  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "resume", feedback: guidance });
  await expect(workflow).toContainText("Building");

  api.setWorkflowRuntimeCancelled();
  await page.reload();
  await expect(workflow).toContainText("The Pi runtime stopped before the workflow finished");
  await expect(workflow.getByRole("button", { name: "RESUME WORKFLOW" })).toBeEnabled();
  await workflow.getByRole("button", { name: "RESUME WORKFLOW" }).click();
  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "resume", feedback: expect.stringContaining("Resume the interrupted workflow") });
  await expect(workflow).toContainText("Building");
});

test("autonomous workflow phases expose Pi thinking and tool activity", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Visible loop activity" }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const dialog = page.getByRole("dialog", { name: "Define, build, prove" });
  await dialog.getByLabel("Objective").fill("Keep autonomous workflow activity visible");
  await dialog.getByRole("button", { name: /start define/i }).click();

  api.setWorkflowPhase("building");
  api.setEvents([
    {
      sequence: 1,
      type: "message_end",
      timestamp: "2026-04-15T10:00:00.000Z",
      data: { message: { role: "assistant", content: [
        { type: "thinking", thinking: "Inspect the workflow boundary before editing." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "web/src/App.tsx" } },
      ] } },
    },
    {
      sequence: 2,
      type: "tool_execution_start",
      timestamp: "2026-04-15T10:00:01.000Z",
      data: { toolCallId: "call-1", toolName: "read", args: { path: "web/src/App.tsx" } },
    },
  ]);
  api.setStatus("working");
  await page.reload();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("Building");
  await expect(page.locator(".thinking-trace")).toContainText("PI THINKING");
  await expect(page.locator(".tool-row")).toContainText("read");
  await expect(page.locator(".tool-row")).toContainText("running");
  await page.locator(".thinking-trace summary").click();
  await expect(page.getByText("Inspect the workflow boundary before editing.")).toBeVisible();
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
  expect(await page.locator(".timeline").evaluate((element) => element.clientHeight)).toBeGreaterThan(100);

  await workflow.getByRole("button", { name: "GUIDE CURRENT PHASE" }).click();
  const guidanceDialog = page.getByRole("dialog", { name: "Guide the current phase" });
  await expect(guidanceDialog).toContainText("labeled guidance");
  await guidanceDialog.getByLabel("Guidance").fill("Keep the activity transcript compact.");
  await guidanceDialog.getByRole("button", { name: /send guidance/i }).click();
  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "intervene", feedback: "Keep the activity transcript compact." });

  api.setWorkflowPhase("verifying");
  api.setStatus("working");
  await page.reload();
  await workflow.getByRole("button", { name: "GUIDE CURRENT PHASE" }).click();
  const verificationGuidance = page.getByRole("dialog", { name: "Guide the current phase" });
  await expect(verificationGuidance).toContainText("labeled guidance");
  await verificationGuidance.getByLabel("Guidance").fill("Summarize any remaining deployment risk.");
  await verificationGuidance.getByRole("button", { name: /send guidance/i }).click();
  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "intervene", feedback: "Summarize any remaining deployment risk." });
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
});

test("failed workflows can extend their repair budget and continue", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "erp-deadbeef", name: "Recover failed loop" }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Open workflow actions" }).click();
  await page.getByRole("menuitem", { name: /engineering loop/i }).click();
  const starter = page.getByRole("dialog", { name: "Define, build, prove" });
  await starter.getByLabel("Objective").fill("Recover an exhausted workflow without restarting it");
  await starter.getByRole("button", { name: /start define/i }).click();
  api.setWorkflowFailure();
  api.setStatus("stopped");
  await page.reload();

  const workflow = page.getByRole("region", { name: "Engineering workflow" });
  await expect(workflow).toContainText("Failed");
  await expect(workflow).toContainText("Blocking findings remain");
  await expect(workflow.locator(".workflow-stage-rail li.active")).toContainText("REVIEW");
  await expect(workflow.getByRole("button", { name: "REVIEW CHANGES" })).toBeVisible();
  await workflow.getByRole("button", { name: "CONTINUE REPAIRS" }).click();

  const continuation = page.getByRole("dialog", { name: "Continue the failed workflow" });
  await expect(continuation).toContainText("approved specification and plan stay in place");
  await expect(continuation).toContainText("Final review found blocking durability defects");
  const additionalAttempts = continuation.getByLabel("Additional repair attempts");
  await additionalAttempts.fill("3");
  await continuation.getByRole("button", { name: /continue repairs/i }).click();

  await expect.poll(() => api.workflowMutations.at(-1)).toMatchObject({ action: "continueRepairs", additionalRepairAttempts: 3, runtimeId: "runtime-1-resumed" });
  await expect(workflow).toContainText("Repairing");
  await expect(workflow).toContainText("3/6 REPAIRS");
  await expect(workflow.getByRole("button", { name: "GUIDE CURRENT PHASE" })).toBeVisible();
  await expect(page.getByLabel("Message Pi")).toHaveCount(0);
});

test("desktop workspace navigation scrolls independently when its contents overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 620 });
  await installApi(page);
  await page.goto("/");

  await page.evaluate(async () => {
    for (let index = 1; index <= 18; index += 1) {
      await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `workspace-${index}`, path: `/home/jonas/coding/workspace-${index}`, trustProjectResources: true }),
      });
    }
  });
  await page.reload();

  const navigation = page.locator(".workspace-list");
  const initial = await navigation.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(initial.scrollTop).toBe(0);

  const workspaceTop = await page.locator(".workspace").evaluate((element) => element.getBoundingClientRect().top);
  await navigation.hover();
  await page.mouse.wheel(0, 480);

  await expect.poll(() => navigation.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /workspace-18.*home\/jonas\/coding\/workspace-18/i })).toBeVisible();
  expect(await page.locator(".workspace").evaluate((element) => element.getBoundingClientRect().top)).toBe(workspaceTop);
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

test("returning to the app restores the last opened session", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const api = await installApi(page);
  await page.goto("/");

  await page.evaluate(async () => {
    for (const name of ["First session", "Last opened session"]) {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "erp-deadbeef", name }),
      });
    }
  });
  await page.reload();
  await expect(page.locator(".brand b")).toHaveText("First session");

  await page.getByRole("button", { name: /Last opened session.*finished/i }).click();
  await expect(page.locator(".brand b")).toHaveText("Last opened session");
  await page.waitForTimeout(100);

  api.delaySessionLoad("Last opened session");
  await page.goto("/");
  await expect(page.locator(".brand b")).toHaveText("Last opened session", { timeout: 300 });
  await expect(page).toHaveURL(/session=session-2/);

  await page.goto("/?session=session-1");
  await expect(page.locator(".brand b")).toHaveText("First session");
  await page.goto("/");
  await expect(page.locator(".brand b")).toHaveText("First session");
});

test("URL history restores the active session, page, and timeline position", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 620 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByLabel("Session name").fill("URL state session");
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const timestamp = new Date().toISOString();
  const messageEvent = (sequence: number) => ({
    sequence,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: `URL position ${sequence} ${"stable content ".repeat(8)}` }] } },
  });
  api.setHistoricalEvents(Array.from({ length: 30 }, (_, index) => messageEvent(index + 1)));
  api.setEvents(Array.from({ length: 40 }, (_, index) => messageEvent(index + 31)));
  await expect(page.getByText(/URL position 70/)).toBeVisible();

  const timeline = page.locator(".timeline");
  await timeline.hover();
  await page.mouse.wheel(0, -10_000);
  await page.getByRole("button", { name: "LOAD EARLIER ACTIVITY" }).click();
  await expect(page.getByText(/URL position 1 /)).toBeAttached();
  await timeline.hover();
  await page.mouse.wheel(0, -1_400);
  await expect.poll(() => page.evaluate(() => Number(new URL(location.href).searchParams.get("sequence")))).toBeLessThan(31);
  await expect(page).toHaveURL(/view=agent&at=message-/);
  const visibleAnchor = () => timeline.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-timeline-key]")];
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > top + 1)!;
    return { key: row.dataset.timelineKey, offset: Math.round(row.getBoundingClientRect().top - top) };
  });
  const beforeReload = await visibleAnchor();

  await page.reload();
  await expect(page.locator(".brand b")).toHaveText("URL state session");
  await expect(page.locator(".capability-tabs").getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await visibleAnchor()).key).toBe(beforeReload.key);
  await expect.poll(async () => Math.abs((await visibleAnchor()).offset - beforeReload.offset)).toBeLessThanOrEqual(2);

  await page.locator(".capability-tabs").getByRole("tab", { name: "Details" }).click();
  await expect(page).toHaveURL(/session=session-1&view=details/);
  await page.reload();
  await expect(page.locator(".capability-tabs").getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.locator(".capability-tabs").getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await visibleAnchor()).key).toBe(beforeReload.key);
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

  const pickerTrigger = page.getByRole("button", { name: "Search sessions" });
  await expect(pickerTrigger.locator("kbd")).toHaveText("Ctrl+K");
  const headerGap = await pickerTrigger.evaluate((trigger) => {
    const triggerBounds = trigger.getBoundingClientRect();
    const networkBounds = document.querySelector<HTMLElement>(".network")!.getBoundingClientRect();
    return networkBounds.left - triggerBounds.right;
  });
  expect(headerGap).toBeGreaterThanOrEqual(16);

  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press("Control+k");
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
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await search.fill("auth feat");
  await expect(picker.getByRole("option", { name: /Authentication refactor.*feat\/browser-test/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(page.getByLabel("Message Pi")).toBeFocused();

  await pickerTrigger.click();
  await expect(picker.getByRole("option")).toHaveCount(2);
  await page.mouse.click(2, 2);
  await expect(picker).toBeHidden();
  await expect(pickerTrigger).toBeFocused();
});

test("mobile session picker fills the visible page without shifting when its height changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Search sessions" }).click();
  const layer = page.locator(".global-picker-layer");
  const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
  const search = picker.getByLabel("Search sessions");
  await expect(picker).toBeVisible();
  await expect(search).toHaveCSS("border-top-width", "0px");
  await expect(search).toHaveCSS("background-color", "rgb(242, 245, 239)");

  await layer.evaluate((element) => {
    element.style.bottom = "auto";
    element.style.height = "420px";
  });
  const keyboardOpenBounds = (await picker.boundingBox())!;
  const searchBounds = (await search.boundingBox())!;
  const closeBounds = (await picker.getByRole("button", { name: "Close sessions picker" }).boundingBox())!;
  expect(searchBounds.x - keyboardOpenBounds.x).toBeGreaterThanOrEqual(11);
  expect(searchBounds.y - keyboardOpenBounds.y).toBeGreaterThanOrEqual(11);
  expect(closeBounds.x - searchBounds.x - searchBounds.width).toBeGreaterThanOrEqual(11);
  expect(keyboardOpenBounds.x + keyboardOpenBounds.width - closeBounds.x - closeBounds.width).toBeGreaterThanOrEqual(11);

  await layer.evaluate((element) => { element.style.height = "700px"; });
  const keyboardClosedBounds = (await picker.boundingBox())!;

  expect(keyboardOpenBounds).toMatchObject({ x: 6, y: 6, width: 378, height: 408 });
  expect(keyboardClosedBounds).toMatchObject({ x: 6, y: 6, width: 378, height: 688 });
});

test("desktop composer inserts a newline with Shift+Enter and sends with Enter", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const api = await installApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const composer = page.getByLabel("Message Pi");
  await composer.fill("Review @App");
  const mentionOptions = page.getByRole("listbox", { name: "Workspace files" }).getByRole("option");
  await expect(mentionOptions).toHaveCount(2);
  await expect(composer).toBeFocused();
  await composer.press("Control+n");
  await expect(mentionOptions.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("Control+p");
  await expect(mentionOptions.first()).toHaveAttribute("aria-selected", "true");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("Review @App\n");
  expect(api.commands).toHaveLength(0);

  await composer.fill("/");
  const commandDialog = page.getByRole("dialog", { name: "Pi commands" });
  await expect(commandDialog).toBeVisible();
  await page.keyboard.press("Shift+Enter");
  await expect(commandDialog).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("/\n");
  expect(api.commands).toHaveLength(0);

  await composer.fill("First line");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("First line\n");
  await composer.pressSequentially("Second line", { delay: 10 });

  await expect(composer).toHaveValue("First line\nSecond line");
  expect(api.commands).toHaveLength(0);

  await composer.press("Enter");
  await expect.poll(() => api.commands.at(-1)?.text).toBe("First line\nSecond line");

  const longDraft = Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join("\n");
  await composer.fill(longDraft);
  await composer.evaluate((element) => { element.scrollTop = 0; });
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue(`${longDraft}\n`);
  await expect.poll(() => composer.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
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
  const commandOptions = commandList.getByRole("option");
  await expect(commandOptions).toHaveCount(9);
  await expect(commandList.getByRole("option", { name: /resume.*built-in/i })).toBeVisible();
  await expect(commandList.getByRole("option", { name: /review.*extension/i })).toBeVisible();
  await commandSearch.press("Control+n");
  await expect(commandOptions.first()).toHaveAttribute("data-highlighted");
  await commandSearch.press("Control+n");
  await expect(commandOptions.nth(1)).toHaveAttribute("data-highlighted");
  await commandSearch.press("Control+p");
  await expect(commandOptions.first()).toHaveAttribute("data-highlighted");
  await commandSearch.press("Control+p");
  await expect(commandOptions.last()).toHaveAttribute("data-highlighted");
  await expect(commandOptions.last()).toBeVisible();
  await commandSearch.press("Control+n");
  await expect(commandOptions.first()).toHaveAttribute("data-highlighted");

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
    const title = header.querySelector<HTMLElement>("div")!;
    const close = header.querySelector<HTMLElement>("button")!.getBoundingClientRect();
    const footer = picker.querySelector<HTMLElement>(":scope > footer")!;
    const search = picker.querySelector<HTMLElement>(".global-picker-search")!.getBoundingClientRect();
    return {
      closeTop: close.top,
      closeBottom: close.bottom,
      searchTop: search.top,
      searchBottom: search.bottom,
      titleDisplay: getComputedStyle(title).display,
      footerDisplay: getComputedStyle(footer).display,
    };
  });
  expect(Math.abs(mobilePickerChrome.closeTop - mobilePickerChrome.searchTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobilePickerChrome.closeBottom - mobilePickerChrome.searchBottom)).toBeLessThanOrEqual(1);
  expect(mobilePickerChrome.titleDisplay).toBe("none");
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
  await expect(page.getByText("Review extension output")).toBeVisible();
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
  const directoryInput = dialog.getByRole("textbox", { name: "Directory", exact: true });
  await directoryInput.press("Control+n");
  await expect(results.getByRole("option", { name: /new-project/ })).toHaveClass(/highlighted/);
  await directoryInput.press("Control+p");
  await directoryInput.press("Enter");
  await expect(dialog.getByLabel("Workspace name")).toHaveValue("new-project");
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
  await page.keyboard.press("Control+n");
  await expect(renameItem).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(removeItem).toBeFocused();
  await page.keyboard.press("Control+p");
  await expect(renameItem).toBeFocused();
  await page.keyboard.press("Control+n");
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

test("selecting a cached session transfers only newer authoritative events before rendering", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const api = await installApi(page);
  await page.goto("/");

  const createSession = async (name: string) => {
    await page.getByRole("button", { name: "New session in erp" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await dialog.getByLabel("Session name").fill(name);
    await dialog.getByRole("button", { name: /start session/i }).click();
  };
  const event = (text: string, sequence = 1) => ({
    sequence,
    type: "message_end",
    timestamp: new Date().toISOString(),
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  });
  await createSession("First session");
  api.setStatusFor("First session", "working");
  api.setEventsFor("First session", [event("Stale cached chat")]);
  await expect(page.getByText("Stale cached chat", { exact: true })).toBeVisible();

  // Switching away retains this authoritative snapshot for incremental sync,
  // but it must not become visible before the server confirms the latest state.
  await createSession("Second session");
  api.setEventsFor("First session", [event("Stale cached chat"), event("Fresh authoritative chat", 2)]);
  api.delaySessionLoad("First session", 2_000);

  await page.getByRole("button", { name: /^First session / }).click();
  const loading = page.locator(".session-loading");
  await expect(loading).toContainText("Opening First session");
  await expect(page.getByText("Stale cached chat", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No session selected" })).toHaveCount(0);
  await expect.poll(() => api.sessionLoads.filter((load) => load.sessionId === "session-1").at(-1)?.afterSequence).toBe(1);

  await expect(page.getByText("Fresh authoritative chat", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.locator(".brand b")).toHaveText("First session");
});

test("returning to a visible page reconnects a suspended session stream", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await installApi(page);
  await page.addInitScript(() => {
    let connections = 0;
    Object.defineProperty(window, "__pissTestStreamConnections", {
      configurable: true,
      get: () => connections,
    });
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: class extends EventTarget {
        readonly url: string;
        readonly withCredentials = false;
        readonly readyState = 1;
        private closed = false;

        constructor(url: string | URL) {
          super();
          this.url = String(url);
          connections += 1;
          window.setTimeout(() => void this.publishSnapshot(), 0);
        }

        close() {
          this.closed = true;
        }

        private async publishSnapshot() {
          const match = /\/api\/sessions\/([^/]+)\/events/.exec(new URL(this.url, window.location.href).pathname);
          if (!match) return;
          const response = await fetch(`/api/sessions/${match[1]}`);
          const body = await response.json();
          if (this.closed) return;
          const sequence = body.session.events.at(-1)?.sequence ?? 0;
          this.dispatchEvent(new MessageEvent("session", {
            data: JSON.stringify({ session: body.session, reset: false }),
            lastEventId: String(sequence),
          }));
        }
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  const composer = page.getByLabel("Message Pi");
  await expect(composer).toBeEnabled();
  const connectionsBeforeRestore = await page.evaluate(() => (window as unknown as { __pissTestStreamConnections: number }).__pissTestStreamConnections);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));

  await expect.poll(() => page.evaluate(() => (window as unknown as { __pissTestStreamConnections: number }).__pissTestStreamConnections)).toBeGreaterThan(connectionsBeforeRestore);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute("placeholder", /Message Pi/);
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

  const thinkingButton = page.getByRole("button", { name: /^Thinking:/ });
  await expect(thinkingButton).toHaveAccessibleName("Thinking: medium");
  await thinkingButton.click();
  const thinkingMenu = page.getByRole("menu", { name: "Thinking options" });
  await expect(thinkingMenu.getByRole("menuitemradio")).toHaveCount(4);
  await thinkingMenu.getByRole("menuitemradio", { name: "high" }).click();
  await expect(thinkingButton).toHaveAccessibleName("Thinking: high");
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
  await page.setViewportSize({ width: 390, height: 700 });
  await expect.poll(viewportLayout).toMatchObject({ visibleHeight: 700, configuredHeight: 700 });
  const composer = page.getByLabel("Message Pi");
  await composer.focus();
  await page.setViewportSize({ width: 390, height: 520 });
  await expect.poll(viewportLayout).toMatchObject({ visibleHeight: 520, configuredHeight: 520, mastheadHeight: 0, tabsHeight: 0 });
  layout = await viewportLayout();
  expect(layout.controlsHeight).toBeGreaterThanOrEqual(40);
  expect(layout.timelineHeight).toBeGreaterThan(restingTimelineHeight + 90);

  await composer.fill("Maybe we should be trying to be better with the space for the chat interface as well, quite little space on mobile for the actual messages");
  layout = await viewportLayout();
  expect(layout.composerHeight).toBeLessThanOrEqual(178);
  expect(layout.timelineHeight).toBeGreaterThanOrEqual(280);

  await page.setViewportSize({ width: 390, height: 700 });
  await expect(composer).toBeFocused();
  await expect.poll(async () => (await viewportLayout()).mastheadHeight).toBeGreaterThan(0);
  layout = await viewportLayout();
  expect(layout.tabsHeight).toBeGreaterThan(0);
});

test("mobile session tabs expose agent, changes, and details without an empty review count", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page, { emptyReview: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const tabs = page.locator(".capability-tabs").getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await expect(tabs).toHaveText(["Agent", "Changes", "Details"]);
  const changes = tabs.filter({ hasText: "Changes" });
  await changes.click();
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toContainText("Working tree is clean");
  await expect(changes.locator("em")).toHaveCount(0);
});

test("mobile review supports touch-sized line comments and reviewed progress", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  await page.locator(".capability-tabs").getByRole("tab", { name: /Changes/ }).click();

  const appReviewFile = page.locator(".review-file").filter({ hasText: "App.tsx" });
  const reviewedToggle = appReviewFile.getByRole("button", { name: "Mark web/src/App.tsx reviewed" });
  const toggleBox = await reviewedToggle.boundingBox();
  expect(toggleBox?.width).toBeGreaterThanOrEqual(44);
  expect(toggleBox?.height).toBeGreaterThanOrEqual(44);
  await reviewedToggle.click();
  await expect(page.locator(".review-overview")).toContainText("1 of 2 files reviewed");

  const removed = appReviewFile.getByRole("button", { name: /old line 1: -old line/ });
  const added = appReviewFile.getByRole("button", { name: /new line 1: \+new line/ });
  await removed.click();
  await expect(appReviewFile.locator(".review-comment")).toHaveCount(0);
  await expect(appReviewFile.getByRole("button", { name: "Comment on web/src/App.tsx:old:1" })).toBeVisible();
  await removed.click();
  await expect(removed).toHaveAttribute("aria-pressed", "false");
  await expect(appReviewFile.locator(".review-comment-prompt")).toHaveCount(0);

  await removed.click();
  await added.click();
  const lineBox = await added.boundingBox();
  expect(lineBox?.height).toBeGreaterThanOrEqual(30);
  await added.click();
  await expect(added).toHaveAttribute("aria-pressed", "false");
  await expect(removed).toHaveAttribute("aria-pressed", "true");
  await added.click();
  await expect(added).toHaveAttribute("aria-pressed", "true");
  const openComment = appReviewFile.getByRole("button", { name: "Comment on web/src/App.tsx:1" });
  await openComment.click();
  const comment = appReviewFile.getByLabel("Comment editor for web/src/App.tsx:1");
  await expect(comment).toBeFocused();
  await appReviewFile.getByRole("button", { name: "Close comment editor" }).click();
  await expect(comment).toBeHidden();
  await expect(openComment).toBeVisible();
  await openComment.click();
  await comment.fill("Please preserve this behavior on mobile.");
  await appReviewFile.getByRole("button", { name: "SEND TO AGENT" }).click();
  await expect.poll(() => api.commands.at(-1)?.text).toContain("Please preserve this behavior on mobile.");
  await expect(appReviewFile).toContainText("Comment sent to the agent");
  await expect(page.getByLabel("Message Pi")).toBeHidden();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const shellWidth = await page.locator(".shell").evaluate((element) => element.scrollWidth);
  expect(shellWidth).toBe(viewportWidth);
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
  await expect(page.getByRole("button", { name: /ATTENTION ALERTS/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog.getByRole("heading", { name: "Notifications" })).toBeVisible();
  const settingsBackdrop = page.locator(".dialog-layer");
  await expect(settingsBackdrop).toHaveCSS("background-color", "rgba(28, 31, 28, 0.5)");
  await expect(settingsBackdrop).toHaveCSS("backdrop-filter", "none");
  await page.setViewportSize({ width: 390, height: 360 });
  const settingsBody = settingsDialog.locator(".settings-dialog-body");
  await settingsBody.evaluate((element) => { element.style.height = "100px"; });
  await expect.poll(() => settingsBody.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.keyboard.press("Control+n");
  await expect.poll(() => settingsBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Control+p");
  await expect.poll(() => settingsBody.evaluate((element) => element.scrollTop)).toBe(0);
  await settingsDialog.getByRole("button", { name: "Close settings" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByRole("button", { name: "Open workspaces and sessions" });
  await expect(mobileMenu).toBeFocused();
  await mobileMenu.click();
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

  await page.setViewportSize({ width: 360, height: 844 });
  await page.getByLabel("Attach images").setInputFiles(["screen-a.png", "screen-b.png", "screen-c.png"].map((name) => ({
    name,
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })));
  await expect(page.locator(".composer-images img")).toHaveCount(3);
  const attachmentLayout = await page.locator(".composer").evaluate((composer) => {
    const send = composer.querySelector<HTMLElement>(".send-button")!.getBoundingClientRect();
    const images = composer.querySelector<HTMLElement>(".composer-images")!.getBoundingClientRect();
    const footer = composer.querySelector<HTMLElement>(".composer-footer")!.getBoundingClientRect();
    return { send: { width: send.width, height: send.height }, imagesBottom: images.bottom, footerTop: footer.top };
  });
  expect(attachmentLayout.send).toEqual({ width: 42, height: 42 });
  expect(attachmentLayout.imagesBottom).toBeLessThanOrEqual(attachmentLayout.footerTop);
  await page.getByLabel("Message Pi").fill("Inspect these screens");
  await page.locator(".send-button").click();
  await expect.poll(() => (api.commands.at(-1)?.images as Array<Record<string, unknown>> | undefined)?.length).toBe(3);
  await expect.poll(() => (api.commands.at(-1)?.images as Array<Record<string, unknown>> | undefined)?.[0]?.mediaType).toBe("image/png");
  await expect(page.locator(".composer-images")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });

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
  const mentionSearch = mentionPicker.getByLabel("Search workspace files");
  const mobileMentionOptions = mentionPicker.getByRole("option");
  await expect(mentionSearch).toHaveValue("app");
  await expect(mentionPicker.getByRole("option", { name: /App\.tsx/ })).toBeVisible();
  await mentionSearch.press("Control+n");
  await expect(mobileMentionOptions.first()).toHaveAttribute("data-highlighted");
  await mentionSearch.press("Control+n");
  await expect(mobileMentionOptions.nth(1)).toHaveAttribute("data-highlighted");
  await mentionSearch.press("Control+p");
  await expect(mobileMentionOptions.first()).toHaveAttribute("data-highlighted");
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
  const modelButton = page.getByRole("button", { name: /^Model:/ });
  const thinkingButton = page.getByRole("button", { name: /^Thinking:/ });
  await expect(modelButton).toBeVisible();
  await expect(thinkingButton).toBeVisible();

  await modelButton.click();
  const modelMenu = page.getByRole("menu", { name: "Model options" });
  await expect(modelMenu).toBeVisible();
  await expect(modelButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(modelButton).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(modelButton).toHaveCSS("box-shadow", "none");
  await expect(modelMenu.locator(".composer-model-option b")).toHaveText(["GPT-5.10", "GPT-5.9", "GPT-5.6", "GPT-5.4"]);
  await expect(modelMenu.getByRole("menuitemradio")).toHaveCount(4);
  const modelBounds = await modelMenu.boundingBox();
  expect(modelBounds).not.toBeNull();
  expect(modelBounds!.x).toBeGreaterThanOrEqual(0);
  expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(360);
  await page.keyboard.press("Escape");

  await thinkingButton.click();
  const thinkingMenu = page.getByRole("menu", { name: "Thinking options" });
  await thinkingMenu.getByRole("menuitemradio", { name: "high" }).click();
  await expect(thinkingButton).toHaveAccessibleName("Thinking: high");

  await modelButton.click();
  await modelMenu.getByRole("menuitemradio", { name: /GPT-5.6/ }).click();
  await expect(modelButton).toHaveAccessibleName("Model: GPT-5.6");
  await expect(thinkingButton).toHaveAccessibleName("Thinking: off");

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

  expect(await page.locator(".composer").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("4px");
  await expect(page.locator(".composer-insertions svg")).toHaveCount(3);
  expect(await page.locator(".attachment-trigger").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("3px");
  expect(await page.locator(".composer-action-trigger").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("3px");
  expect(await page.locator(".mention-trigger").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("3px");
  expect(await page.locator(".send-button").evaluate((element) => getComputedStyle(element).borderRadius)).toBe("3px");
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
  const renamedSettings = page.getByRole("button", { name: "Session settings for Release guardian" });
  await expect(renamedSettings).toBeVisible();
  await renamedSettings.click();
  await page.getByRole("menuitem", { name: "ARCHIVE" }).click();
  const archiveDialog = page.getByRole("alertdialog", { name: "Archive session?" });
  await expect(archiveDialog).toHaveClass(/modal-surface-content/);
  const archiveBounds = await archiveDialog.boundingBox();
  expect(archiveBounds?.height).toBeLessThan(420);
  expect(archiveBounds?.y).toBeGreaterThan(150);
  await archiveDialog.getByRole("button", { name: "CANCEL" }).click();
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

  const timeline = page.locator(".timeline");
  const bottomScrollTop = await timeline.evaluate((element) => element.scrollTop);
  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press("Control+p");
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeLessThan(bottomScrollTop);
  const keyboardScrollTop = await timeline.evaluate((element) => element.scrollTop);
  await page.keyboard.press("Control+n");
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(keyboardScrollTop);

  await timeline.hover();
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

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTimeline = page.locator(".timeline");
  await mobileTimeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await mobileTimeline.hover();
  await page.mouse.wheel(0, -200);
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest message" });
  await expect(jumpToLatest).not.toHaveClass(/at-bottom/);
  const paddingBeforeReturning = await mobileTimeline.evaluate((element) => getComputedStyle(element).paddingBottom);
  await mobileTimeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(jumpToLatest).toHaveClass(/at-bottom/);
  await expect.poll(() => mobileTimeline.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe(paddingBeforeReturning);

  // Native touch panning cancels pointer tracking. A slow drag can then move
  // by only one pixel per scroll event; holding there must detach following
  // instead of fighting the gesture back to the bottom.
  await mobileTimeline.evaluate(async (element) => {
    const dispatchTouch = (type: "touchstart" | "touchmove" | "touchend", clientY?: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: clientY === undefined ? [] : [{ clientY }] });
      element.dispatchEvent(event);
    };
    let touchY = 100;
    dispatchTouch("touchstart", touchY);
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch" }));
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "touch" }));
    for (let step = 0; step < 6; step += 1) {
      touchY += 0.5;
      dispatchTouch("touchmove", touchY);
      const scrolled = new Promise<void>((resolve) => element.addEventListener("scroll", () => resolve(), { once: true }));
      element.scrollTop -= 1;
      await scrolled;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    dispatchTouch("touchend");
  });
  await expect.poll(distanceFromBottom).toBeGreaterThanOrEqual(5);
  await expect(jumpToLatest).not.toHaveClass(/at-bottom/);
});

test("a completed final response remains latest across page reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspaces and sessions" }).click();
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const timestamp = new Date().toISOString();
  const tools = Array.from({ length: 220 }, (_, index) => ({
    sequence: index + 1,
    type: "tool_execution_end",
    timestamp,
    data: { toolCallId: `reload-tool-${index}`, toolName: "read", result: { content: [{ type: "text", text: `Tool result ${index}` }] }, isError: false },
  }));
  api.setEvents([...tools, {
    sequence: 221,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: "## Durable final response\n\nThis must remain visible after reload." }] } },
  }]);
  api.setStatus("idle");

  const finalResponse = page.getByText("Durable final response", { exact: true });
  await expect(finalResponse).toBeVisible({ timeout: 5_000 });
  await page.reload();
  await expect(finalResponse).toBeVisible({ timeout: 5_000 });
  const timeline = page.locator(".timeline");
  const distanceFromBottom = () => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromBottom).toBeLessThan(4);

  // Android Chromium may apply nested-scroll restoration after the app's
  // initial layout. A restoration without user input must not strand the chat
  // among old tool calls instead of its final response.
  await page.waitForTimeout(250);
  await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.35; });
  await expect.poll(distanceFromBottom).toBeLessThan(4);
  await expect(finalResponse).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveClass(/at-bottom/);
});

test("older timeline pages preserve scroll position and detached tool output loads on expansion", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();

  const timestamp = new Date().toISOString();
  const historical = Array.from({ length: 30 }, (_, index) => ({
    sequence: index + 1,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: `Historical ${index + 1} ${"detail ".repeat(12)}` }] } },
  }));
  api.setHistoricalEvents(historical);
  api.setDetachedOutput("output-50", { content: [{ type: "text", text: `FULL OUTPUT\n${"large line\n".repeat(500)}END OF DETACHED OUTPUT` }] });
  api.setEvents([
    ...Array.from({ length: 19 }, (_, index) => ({
      sequence: index + 31,
      type: "message_end",
      timestamp,
      data: { message: { role: "assistant", content: [{ type: "text", text: `Current ${index + 31} ${"detail ".repeat(12)}` }] } },
    })),
    { sequence: 50, type: "tool_execution_end", timestamp, data: { toolCallId: "lazy-tool", toolName: "bash", result: { content: [{ type: "text", text: "short preview" }] }, isError: false, outputRef: "output-50", outputBytes: 5560, outputTruncated: true } },
  ]);

  await expect(page.getByText(/Current 49/)).toBeVisible({ timeout: 5_000 });
  const loadOlder = page.getByRole("button", { name: "LOAD EARLIER ACTIVITY" });
  const timeline = page.locator(".timeline");
  await timeline.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(loadOlder).toBeVisible();
  const current31 = page.getByText(/Current 31/);
  const before = await current31.boundingBox();
  await loadOlder.click();
  await expect(page.getByText(/^Historical 1 detail/)).toBeAttached();
  expect(before).not.toBeNull();
  await expect.poll(async () => {
    const after = await current31.boundingBox();
    return Math.abs((after?.y ?? 0) - (before?.y ?? 0));
  }).toBeLessThan(8);

  const tool = page.locator("details.tool-result", { hasText: "bash" });
  await tool.scrollIntoViewIfNeeded();
  await expect(page.getByText("END OF DETACHED OUTPUT", { exact: false })).toHaveCount(0);
  await tool.locator("summary").click();
  await expect(tool.getByText("Full output loaded")).toBeVisible();
  const toolOutput = tool.locator("pre");
  await expect(toolOutput).toContainText("END OF DETACHED OUTPUT");
  await toolOutput.focus();
  await page.keyboard.press("Control+n");
  await expect.poll(() => toolOutput.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Control+p");
  await expect.poll(() => toolOutput.evaluate((element) => element.scrollTop)).toBe(0);
});

test("10,000-event timeline benchmark stays bounded and interactive", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const api = await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New session in erp" }).click();
  await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: /start session/i }).click();
  const timestamp = new Date().toISOString();
  const started = Date.now();
  api.setEvents(Array.from({ length: 10_000 }, (_, index) => ({
    sequence: index + 1,
    type: "message_end",
    timestamp,
    data: { message: { role: "assistant", content: [{ type: "text", text: `Benchmark ${index + 1}\n\n**markdown** item` }] } },
  })));
  await expect(page.getByText("Benchmark 10000", { exact: false })).toBeVisible({ timeout: 20_000 });
  const renderedMs = Date.now() - started;
  const articleCount = await page.locator(".timeline article.message").count();
  const interactionStarted = Date.now();
  await page.getByLabel("Message Pi").fill("composer remains responsive");
  const interactionMs = Date.now() - interactionStarted;
  console.log(`timeline benchmark: rendered=${renderedMs}ms interaction=${interactionMs}ms articles=${articleCount}`);
  expect(renderedMs).toBeLessThan(10_000);
  expect(interactionMs).toBeLessThan(1_000);
  expect(articleCount).toBeLessThan(400);
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
  await expect(sessionTabs).toHaveCount(3);
  await expect(sessionTabs.filter({ hasText: "Agent" })).toBeVisible();
  await expect(sessionTabs.filter({ hasText: "Details" })).toBeVisible();
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
  const appReviewFile = page.locator(".review-file").filter({ hasText: "App.tsx" });
  const reviewedToggle = appReviewFile.getByRole("button", { name: "Mark web/src/App.tsx reviewed" });
  await reviewedToggle.click();
  await expect(appReviewFile.getByRole("button", { name: "Mark web/src/App.tsx unreviewed" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".review-overview")).toContainText("1 of 2 files reviewed");
  await appReviewFile.getByRole("button", { name: /old line 1: -old line/ }).click();
  await appReviewFile.getByRole("button", { name: /new line 1: \+new line/ }).click();
  await appReviewFile.getByRole("button", { name: "Comment on web/src/App.tsx:1" }).click();
  await appReviewFile.getByLabel("Comment editor for web/src/App.tsx:1").fill("Keep the fallback for older clients.");
  await appReviewFile.getByRole("button", { name: "SEND TO AGENT" }).click();
  await expect.poll(() => api.commands.at(-1)?.text).toContain("Review comment at web/src/App.tsx:1:");
  await expect.poll(() => api.commands.at(-1)?.text).toContain("-old line\n+new line");
  await expect(appReviewFile).toContainText("Comment sent to the agent");
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect.poll(() => api.reviewRequestCount()).toBe(2);
  await expect(appReviewFile.getByRole("button", { name: "Mark web/src/App.tsx unreviewed" })).toHaveAttribute("aria-pressed", "true");
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

  const composer = page.locator(".composer");
  const modelButton = composer.getByRole("button", { name: /^Model:/ });
  const thinkingButton = composer.getByRole("button", { name: /^Thinking:/ });
  await expect(modelButton).toBeVisible();
  await expect(thinkingButton).toBeVisible();
  await modelButton.click();
  const modelMenu = page.getByRole("menu", { name: "Model options" });
  await expect(modelMenu).toBeVisible();
  const box = await modelMenu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);

  const dimensions = await page.locator(".shell").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(dimensions.scroll).toBe(dimensions.client);
  await page.keyboard.press("Escape");
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
  await select.focus();
  await page.keyboard.press("Control+n");
  await expect(select).toHaveValue("Production");
  await page.keyboard.press("Control+p");
  await expect(select).toHaveValue("Preview");
  await page.keyboard.press("Control+n");
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
  await expect(page.getByRole("button", { name: /ATTENTION ALERTS/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  const toggle = settingsDialog.getByRole("button", { name: /ATTENTION ALERTS/ });
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
  await settingsDialog.getByRole("button", { name: "DISABLE" }).click();
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
  await settingsDialog.getByRole("button", { name: "Close settings" }).click();

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
  await page.getByRole("button", { name: "Open settings" }).click();
  const toggle = page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: /ATTENTION ALERTS/ });
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
  await page.getByRole("button", { name: "Open settings" }).click();
  const toggle = page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: /ATTENTION ALERTS/ });
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

  await page.getByRole("tab", { name: "Details" }).click();
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
