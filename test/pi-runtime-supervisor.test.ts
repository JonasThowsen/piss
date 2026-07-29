import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AppConfig, type AppConfigShape } from "../server/config.ts";
import { FileMentionSearch } from "../server/files/FileMentionSearch.ts";
import { appendBoundedEvent, PiRuntimeSupervisor, PiRuntimeSupervisorLive, projectEventData, replayEventsFromTranscriptEntry } from "../server/runtimes/PiRuntimeSupervisor.ts";
import { PushNotifications } from "../server/notifications/PushNotifications.ts";
import { WorkspaceDirectory } from "../server/workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepository } from "../server/workspaces/WorkspaceRepository.ts";
import { WorkspaceId, type OwnedSessionEvent, type Workspace } from "../shared/domain.ts";

const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);

async function fakePi(directory: string, lazySessionFile = false): Promise<string> {
  const path = join(directory, "fake-pi.mjs");
  await writeFile(
    path,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.FAKE_PI_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");
const sessionFile = process.env.FAKE_PI_SESSION_FILE;
const writeHeader = () => writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
if (${lazySessionFile ? "false" : "true"} && !existsSync(sessionFile)) writeHeader();
const models = [
  { provider: "test", id: "model-a", name: "Model A", reasoning: true, baseUrl: "https://credential@example.invalid", headers: { Authorization: "Bearer super-secret" }, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
  { provider: "test", id: "model-b", name: "Model B", reasoning: false }
];
let currentModel = models[0];
let currentThinking = "medium";
let buffer = "";
let compactAttempts = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (process.env.FAKE_PI_COMMANDS) appendFileSync(process.env.FAKE_PI_COMMANDS, command.type + "\\n");
    if (command.type === "get_state" && process.env.FAKE_PI_HANG !== "1") {
      console.log(JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi-test-session", sessionFile, model: currentModel, thinkingLevel: currentThinking, isStreaming: false, autoCompactionEnabled: true, pendingMessageCount: 0 } }));
    }
    if (command.type === "get_available_models") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_available_models", success: true, data: { models } }));
    if (command.type === "get_commands") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: [
      { name: "review", description: "Review changes", source: "extension", sourceInfo: { path: "/secret/extension.ts", source: "test", scope: "user", origin: "top-level" } },
      { name: "fix-tests", description: "Fix tests", source: "prompt", sourceInfo: { path: "/secret/fix-tests.md", source: "test", scope: "project", origin: "top-level" } }
    ] } }));
    if (command.type === "get_session_stats") console.log(JSON.stringify({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 10, tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 50, total: 1750 }, cost: 0.25, contextUsage: { tokens: 30000, contextWindow: 200000, percent: 15 } } }));
    if (command.type === "compact") {
      compactAttempts += 1;
      console.log(JSON.stringify({ type: "compaction_start", reason: "manual" }));
      if (compactAttempts === 1) {
        console.log(JSON.stringify({ id: command.id, type: "response", command: "compact", success: true, data: { tokensBefore: 30000, estimatedTokensAfter: 9000 } }));
        console.log(JSON.stringify({ type: "compaction_end", reason: "manual", result: { tokensBefore: 30000, estimatedTokensAfter: 9000 }, aborted: false, willRetry: false }));
      } else {
        console.log(JSON.stringify({ id: command.id, type: "response", command: "compact", success: false, error: "simulated compaction failure" }));
        console.log(JSON.stringify({ type: "compaction_end", reason: "manual", result: null, aborted: false, willRetry: false, errorMessage: "simulated compaction failure" }));
      }
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
      const acceptPrompt = () => {
        if (!existsSync(sessionFile)) writeHeader();
        appendFileSync(sessionFile, JSON.stringify({ type: "message", id: command.id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: command.message }] } }) + "\\n");
        console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
        if (command.message === "Delay prompt acknowledgement") console.log(JSON.stringify({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 190000, estimatedTokensAfter: 30000 }, aborted: false, willRetry: false }));
        console.log(JSON.stringify({ type: "agent_start" }));
        if (command.message === "Recover context overflow") {
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Your input exceeds the context window of this model" } }));
          console.log(JSON.stringify({ type: "compaction_start", reason: "overflow" }));
          console.log(JSON.stringify({ type: "compaction_end", reason: "overflow", result: { tokensBefore: 200000, estimatedTokensAfter: 24000 }, aborted: false, willRetry: true }));
          console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" } }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
          return;
        }
        console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }));
        if (command.message === "Request interactive input") {
          console.log(JSON.stringify({ type: "extension_ui_request", id: "request-select", method: "select", title: "Choose safely", options: ["Allow", "Block"] }));
        } else if (command.message === "Request timed input") {
          console.log(JSON.stringify({ type: "extension_ui_request", id: "request-timeout", method: "input", title: "Answer quickly", timeout: 20 }));
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 150);
        } else if (command.message !== "Hold run open") {
          setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 50);
        }
      };
      if (command.message === "Delay prompt acknowledgement") {
        console.log(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        setTimeout(acceptPrompt, 10_100);
      } else {
        acceptPrompt();
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
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

function runtimeLayer(config: AppConfigShape, workspace: Workspace) {
  const dependencies = Layer.merge(
    Layer.merge(
      Layer.succeed(AppConfig, AppConfig.of(config)),
      Layer.succeed(
        WorkspaceRepository,
        WorkspaceRepository.of({
          list: Effect.succeed([workspace]),
          findById: (id) => Effect.succeed(id === workspace.id ? workspace : undefined),
          ensureCapacity: Effect.void,
          add: () => Effect.die("not used by runtime tests"),
          rename: () => Effect.die("not used by runtime tests"),
          remove: () => Effect.die("not used by runtime tests"),
        }),
      ),
    ),
    Layer.mergeAll(
      Layer.succeed(WorkspaceDirectory, WorkspaceDirectory.of({
        search: () => Effect.succeed([]),
        prepare: (path) => Effect.succeed(path),
        authorize: (path) => Effect.succeed(path),
        openAuthorized: (path) => Effect.promise(() => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)),
        rollbackCreated: () => Effect.die("not used by runtime tests"),
      })),
      Layer.succeed(FileMentionSearch, FileMentionSearch.of({
        search: (_root, query) => Effect.succeed([{ path: `src/${query}.ts`, name: `${query}.ts`, kind: "file" }]),
        release: () => Effect.void,
      })),
      Layer.succeed(PushNotifications, PushNotifications.of({
        capability: { supported: true, vapidPublicKey: "test" },
        subscribe: () => Effect.void,
        unsubscribe: () => Effect.void,
        notify: () => Effect.void,
      })),
    ),
  );
  return PiRuntimeSupervisorLive.pipe(Layer.provideMerge(dependencies));
}

test("completed messages survive noisy streams while redundant progress is coalesced", () => {
  let events: ReadonlyArray<OwnedSessionEvent> = [];
  let bytes = 0;
  const append = (sequence: number, type: string, data: unknown) => {
    const retained = appendBoundedEvent(events, bytes, {
      sequence,
      type,
      timestamp: new Date(sequence * 1_000).toISOString(),
      data,
    });
    events = retained.events;
    bytes = retained.bytes;
  };

  append(1, "message_end", { message: { role: "user", content: [{ type: "text", text: "Keep my latest prompt" }] } });
  append(2, "message_start", { message: { role: "assistant", content: [] } });
  for (let sequence = 3; sequence <= 1_002; sequence += 1) {
    append(sequence, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
  }
  assert.equal(events.length, 750);
  assert.ok(events.some((event) => event.sequence === 1), "completed user messages are retained ahead of streaming noise");
  assert.equal(events.at(-1)?.sequence, 1_002);

  append(1_003, "tool_execution_start", { toolCallId: "tool-1", toolName: "bash", args: { command: "test" } });
  append(1_004, "tool_execution_update", { toolCallId: "tool-1", toolName: "bash", partialResult: "partial" });
  append(1_005, "tool_execution_update", { toolCallId: "tool-1", toolName: "bash", partialResult: "newer" });
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 1);
  append(1_006, "tool_execution_end", { toolCallId: "tool-1", toolName: "bash", result: "done" });
  append(1_007, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "done" } });
  append(1_008, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });

  assert.equal(events.filter((event) => event.type === "message_update").length, 0);
  assert.equal(events.filter((event) => event.type === "message_start").length, 0);
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 0);
  assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 0);
  assert.deepEqual(events.filter((event) => event.type === "message_end").map((event) => event.sequence), [1, 1_008]);
  assert.equal(events.find((event) => event.type === "tool_execution_end")?.sequence, 1_006);
});

