import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { browserUser, validBrowserOrigin } from "./browser-auth.ts";
import { validateImages } from "../shared/imageValidation.ts";
import {
  CreateOwnedSessionInput,
  CreateWorkspaceInput,
  EngineeringWorkflowMutationInput,
  ImportOwnedSessionInput,
  InteractiveResponseInput,
  OwnedSessionCommandInput,
  PushSubscriptionMutation,
  RenameOwnedSessionInput,
  RenameWorkspaceInput,
  ResumeOwnedSessionInput,
  SessionConfigurationInput,
  WorkspaceId,
  type AvailableModelListResponse,
  type CreateWorkspaceResponse,
  type DirectorySearchResponse,
  type FileMentionSearchResponse,
  type OwnedSessionDetailResponse,
  type OwnedSessionListResponse,
  type OwnedSessionStreamResponse,
  type OwnedSessionTimelinePageResponse,
  type OwnedSessionToolOutputResponse,
  type PiSlashCommandListResponse,
  type ReviewSnapshotResponse,
  type WorkspaceListResponse,
} from "../shared/domain.ts";
import { AppConfig, type AppConfigShape } from "./config.ts";
import { HttpRequestError, HttpServerError, StaticAssetError } from "./errors.ts";
import { PiRuntimeSupervisor } from "./runtimes/PiRuntimeSupervisor.ts";
import { loadOwnedSessionArtifact } from "./runtimes/OwnedSessionArtifactStore.ts";
import { PushNotifications } from "./notifications/PushNotifications.ts";
import { WorkspaceReview } from "./reviews/WorkspaceReview.ts";
import { WorkspaceDirectory } from "./workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepository } from "./workspaces/WorkspaceRepository.ts";
import { WorkspaceStorageError } from "./workspaces/errors.ts";
import { listWorkspaces } from "./workspaces/listWorkspaces.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_COMMAND_REQUEST_BYTES = 16 * 1024 * 1024;
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function requestErrorStatus(error: unknown): number {
  if (error instanceof HttpRequestError) return error.status;
  if (typeof error !== "object" || error === null || !("_tag" in error)) return 500;
  switch ((error as { _tag: unknown })._tag) {
    case "WorkspaceNotFoundError":
    case "WorkspaceRecordNotFoundError":
    case "SessionNotFoundError":
      return 404;
    case "WorkspacePathError":
      return 400;
    case "WorkspaceAlreadyExistsError":
    case "WorkspaceManagedByConfigurationError":
    case "WorkspaceHasSessionsError":
    case "StaleRuntimeGenerationError":
    case "PiCommandError":
    case "SessionResumeError":
      return 409;
    case "SessionLimitError":
    case "ActiveRuntimeLimitError":
      return 429;
    case "PiSpawnError":
      return 502;
    case "WorkspaceReviewError":
      return 422;
    case "FileMentionSearchError":
      return 503;
    default:
      return 500;
  }
}

function requestErrorMessage(error: unknown): string {
  const status = requestErrorStatus(error);
  if (status === 500) return "Internal server error";
  return error instanceof Error ? error.message : "Request failed";
}

function requireBrowser(request: IncomingMessage, config: AppConfigShape, mutation: boolean): Effect.Effect<string, HttpRequestError> {
  const user = browserUser(request, config.browserAuth);
  if (!user) return Effect.fail(new HttpRequestError({ status: 401, message: "A permitted Tailscale identity is required" }));
  if (mutation && !validBrowserOrigin(request, config.browserAuth)) {
    return Effect.fail(new HttpRequestError({ status: 403, message: "The request origin is not permitted" }));
  }
  return Effect.succeed(user);
}

function readJson(request: IncomingMessage, maximumBytes = MAX_REQUEST_BYTES): Effect.Effect<unknown, HttpRequestError> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Effect.fail(new HttpRequestError({ status: 415, message: "Content-Type must be application/json" }));
  }
  return Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of request) {
        const chunk = Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > maximumBytes) throw new HttpRequestError({ status: 413, message: "Request body is too large" });
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    },
    catch: (cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Request body must be valid JSON", cause }),
  });
}

function decodeCreateRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CreateOwnedSessionInput)),
    Effect.map((input) => {
      const prompt = input.prompt?.trim();
      return {
        workspaceId: input.workspaceId,
        name: input.name.trim() || "New session",
        ...(prompt ? { prompt } : {}),
      };
    }),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid owned-session request", cause })),
  );
}

function decodeImportRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ImportOwnedSessionInput)),
    Effect.flatMap((input) => input.name.trim()
      ? Effect.succeed({ ...input, name: input.name.trim() })
      : Effect.fail(new HttpRequestError({ status: 400, message: "Imported session name cannot be blank" }))),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid session import request", cause })),
  );
}

function decodeWorkspaceRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CreateWorkspaceInput)),
    Effect.flatMap((input) => input.name.trim() && input.path.trim()
      ? Effect.succeed({ ...input, name: input.name.trim(), path: input.path.trim() })
      : Effect.fail(new HttpRequestError({ status: 400, message: "Workspace name and path cannot be blank" }))),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid workspace request", cause })),
  );
}

function decodeRenameWorkspaceRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RenameWorkspaceInput)),
    Effect.flatMap((input) => input.name.trim()
      ? Effect.succeed({ name: input.name.trim() })
      : Effect.fail(new HttpRequestError({ status: 400, message: "Workspace name cannot be blank" }))),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid workspace rename request", cause })),
  );
}

function decodeRenameSessionRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RenameOwnedSessionInput)),
    Effect.flatMap((input) => input.name.trim()
      ? Effect.succeed({ ...input, name: input.name.trim() })
      : Effect.fail(new HttpRequestError({ status: 400, message: "Session name cannot be blank" }))),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid session rename request", cause })),
  );
}

function decodeCommandRequest(request: IncomingMessage) {
  return readJson(request, MAX_COMMAND_REQUEST_BYTES).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnedSessionCommandInput)),
    Effect.flatMap((input) => {
      const imageError = validateImages(input.images ? [...input.images] : undefined);
      return imageError
        ? Effect.fail(new HttpRequestError({ status: 400, message: imageError }))
        : Effect.succeed(input);
    }),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid session command", cause })),
  );
}

function decodePushSubscriptionMutation(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PushSubscriptionMutation)),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid notification subscription request", cause })),
  );
}

function decodeInteractiveResponse(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(InteractiveResponseInput)),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid interactive response", cause })),
  );
}

function decodeResumeRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ResumeOwnedSessionInput)),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid session resume request", cause })),
  );
}

function decodeConfigurationRequest(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SessionConfigurationInput)),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid session configuration", cause })),
  );
}

