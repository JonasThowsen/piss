import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import webpush from "web-push";
import { AppConfig, type AppConfigShape } from "../server/config.ts";
import { notificationPayload, PushNotifications, PushNotificationsLive } from "../server/notifications/PushNotifications.ts";
import { WorkspaceId, type OwnedSession } from "../shared/domain.ts";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("notification-test-deadbeef");

function session(): OwnedSession {
  return {
    id: "session-safe-id",
    runtimeId: "runtime-safe-id",
    workspaceId,
    name: "private project name",
    branch: "private-branch",
    status: "finished",
    pid: 42,
    piSessionId: "pi-session",
    sessionFile: "/home/private/.pi/agent/sessions/secret.jsonl",
    model: null,
    thinkingLevel: null,
    usage: null,
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    compaction: { status: "idle", reason: null, tokensBefore: null, estimatedTokensAfter: null, error: null, updatedAt: null },
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    events: [{ sequence: 1, type: "message_end", timestamp: new Date().toISOString(), data: { message: { content: "super secret prompt" } } }],
    interactiveRequests: [],
    error: "private tool output",
  };
}

test("notification payloads route by opaque session ID without private content", () => {
  for (const status of ["finished", "blocked", "crashed"] as const) {
    const payload = notificationPayload(session(), status);
    const decoded = JSON.parse(payload) as { title: string; body: string; sessionId: string; url: string };
    assert.equal(decoded.sessionId, "session-safe-id");
    assert.equal(decoded.url, "/?session=session-safe-id");
    assert.match(decoded.title, /Pi session/);
    assert.doesNotMatch(payload, /private|secret|\/home|tool output|project name/);
  }
});

test("notification delivery deduplicates transitions and removes expired subscriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-notifications-"));
  const originalSend = webpush.sendNotification;
  let sends = 0;
  try {
    (webpush as unknown as { sendNotification: typeof webpush.sendNotification }).sendNotification = async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    };
    const config: AppConfigShape = {
      host: "127.0.0.1",
      port: 4318,
      stateDir: directory,
      publicDir: directory,
      piCommand: "pi",
      browserAuth: { devBypass: true, allowedUsers: new Set(), devAllowedOrigins: new Set() },
      workspaceSeeds: [],
      workspaceDiscoveryRoots: [],
    };
    const layer = PushNotificationsLive.pipe(Layer.provide(Layer.succeed(AppConfig, AppConfig.of(config))));
    await Effect.runPromise(Effect.gen(function* () {
      const notifications = yield* PushNotifications;
      yield* notifications.subscribe("owner@example.com", {
        endpoint: "https://push.example.test/live",
        expirationTime: null,
        keys: { p256dh: "public", auth: "auth" },
      });
      const finished = session();
      yield* notifications.notify(finished, "finished");
      yield* notifications.notify(finished, "finished");
      assert.equal(sends, 1);

      yield* notifications.subscribe("owner@example.com", {
        endpoint: "https://push.example.test/expired",
        expirationTime: null,
        keys: { p256dh: "expired-public", auth: "expired-auth" },
      });
      (webpush as unknown as { sendNotification: typeof webpush.sendNotification }).sendNotification = async (subscription) => {
        if (subscription.endpoint.endsWith("/expired")) throw { statusCode: 410 };
        return { statusCode: 201, body: "", headers: {} };
      };
      yield* notifications.notify({ ...finished, lastActivityAt: new Date(Date.now() + 1_000).toISOString() }, "blocked");
    }).pipe(Effect.provide(layer)));
    const stored = await readFile(join(directory, "push-subscriptions.json"), "utf8");
    assert.doesNotMatch(stored, /\/expired/);
    assert.match(stored, /\/live/);
  } finally {
    (webpush as unknown as { sendNotification: typeof webpush.sendNotification }).sendNotification = originalSend;
    await rm(directory, { recursive: true, force: true });
  }
});