test("reconstructs completed tool calls from a resumed Pi transcript", () => {
  assert.deepEqual(replayEventsFromTranscriptEntry({
    type: "message",
    id: "tool-entry",
    message: {
      role: "toolResult",
      toolCallId: "call-restored",
      toolName: "bash",
      content: [{ type: "text", text: "restored output" }],
      isError: false,
    },
  }), [{
    type: "tool_execution_end",
    data: {
      toolCallId: "call-restored",
      toolName: "bash",
      result: { content: [{ type: "text", text: "restored output" }] },
      isError: false,
    },
  }]);
});

test("bounded history does not discard newer completed tools ahead of older messages", () => {
  let events: ReadonlyArray<OwnedSessionEvent> = [];
  let bytes = 0;
  const append = (event: OwnedSessionEvent) => {
    const retained = appendBoundedEvent(events, bytes, event);
    events = retained.events;
    bytes = retained.bytes;
  };

  for (let sequence = 1; sequence <= 500; sequence += 1) {
    append({ sequence, type: "message_end", timestamp: new Date(sequence * 1_000).toISOString(), data: { message: { role: "assistant", content: [{ type: "text", text: `message ${sequence}` }] } } });
  }
  append({ sequence: 501, type: "tool_execution_end", timestamp: new Date(501_000).toISOString(), data: { toolCallId: "important-tool", toolName: "bash", result: "done" } });
  for (let sequence = 502; sequence <= 751; sequence += 1) {
    append({ sequence, type: "message_end", timestamp: new Date(sequence * 1_000).toISOString(), data: { message: { role: "assistant", content: [{ type: "text", text: `message ${sequence}` }] } } });
  }

  assert.equal(events.length, 750);
  assert.ok(events.some((event) => eventToolId(event) === "important-tool"));
  assert.ok(!events.some((event) => event.sequence === 1));
});