function decodeWorkflowMutation(request: IncomingMessage) {
  return readJson(request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EngineeringWorkflowMutationInput)),
    Effect.mapError((cause) => cause instanceof HttpRequestError
      ? cause
      : new HttpRequestError({ status: 400, message: "Invalid engineering workflow request", cause })),
  );
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  publicDir: string,
): Effect.Effect<void, StaticAssetError> {
  return Effect.tryPromise({
    try: async () => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
      let filePath = resolve(publicDir, requestedPath);
      const traversal = relative(publicDir, filePath);
      if (traversal.startsWith("..")) throw new Error("Path traversal rejected");

      try {
        const metadata = await stat(filePath);
        if (metadata.isDirectory()) filePath = resolve(filePath, "index.html");
        else if (!metadata.isFile()) throw new Error("Not a file");
      } catch {
        filePath = resolve(publicDir, "index.html");
      }

      const body = await readFile(filePath);
      const fileName = filePath.split("/").at(-1) ?? "";
      const cacheControl = filePath.endsWith("index.html") || fileName === "service-worker.js" || fileName === "manifest.webmanifest"
        ? "no-cache"
        : filePath.includes("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=86400";
      response.writeHead(200, {
        ...securityHeaders(),
        "Cache-Control": cacheControl,
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    },
    catch: (cause) => new StaticAssetError({ path: request.url ?? "/", cause }),
  });
}

function makeRequestHandler() {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const repository = yield* WorkspaceRepository;
    const directories = yield* WorkspaceDirectory;
    const supervisor = yield* PiRuntimeSupervisor;
    const reviews = yield* WorkspaceReview;
    const notifications = yield* PushNotifications;
    const workspaceMutationLock = yield* Semaphore.make(1);
    const workspaceProgram = listWorkspaces.pipe(Effect.provideService(WorkspaceRepository, repository));

    return (request: IncomingMessage, response: ServerResponse): void => {
      const requestAbort = new AbortController();
      const route = Effect.gen(function* () {
        const requestUrl = yield* Effect.try({
          try: () => new URL(request.url ?? "/", "http://localhost"),
          catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed request target", cause }),
        });
        const pathname = requestUrl.pathname;

        if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
          json(response, 200, {
            ok: true,
            apiVersion: 1,
            architecture: "effect-v4",
            deploymentProtocolVersion: 1,
            updateActivation: "quiescent-sigusr2",
          });
          return;
        }

        if (pathname === "/api/notifications" && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          json(response, 200, notifications.capability);
          return;
        }

        if (pathname === "/api/notifications" && request.method === "POST") {
          const user = yield* requireBrowser(request, config, true);
          const input = yield* decodePushSubscriptionMutation(request);
          if (input.action === "subscribe") yield* notifications.subscribe(user, input.subscription);
          else yield* notifications.unsubscribe(user, input.endpoint);
          json(response, 200, { enabled: input.action === "subscribe" });
          return;
        }

        if (pathname === "/api/workspaces" && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const [body, counts] = yield* Effect.all([workspaceProgram, supervisor.workspaceCounts]);
          const workspaces = body.workspaces.map((workspace) => {
            const count = counts.get(workspace.id) ?? { sessions: 0, active: 0 };
            return { ...workspace, sessionCount: count.sessions, activeSessionCount: count.active };
          });
          json(response, 200, { workspaces } satisfies WorkspaceListResponse);
          return;
        }

        if (pathname === "/api/workspaces" && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const input = yield* decodeWorkspaceRequest(request);
          const workspace = yield* workspaceMutationLock.withPermit(Effect.gen(function* () {
            yield* repository.ensureCapacity;
            const root = yield* directories.prepare(input.path, input.createDirectory, input.directoryName?.trim());
            const registration = repository.add({
              name: input.name,
              root,
              trustProjectResources: input.trustProjectResources,
            });
            return yield* (input.createDirectory
              ? registration.pipe(Effect.catch((registrationError) => directories.rollbackCreated(root).pipe(
                  Effect.catch((cleanupError) => Effect.fail(new WorkspaceStorageError({
                    message: `Workspace registration failed and ${root} could not be removed`,
                    cause: { registrationError, cleanupError },
                  }))),
                  Effect.andThen(Effect.fail(registrationError)),
                )))
              : registration);
          }));
          json(response, 201, { workspace } satisfies CreateWorkspaceResponse);
          return;
        }

        const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(pathname);
        if (workspaceMatch && request.method === "PATCH") {
          yield* requireBrowser(request, config, true);
          const workspaceId = yield* Effect.try({
            try: () => decodeWorkspaceId(decodeURIComponent(workspaceMatch[1]!)),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed workspace ID", cause }),
          });
          const input = yield* decodeRenameWorkspaceRequest(request);
          const workspace = yield* workspaceMutationLock.withPermit(repository.rename(workspaceId, input.name));
          json(response, 200, { workspace } satisfies CreateWorkspaceResponse);
          return;
        }

        if (workspaceMatch && request.method === "DELETE") {
          yield* requireBrowser(request, config, true);
          const workspaceId = yield* Effect.try({
            try: () => decodeWorkspaceId(decodeURIComponent(workspaceMatch[1]!)),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed workspace ID", cause }),
          });
          yield* workspaceMutationLock.withPermit(supervisor.removeWorkspace(workspaceId));
          json(response, 200, { deleted: true });
          return;
        }

        if (pathname === "/api/directories" && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const query = requestUrl.searchParams.get("query")?.trim() ?? "";
          if (query.length > 200) return yield* Effect.fail(new HttpRequestError({ status: 400, message: "Directory query is too long" }));
          const candidates = yield* directories.search(query);
          json(response, 200, { candidates } satisfies DirectorySearchResponse);
          return;
        }

        if (pathname === "/api/sessions" && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessions = yield* supervisor.listSummaries;
          json(response, 200, { sessions } satisfies OwnedSessionListResponse);
          return;
        }

        if (pathname === "/api/sessions" && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const input = yield* decodeCreateRequest(request);
          const session = yield* supervisor.create(input);
          json(response, 201, { session });
          return;
        }

        if (pathname === "/api/sessions/import" && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const input = yield* decodeImportRequest(request);
          const session = yield* supervisor.import(input);
          json(response, 201, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const timelineMatch = /^\/api\/sessions\/([^/]+)\/timeline$/.exec(pathname);
        if (timelineMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(timelineMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const rawBefore = requestUrl.searchParams.get("beforeSequence");
          const beforeSequence = rawBefore === null ? undefined : Number(rawBefore);
          const rawLimit = requestUrl.searchParams.get("limit");
          const limit = rawLimit === null ? 100 : Number(rawLimit);
          if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "beforeSequence must be a positive integer" }));
          }
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "limit must be between 1 and 200" }));
          }
          const page = yield* supervisor.timelinePage(sessionId, beforeSequence, limit);
          json(response, 200, page satisfies OwnedSessionTimelinePageResponse);
          return;
        }

        const outputMatch = /^\/api\/sessions\/([^/]+)\/outputs\/([^/]+)$/.exec(pathname);
        if (outputMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const values = yield* Effect.try({
            try: () => ({ sessionId: decodeURIComponent(outputMatch[1]!), ref: decodeURIComponent(outputMatch[2]!) }),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed output reference", cause }),
          });
          if (!values.ref || values.ref.length > 256) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "Output reference is invalid" }));
          }
          const output = yield* supervisor.toolOutput(values.sessionId, values.ref);
          json(response, 200, { ref: values.ref, ...output } satisfies OwnedSessionToolOutputResponse);
          return;
        }

        const artifactMatch = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
        if (artifactMatch && (request.method === "GET" || request.method === "HEAD")) {
          yield* requireBrowser(request, config, false);
          const values = yield* Effect.try({
            try: () => ({ sessionId: decodeURIComponent(artifactMatch[1]!), artifactId: decodeURIComponent(artifactMatch[2]!) }),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed artifact reference", cause }),
          });
          yield* supervisor.get(values.sessionId);
          const body = yield* Effect.tryPromise({
            try: () => loadOwnedSessionArtifact(config.stateDir, values.sessionId, values.artifactId),
            catch: () => new HttpRequestError({ status: 404, message: "Artifact not found" }),
          });
          response.writeHead(200, {
            ...securityHeaders(),
            "Cache-Control": "private, no-store",
            "Content-Disposition": `inline; filename="browser-evidence-${values.artifactId}.png"`,
            "Content-Length": String(body.length),
            "Content-Type": "image/png",
          });
          response.end(request.method === "HEAD" ? undefined : body);
          return;
        }

        const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(pathname);
        if (eventsMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(eventsMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const lastEventIdHeader = Array.isArray(request.headers["last-event-id"])
            ? request.headers["last-event-id"][0]
            : request.headers["last-event-id"];
          const rawAfterSequence = lastEventIdHeader ?? requestUrl.searchParams.get("afterSequence");
          const parsedAfterSequence = rawAfterSequence === null || rawAfterSequence === undefined ? 0 : Number(rawAfterSequence);
          if (!Number.isSafeInteger(parsedAfterSequence) || parsedAfterSequence < 0) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "afterSequence must be a non-negative integer" }));
          }
          let cursor = parsedAfterSequence;
          response.writeHead(200, {
            ...securityHeaders(),
            "Cache-Control": "no-store",
            "Content-Type": "text/event-stream; charset=utf-8",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          });
          response.flushHeaders();
          const unsubscribe = yield* supervisor.subscribe(sessionId, (session) => {
            const earliestSequence = session.events.at(0)?.sequence;
            const latestSequence = session.events.at(-1)?.sequence ?? 0;
            const reset = cursor > latestSequence || cursor > 0 && earliestSequence !== undefined && cursor < earliestSequence - 1;
            const events = reset ? session.events : session.events.filter((event) => event.sequence > cursor);
            cursor = latestSequence;
            response.write(`id: ${cursor}\nevent: session\ndata: ${JSON.stringify({ session: { ...session, events }, reset } satisfies OwnedSessionStreamResponse)}\n\n`);
          });
          const heartbeat = setInterval(() => response.write("event: heartbeat\ndata: {}\n\n"), 15_000);
          heartbeat.unref();
          yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
            clearInterval(heartbeat);
            unsubscribe();
            if (!response.writableEnded) response.end();
          })));
          return;
        }

        const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
        if (detailMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(detailMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const afterSequenceParameter = requestUrl.searchParams.get("afterSequence");
          const afterSequence = afterSequenceParameter === null ? undefined : Number(afterSequenceParameter);
          if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "afterSequence must be a non-negative integer" }));
          }
          const session = yield* supervisor.get(sessionId);
          json(response, 200, {
            session: afterSequence === undefined
              ? { ...session, events: session.events.slice(-150) }
              : { ...session, events: session.events.filter((event) => event.sequence > afterSequence) },
          } satisfies OwnedSessionDetailResponse);
          return;
        }

        if (detailMatch && request.method === "PATCH") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(detailMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeRenameSessionRequest(request);
          const session = yield* supervisor.rename({ sessionId, runtimeId: input.runtimeId }, input.name);
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        if (detailMatch && request.method === "DELETE") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(detailMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          }
          yield* supervisor.remove({ sessionId, runtimeId });
          json(response, 200, { deleted: true });
          return;
        }

        const mentionsMatch = /^\/api\/sessions\/([^/]+)\/mentions$/.exec(pathname);
        if (mentionsMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(mentionsMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          }
          const query = requestUrl.searchParams.get("query") ?? "";
          if (query.length > 200) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "File mention query is too long" }));
          }
          const mentions = yield* supervisor.searchMentions({ sessionId, runtimeId }, query);
          json(response, 200, { mentions } satisfies FileMentionSearchResponse);
          return;
        }

        const reviewMatch = /^\/api\/sessions\/([^/]+)\/review$/.exec(pathname);
        if (reviewMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(reviewMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          }
          const reviewTarget = yield* supervisor.reviewWorkspace({ sessionId, runtimeId });
          const workspace = yield* repository.findById(reviewTarget.workspaceId);
          if (!workspace) return yield* Effect.fail(new HttpRequestError({ status: 404, message: "The session workspace no longer exists" }));
          const review = yield* reviews.collect(workspace.root, reviewTarget);
          json(response, 200, { review } satisfies ReviewSnapshotResponse);
          return;
        }

        const modelsMatch = /^\/api\/sessions\/([^/]+)\/models$/.exec(pathname);
        if (modelsMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(modelsMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          }
          const models = yield* supervisor.listModels({ sessionId, runtimeId });
          json(response, 200, { models } satisfies AvailableModelListResponse);
          return;
        }

        const statsMatch = /^\/api\/sessions\/([^/]+)\/stats$/.exec(pathname);
        if (statsMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(statsMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          const session = yield* supervisor.refreshUsage({ sessionId, runtimeId });
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const configurationMatch = /^\/api\/sessions\/([^/]+)\/configuration$/.exec(pathname);
        if (configurationMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(configurationMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeConfigurationRequest(request);
          const target = { sessionId, runtimeId: input.runtimeId };
          const session = input.action === "setModel"
            ? input.provider?.trim() && input.modelId?.trim()
              ? yield* supervisor.setModel(target, input.provider.trim(), input.modelId.trim())
              : yield* Effect.fail(new HttpRequestError({ status: 400, message: "Model provider and ID are required" }))
            : input.action === "setThinkingLevel"
              ? input.level
                ? yield* supervisor.setThinkingLevel(target, input.level)
                : yield* Effect.fail(new HttpRequestError({ status: 400, message: "Thinking level is required" }))
              : input.action === "compact"
                ? yield* supervisor.compact(target)
                : typeof input.enabled === "boolean"
                  ? yield* supervisor.setAutoCompaction(target, input.enabled)
                  : yield* Effect.fail(new HttpRequestError({ status: 400, message: "Automatic compaction setting is required" }));
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const workflowMatch = /^\/api\/sessions\/([^/]+)\/workflow$/.exec(pathname);
        if (workflowMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(workflowMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeWorkflowMutation(request);
          const session = yield* supervisor.mutateWorkflow({ sessionId, runtimeId: input.runtimeId }, input);
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const interactiveMatch = /^\/api\/sessions\/([^/]+)\/interactive$/.exec(pathname);
        if (interactiveMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(interactiveMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeInteractiveResponse(request);
          const session = yield* supervisor.respondInteractive(
            { sessionId, runtimeId: input.runtimeId },
            { requestId: input.requestId, cancelled: input.cancelled, value: input.value, confirmed: input.confirmed },
          );
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const acknowledgeMatch = /^\/api\/sessions\/([^/]+)\/acknowledge$/.exec(pathname);
        if (acknowledgeMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(acknowledgeMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeResumeRequest(request);
          const session = yield* supervisor.acknowledge({ sessionId, runtimeId: input.runtimeId });
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(pathname);
        if (resumeMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(resumeMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeResumeRequest(request);
          const session = yield* supervisor.resume({ sessionId, runtimeId: input.runtimeId });
          json(response, 200, { session } satisfies OwnedSessionDetailResponse);
          return;
        }

        const commandMatch = /^\/api\/sessions\/([^/]+)\/commands$/.exec(pathname);
        if (commandMatch && request.method === "GET") {
          yield* requireBrowser(request, config, false);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(commandMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const runtimeId = requestUrl.searchParams.get("runtimeId")?.trim();
          if (!runtimeId || runtimeId.length > 128) {
            return yield* Effect.fail(new HttpRequestError({ status: 400, message: "A valid runtime ID is required" }));
          }
          const commands = yield* supervisor.listCommands({ sessionId, runtimeId });
          json(response, 200, { commands } satisfies PiSlashCommandListResponse);
          return;
        }

        if (commandMatch && request.method === "POST") {
          yield* requireBrowser(request, config, true);
          const sessionId = yield* Effect.try({
            try: () => decodeURIComponent(commandMatch[1]!),
            catch: (cause) => new HttpRequestError({ status: 400, message: "Malformed session ID", cause }),
          });
          const input = yield* decodeCommandRequest(request);
          const target = { sessionId, runtimeId: input.runtimeId };
          if (input.action === "prompt" || input.action === "steer" || input.action === "followUp") {
            const text = input.text?.trim() ?? "";
            const images = input.images ?? [];
            if (!text && images.length === 0) return yield* Effect.fail(new HttpRequestError({ status: 400, message: `${input.action} requires text or an image` }));
            if (input.action === "prompt") yield* supervisor.prompt(target, text, images, input.commandId);
            else if (input.action === "steer") yield* supervisor.steer(target, text, images, input.commandId);
            else yield* supervisor.followUp(target, text, images, input.commandId);
          } else if (input.action === "abort") {
            yield* supervisor.abort(target);
          } else {
            yield* supervisor.stop(target);
          }
          json(response, 202, { accepted: true });
          return;
        }

        if (pathname === "/api/notifications" || pathname === "/api/workspaces" || workspaceMatch || pathname === "/api/directories" || pathname === "/api/sessions" || pathname === "/api/sessions/import" || artifactMatch || eventsMatch || detailMatch || mentionsMatch || reviewMatch || modelsMatch || statsMatch || configurationMatch || workflowMatch || interactiveMatch || acknowledgeMatch || resumeMatch || commandMatch) {
          json(response, 405, { error: "Method not allowed" });
          return;
        }
        if (pathname.startsWith("/api/")) {
          json(response, 404, { error: "API route not found" });
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          json(response, 405, { error: "Method not allowed" });
          return;
        }
        yield* serveStatic(request, response, config.publicDir);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!response.headersSent) json(response, requestErrorStatus(error), { error: requestErrorMessage(error) });
            else response.destroy();
            if (requestErrorStatus(error) >= 500) console.error("PISS request failed", error);
          }),
        ),
        Effect.catchCause((cause) => requestAbort.signal.aborted
          ? Effect.void
          : Effect.sync(() => {
            if (!response.headersSent) json(response, 500, { error: "Internal server error" });
            else response.destroy();
            console.error("PISS request defect", cause);
          }),
        ),
      );

      const abortDisconnectedRequest = () => {
        if (!response.writableFinished) requestAbort.abort(new Error("Browser disconnected"));
      };
      request.once("aborted", abortDisconnectedRequest);
      response.once("close", abortDisconnectedRequest);
      void Effect.runPromise(route, { signal: requestAbort.signal }).catch((cause) => {
        if (!requestAbort.signal.aborted) {
          if (!response.headersSent) json(response, 500, { error: "Internal server error" });
          else response.destroy();
          console.error("PISS request fiber failed", cause);
        }
      }).finally(() => {
        request.off("aborted", abortDisconnectedRequest);
        response.off("close", abortDisconnectedRequest);
      });
    };
  });
}

function listen(server: Server, host: string, port: number): Effect.Effect<void, HttpServerError> {
  return Effect.callback<void, HttpServerError>((resume) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      resume(Effect.fail(new HttpServerError({ message: `Could not listen on ${host}:${port}`, cause })));
    };
    const onListening = () => {
      server.off("error", onError);
      resume(Effect.void);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });
}

export const runHttpServer = Effect.gen(function* () {
  const config = yield* AppConfig;
  const handler = yield* makeRequestHandler();
  const server = createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;

  yield* Effect.acquireRelease(
    listen(server, config.host, config.port).pipe(Effect.as(server)),
    close,
  );
  yield* Console.log(`PISS listening on http://${config.host}:${config.port}`);
  return yield* Effect.never;
});