function eventToolId(event: OwnedSessionEvent): string | undefined {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
  const id = (event.data as Record<string, unknown>).toolCallId;
  return typeof id === "string" ? id : undefined;
}

test("bounded tool events retain lifecycle correlation identifiers", () => {
  const projected = projectEventData("tool_execution_update", {
    type: "tool_execution_update",
    toolCallId: "call-large",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "x".repeat(300_000) }] },
  });
  assert.equal((projected as Record<string, unknown>).truncated, true);
  assert.equal((projected as Record<string, unknown>).type, "tool_execution_update");
  assert.equal((projected as Record<string, unknown>).toolCallId, "call-large");
  assert.equal((projected as Record<string, unknown>).toolName, "bash");
  assert.ok(Number((projected as Record<string, unknown>).originalBytes) > 256 * 1024);
  assert.match(JSON.stringify((projected as Record<string, unknown>).partialResult), /truncated by PISS/);

  const failedTool = projectEventData("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "call-failed",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failure".repeat(60_000) }] },
    isError: true,
  }) as Record<string, unknown>;
  assert.equal(failedTool.toolCallId, "call-failed");
  assert.equal(failedTool.isError, true);
  assert.match(JSON.stringify(failedTool.result), /truncated by PISS/);

  const messageEnd = projectEventData("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider failure".repeat(30_000),
      content: [{ type: "text", text: "answer".repeat(60_000) }],
    },
  }) as { message: { role: string; errorMessage: string; content: Array<{ text: string }> } };
  assert.equal(messageEnd.message.role, "assistant");
  assert.match(messageEnd.message.content[0]?.text ?? "", /truncated by PISS/);
  assert.match(messageEnd.message.errorMessage, /truncated by PISS/);
  assert.ok(Buffer.byteLength(messageEnd.message.errorMessage) < 34 * 1024);

  const imageMessage = projectEventData("message_end", {
    message: {
      role: "user",
      content: [
        { type: "text", text: "Inspect this" },
        { type: "image", mimeType: "image/png", data: "sensitive-base64-data" },
      ],
    },
  }) as { message: { content: Array<Record<string, unknown>> } };
  assert.deepEqual(imageMessage.message.content[1], { type: "image", mimeType: "image/png" });
  assert.doesNotMatch(JSON.stringify(imageMessage), /sensitive-base64-data/);

  const agentEnd = projectEventData("agent_end", {
    messages: [{ role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: "another-secret" }] }],
    willRetry: false,
  });
  assert.deepEqual((agentEnd as { messages: Array<{ content: unknown[] }> }).messages[0]?.content[0], { type: "image", mimeType: "image/jpeg" });
  assert.doesNotMatch(JSON.stringify(agentEnd), /another-secret/);
});

test("owns a Pi RPC process and projects its lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-runtime-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-test.jsonl");

  try {
    const piCommand = await fakePi(directory, true);
    const workspaceId = decodeWorkspaceId("piss-test-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "PISS test",
      root: directory,
      trustProjectResources: true,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };
    const live = runtimeLayer(config, workspace);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* PiRuntimeSupervisor;
          const created = yield* supervisor.create({ workspaceId, name: "First owned session", prompt: "Say done" });
          let current = created;
          for (let attempt = 0; attempt < 100 && current.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Delay prompt acknowledgement");
          current = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && current.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Recover context overflow");
          let recoveredOverflow = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && recoveredOverflow.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            recoveredOverflow = yield* supervisor.get(created.id);
          }
          const models = yield* supervisor.listModels({ sessionId: created.id, runtimeId: created.runtimeId });
          const slashCommands = yield* supervisor.listCommands({ sessionId: created.id, runtimeId: created.runtimeId });
          const mentions = yield* supervisor.searchMentions({ sessionId: created.id, runtimeId: created.runtimeId }, "app");
          const configuredThinking = yield* supervisor.setThinkingLevel({ sessionId: created.id, runtimeId: created.runtimeId }, "high");
          const configuredModel = yield* supervisor.setModel({ sessionId: created.id, runtimeId: created.runtimeId }, "test", "model-b");
          const withUsage = yield* supervisor.refreshUsage({ sessionId: created.id, runtimeId: created.runtimeId });
          const compacted = yield* supervisor.compact({ sessionId: created.id, runtimeId: created.runtimeId });
          const compactionFailureTag = yield* supervisor.compact({ sessionId: created.id, runtimeId: created.runtimeId }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const compactionFailed = yield* supervisor.get(created.id);
          const autoCompaction = yield* supervisor.setAutoCompaction({ sessionId: created.id, runtimeId: created.runtimeId }, false);
          const staleResult = yield* supervisor.abort({ sessionId: created.id, runtimeId: "stale-runtime" }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Request interactive input");
          let interactiveBlocked = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && interactiveBlocked.status !== "blocked"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveBlocked = yield* supervisor.get(created.id);
          }
          const staleInteractive = yield* supervisor.respondInteractive(
            { sessionId: created.id, runtimeId: "stale-runtime" },
            { requestId: "request-select", value: "Allow" },
          ).pipe(Effect.as("unexpected-success"), Effect.catch((error) => Effect.succeed(error._tag)));
          yield* supervisor.respondInteractive(
            { sessionId: created.id, runtimeId: created.runtimeId },
            { requestId: "request-select", value: "Allow" },
          );
          let interactiveFinished = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && interactiveFinished.status !== "finished"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveFinished = yield* supervisor.get(created.id);
          }
          yield* supervisor.prompt({ sessionId: created.id, runtimeId: created.runtimeId }, "Request timed input");
          let interactiveTimedOut = yield* supervisor.get(created.id);
          for (let attempt = 0; attempt < 100 && !interactiveTimedOut.error?.includes("timed out"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            interactiveTimedOut = yield* supervisor.get(created.id);
          }
          const archived = yield* supervisor.create({ workspaceId, name: "Archived while active" });
          const activeRemovalResult = yield* supervisor.remove({ sessionId: archived.id, runtimeId: archived.runtimeId }).pipe(
            Effect.as("archived"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const archivedLookup = yield* supervisor.get(archived.id).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          const concurrentTarget = yield* supervisor.create({ workspaceId, name: "Concurrent archive" });
          yield* supervisor.stop({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId });
          const concurrentRemovalResults = yield* Effect.all([
            supervisor.remove({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId }).pipe(
              Effect.as("removed"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            ),
            supervisor.remove({ sessionId: concurrentTarget.id, runtimeId: concurrentTarget.runtimeId }).pipe(
              Effect.as("removed"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            ),
          ], { concurrency: "unbounded" });
          const removedLookup = yield* supervisor.get(concurrentTarget.id).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.stop({ sessionId: created.id, runtimeId: created.runtimeId });
          const stopped = yield* supervisor.get(created.id);
          const capacitySessions = yield* Effect.forEach(
            Array.from({ length: 50 }, (_, index) => index),
            (index) => supervisor.create({ workspaceId, name: `Capacity ${index + 1}` }),
          );
          const activeLimitResult = yield* supervisor.create({ workspaceId, name: "Over capacity" }).pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* Effect.forEach(
            capacitySessions,
            (session) => supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId }),
            { discard: true },
          );
          const concurrentSessions = yield* Effect.all([
            supervisor.create({ workspaceId, name: "Concurrent one" }),
            supervisor.create({ workspaceId, name: "Concurrent two" }),
          ], { concurrency: "unbounded" });
          yield* Effect.forEach(
            concurrentSessions,
            (session) => supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId }),
            { discard: true },
          );
          const empty = yield* supervisor.create({ workspaceId, name: "" });
          yield* supervisor.prompt({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Hold run open");
          const configurationWhileWorking = yield* supervisor.setModel({ sessionId: empty.id, runtimeId: empty.runtimeId }, "test", "model-a").pipe(
            Effect.as("unexpected-success"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          yield* supervisor.prompt({ sessionId: empty.id, runtimeId: empty.runtimeId }, "/review");
          yield* supervisor.steer({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Steer while working");
          yield* supervisor.followUp({ sessionId: empty.id, runtimeId: empty.runtimeId }, "Follow up after settling");
          let prompted = yield* supervisor.get(empty.id);
          for (let attempt = 0; attempt < 100 && !prompted.events.some((event) => event.type === "message_update"); attempt += 1) {
            yield* Effect.sleep("10 millis");
            prompted = yield* supervisor.get(empty.id);
          }
          yield* supervisor.stop({ sessionId: empty.id, runtimeId: empty.runtimeId });
          return { current, recoveredOverflow, models, slashCommands, mentions, configuredThinking, configuredModel, withUsage, compacted, compactionFailureTag, compactionFailed, autoCompaction, staleResult, interactiveBlocked, interactiveFinished, interactiveTimedOut, staleInteractive, archived, activeRemovalResult, archivedLookup, concurrentRemovalResults, removedLookup, stopped, activeLimitResult, concurrentSessions, empty, configurationWhileWorking, prompted };
        }).pipe(Effect.provide(live)),
      ),
    );

    assert.equal(result.current.status, "finished");
    assert.equal(result.current.piSessionId, "pi-test-session");
    assert.equal(result.current.sessionFile, join(directory, "pi-test.jsonl"));
    assert.ok(result.current.events.some((event) => event.type === "message_update"));
    assert.equal(result.recoveredOverflow.status, "finished");
    assert.equal(result.recoveredOverflow.error, null, "successful overflow recovery clears the transient provider error");
    assert.equal(result.recoveredOverflow.compaction.status, "succeeded");
    assert.equal(result.recoveredOverflow.compaction.reason, "overflow");
    assert.deepEqual(result.models.map((model) => model.id), ["model-a", "model-b"]);
    assert.deepEqual(result.models[0]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
    assert.deepEqual(result.slashCommands, [
      { name: "review", description: "Review changes", source: "extension", scope: "user" },
      { name: "fix-tests", description: "Fix tests", source: "prompt", scope: "project" },
    ]);
    assert.doesNotMatch(JSON.stringify(result.slashCommands), /secret/);
    assert.deepEqual(result.mentions, [{ path: "src/app.ts", name: "app.ts", kind: "file" }]);
    assert.equal(result.configuredThinking.thinkingLevel, "high");
    assert.equal(result.configuredModel.model?.id, "model-b");
    assert.equal(result.configuredModel.thinkingLevel, "off");
    assert.equal(result.withUsage.usage?.contextUsage?.percent, 15);
    assert.equal(result.withUsage.usage?.cost, 0.25);
    assert.equal(result.compacted.compaction.status, "succeeded");
    assert.equal(result.compacted.compaction.tokensBefore, 30000);
    assert.equal(result.compacted.compaction.estimatedTokensAfter, 9000);
    assert.equal(result.compactionFailureTag, "PiCommandError");
    assert.equal(result.compactionFailed.compaction.status, "failed");
    assert.match(result.compactionFailed.compaction.error ?? "", /simulated compaction failure/);
    assert.equal(result.autoCompaction.autoCompactionEnabled, false);
    assert.doesNotMatch(JSON.stringify({ models: result.models, events: result.configuredModel.events }), /super-secret|credential@example/);
    assert.equal(result.staleResult, "StaleRuntimeGenerationError");
    assert.equal(result.interactiveBlocked.status, "blocked");
    assert.equal(result.interactiveBlocked.interactiveRequests[0]?.method, "select");
    assert.equal(result.interactiveFinished.status, "finished");
    assert.deepEqual(result.interactiveFinished.interactiveRequests, []);
    assert.deepEqual(result.interactiveTimedOut.interactiveRequests, []);
    assert.match(result.interactiveTimedOut.error ?? "", /timed out/i);
    assert.equal(result.staleInteractive, "StaleRuntimeGenerationError");
    assert.equal(result.archived.workspaceId, result.current.workspaceId);
    assert.equal(result.archived.status, "idle");
    assert.equal(result.activeRemovalResult, "archived");
    assert.equal(result.archivedLookup, "SessionNotFoundError");
    assert.deepEqual([...result.concurrentRemovalResults].sort(), ["SessionNotFoundError", "removed"]);
    assert.equal(result.removedLookup, "SessionNotFoundError");
    assert.equal(result.stopped.status, "stopped");
    assert.equal(result.activeLimitResult, "ActiveRuntimeLimitError");
    assert.equal(result.concurrentSessions.length, 2);
    assert.ok(result.concurrentSessions.every((session) => session.workspaceId === result.current.workspaceId));
    assert.equal(result.empty.name, "New session");
    assert.equal(result.empty.status, "idle");
    assert.equal(result.empty.events.length, 0);
    assert.equal(result.configurationWhileWorking, "PiCommandError");
    assert.ok(result.prompted.events.some((event) => event.type === "message_update"));
    const persisted = JSON.parse(await readFile(join(directory, "owned-sessions.json"), "utf8")) as { sessions: Array<{ id: string; sessionFileIdentity: unknown }> };
    assert.ok(persisted.sessions.find((session) => session.id === result.current.id)?.sessionFileIdentity, "lazy Pi transcript identity is captured after the run settles");
    const wireCommands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.ok(wireCommands.includes("steer"));
    assert.ok(wireCommands.includes("follow_up"));
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    for (const args of argumentSets) {
      assert.ok(args.includes("--mode"));
      assert.ok(args.includes("rpc"));
      assert.ok(args.includes("--approve"));
    }
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports a validated Pi transcript and resumes it in an owned runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-import-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const sessionFile = join(directory, "pi-import.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = sessionFile;

  try {
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: directory }),
      JSON.stringify({ type: "message", id: "imported-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Preserved import" }] } }),
      "",
    ].join("\n"));
    const piCommand = await fakePi(directory);
    const workspaceId = decodeWorkspaceId("piss-import-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Import test",
      root: directory,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const imported = yield* supervisor.import({ workspaceId, name: "Imported session", sessionFile });
      const duplicate = yield* supervisor.import({ workspaceId, name: "Duplicate", sessionFile }).pipe(
        Effect.as("unexpected"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      const resumed = yield* supervisor.resume({ sessionId: imported.id, runtimeId: imported.runtimeId });
      return { imported, duplicate, resumed };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(result.imported.status, "stopped");
    assert.equal(result.imported.piSessionId, "pi-test-session");
    assert.equal(result.imported.sessionFile, sessionFile);
    assert.equal(result.duplicate, "SessionResumeError");
    assert.equal(result.resumed.id, result.imported.id);
    assert.notEqual(result.resumed.runtimeId, result.imported.runtimeId);
    assert.ok(result.resumed.events.some((event) => JSON.stringify(event.data).includes("Preserved import")));
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(argumentSets[0]?.includes("--session"));
    assert.ok(argumentSets[0]?.includes(sessionFile));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupting creation terminates the child and preserves a visible failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-interrupt-"));
  const argsFile = join(directory, "args.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousHang = process.env.FAKE_PI_HANG;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_HANG = "1";
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-test.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceId = decodeWorkspaceId("piss-interrupt-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Interrupt test",
      root: directory,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* PiRuntimeSupervisor;
          const fiber = yield* supervisor
            .create({ workspaceId, name: "Interrupted", prompt: "Never accepted" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.sleep("30 millis");
          yield* Fiber.interrupt(fiber);
          const sessions = yield* supervisor.list;
          return sessions[0];
        }).pipe(Effect.provide(runtimeLayer(config, workspace))),
      ),
    );

    assert.ok(result);
    assert.equal(result.status, "crashed");
    assert.match(result.error ?? "", /interrupted/i);
    if (result.pid !== null) assert.throws(() => process.kill(result.pid!, 0));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousHang === undefined) delete process.env.FAKE_PI_HANG;
    else process.env.FAKE_PI_HANG = previousHang;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recreates an unmaterialized idle runtime under the same session after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-lazy-restart-"));
  const argsFile = join(directory, "args.jsonl");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-lazy-restart.jsonl");

  try {
    const piCommand = await fakePi(directory, true);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-lazy-restart-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Lazy restart test",
      root: workspaceRoot,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: join(directory, "state"),
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const created = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      return yield* supervisor.create({ workspaceId, name: "Blank but durable" });
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const resumed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = (yield* supervisor.list)[0]!;
      yield* supervisor.stop({ sessionId: session.id, runtimeId: session.runtimeId });
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    assert.equal(resumed.id, created.id);
    assert.notEqual(resumed.runtimeId, created.runtimeId);
    assert.equal(resumed.status, "idle");
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(argumentSets.length, 2);
    assert.ok(argumentSets.every((arguments_) => !arguments_.includes("--session")));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatically resumes an active runtime after supervisor restart without duplicating commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-resume-"));
  const argsFile = join(directory, "args.jsonl");
  const commandsFile = join(directory, "commands.txt");
  const previousArgsFile = process.env.FAKE_PI_ARGS;
  const previousCommandsFile = process.env.FAKE_PI_COMMANDS;
  const previousSessionFile = process.env.FAKE_PI_SESSION_FILE;
  process.env.FAKE_PI_ARGS = argsFile;
  process.env.FAKE_PI_COMMANDS = commandsFile;
  process.env.FAKE_PI_SESSION_FILE = join(directory, "pi-resume.jsonl");

  try {
    const piCommand = await fakePi(directory);
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot);
    const workspaceId = decodeWorkspaceId("piss-resume-deadbeef");
    const workspace: Workspace = {
      id: workspaceId,
      name: "Resume test",
      root: workspaceRoot,
      trustProjectResources: false,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      activeSessionCount: 0,
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: join(directory, "state"),
      publicDir: directory,
      piCommand,
      piSessionRoots: [directory],
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };

    const created = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const session = yield* supervisor.create({ workspaceId, name: "Survives restart" });
      yield* supervisor.prompt(
        { sessionId: session.id, runtimeId: session.runtimeId },
        "Accepted before the control plane disappeared",
        [],
        "lost-response-command",
      );
      let settled = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 100 && settled.status !== "finished"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        settled = yield* supervisor.get(session.id);
      }
      yield* supervisor.prompt(
        { sessionId: session.id, runtimeId: session.runtimeId },
        "Request interactive input",
        [],
        "pending-interactive-command",
      );
      let blocked = yield* supervisor.get(session.id);
      for (let attempt = 0; attempt < 100 && blocked.status !== "blocked"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        blocked = yield* supervisor.get(session.id);
      }
      return session;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const shutdownState = JSON.parse(await readFile(join(config.stateDir, "owned-sessions.json"), "utf8")) as {
      sessions: Array<{ status: string; resumeAfterRestart?: boolean; interactiveRequests?: unknown[]; error?: string | null }>;
    };
    const stoppedForUpdate = shutdownState.sessions[0]!;

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const resumed = (yield* supervisor.list)[0]!;
      const stale = yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: created.runtimeId },
        "must not reach replacement runtime",
      ).pipe(Effect.as("unexpected"), Effect.catch((error) => Effect.succeed(error._tag)));
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "Accepted before the control plane disappeared",
        [],
        "lost-response-command",
      );
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "A new command",
        [],
        "deduplicated-command",
      );
      let settled = yield* supervisor.get(resumed.id);
      for (let attempt = 0; attempt < 100 && settled.status !== "finished"; attempt += 1) {
        yield* Effect.sleep("10 millis");
        settled = yield* supervisor.get(resumed.id);
      }
      yield* supervisor.prompt(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "A new command",
        [],
        "deduplicated-command",
      );
      const staleRename = yield* supervisor.rename(
        { sessionId: resumed.id, runtimeId: created.runtimeId },
        "Must not apply",
      ).pipe(Effect.as("unexpected"), Effect.catch((error) => Effect.succeed(error._tag)));
      const renamed = yield* supervisor.rename(
        { sessionId: resumed.id, runtimeId: resumed.runtimeId },
        "Renamed across restart",
      );
      yield* supervisor.stop({ sessionId: renamed.id, runtimeId: renamed.runtimeId });
      return { resumed, renamed, stale, staleRename };
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));

    const stoppedAfterManualRestart = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      return (yield* supervisor.list)[0]!;
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));
    assert.equal(stoppedAfterManualRestart.status, "stopped");
    assert.equal(stoppedAfterManualRestart.runtimeId, result.resumed.runtimeId);
    assert.equal(stoppedAfterManualRestart.name, "Renamed across restart");

    const sessionPath = join(directory, "pi-resume.jsonl");
    const originalSessionPath = join(directory, "pi-resume-original.jsonl");
    const attemptResume = () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const supervisor = yield* PiRuntimeSupervisor;
      const persisted = (yield* supervisor.list)[0]!;
      return yield* supervisor.resume({ sessionId: persisted.id, runtimeId: persisted.runtimeId }).pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
    }).pipe(Effect.provide(runtimeLayer(config, workspace)))));
    const originalWorkspaceRoot = join(directory, "workspace-original");
    await rename(workspaceRoot, originalWorkspaceRoot);
    await mkdir(workspaceRoot);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(workspaceRoot, { recursive: true });
    await rename(originalWorkspaceRoot, workspaceRoot);

    await rename(sessionPath, originalSessionPath);
    await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "pi-test-session", timestamp: new Date().toISOString(), cwd: workspaceRoot })}\n`);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(sessionPath);
    await symlink(originalSessionPath, sessionPath);
    assert.equal(await attemptResume(), "SessionResumeError");
    await rm(sessionPath);
    assert.equal(await attemptResume(), "SessionResumeError");

    assert.equal(stoppedForUpdate.status, "stopped");
    assert.equal(stoppedForUpdate.resumeAfterRestart, true);
    assert.deepEqual(stoppedForUpdate.interactiveRequests, []);
    assert.match(stoppedForUpdate.error ?? "", /interactive request.*cancelled/i);
    assert.equal(result.resumed.id, created.id);
    assert.notEqual(result.resumed.runtimeId, created.runtimeId);
    assert.equal(result.resumed.piSessionId, created.piSessionId);
    assert.ok(result.resumed.events.some((event) => event.type === "message_end" && JSON.stringify(event.data).includes("Accepted before")));
    assert.equal(result.stale, "StaleRuntimeGenerationError");
    assert.equal(result.staleRename, "StaleRuntimeGenerationError");
    assert.equal(result.renamed.name, "Renamed across restart");
    const commands = (await readFile(commandsFile, "utf8")).trim().split("\n");
    assert.equal(commands.filter((command) => command === "prompt").length, 3);
    const argumentSets = (await readFile(argsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(argumentSets.at(-1)?.includes("--session"));
    assert.ok(argumentSets.at(-1)?.includes(join(directory, "pi-resume.jsonl")));
  } finally {
    if (previousArgsFile === undefined) delete process.env.FAKE_PI_ARGS;
    else process.env.FAKE_PI_ARGS = previousArgsFile;
    if (previousCommandsFile === undefined) delete process.env.FAKE_PI_COMMANDS;
    else process.env.FAKE_PI_COMMANDS = previousCommandsFile;
    if (previousSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE;
    else process.env.FAKE_PI_SESSION_FILE = previousSessionFile;
    await rm(directory, { recursive: true, force: true });
  }
});
