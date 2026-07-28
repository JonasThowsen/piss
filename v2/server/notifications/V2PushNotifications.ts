import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import webpush from "web-push";
import type { OwnedSession, OwnedSessionStatus } from "../../shared/domain.ts";
import { AppConfig } from "../config.ts";

const MAX_SUBSCRIPTIONS = 500;
const MAX_SUBSCRIPTIONS_PER_USER = 25;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_DEDUPE_KEYS = 2_000;

type PushSubscriptionInput = {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};
type StoredSubscription = PushSubscriptionInput & { readonly user: string; readonly createdAt: number };
type VapidKeys = { readonly publicKey: string; readonly privateKey: string };

export interface V2PushNotificationsShape {
  readonly capability: { readonly supported: true; readonly vapidPublicKey: string };
  readonly subscribe: (user: string, subscription: PushSubscriptionInput) => Effect.Effect<void, Error>;
  readonly unsubscribe: (user: string, endpoint: string) => Effect.Effect<void>;
  readonly notify: (session: OwnedSession, status: Extract<OwnedSessionStatus, "finished" | "blocked" | "crashed">) => Effect.Effect<void>;
}

export class V2PushNotifications extends Context.Service<V2PushNotifications, V2PushNotificationsShape>()(
  "@piss/v2/V2PushNotifications",
) {}

function validSubscription(value: unknown): value is StoredSubscription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = item.keys as Record<string, unknown> | undefined;
  return typeof item.user === "string" && item.user.length > 0 && item.user.length <= 320
    && typeof item.endpoint === "string" && item.endpoint.startsWith("https://") && item.endpoint.length <= 4_096
    && (item.expirationTime === null || typeof item.expirationTime === "number" && Number.isFinite(item.expirationTime))
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    && typeof keys?.p256dh === "string" && keys.p256dh.length > 0 && keys.p256dh.length <= 4_096
    && typeof keys.auth === "string" && keys.auth.length > 0 && keys.auth.length <= 4_096;
}

async function loadOrCreateKeys(path: string): Promise<VapidKeys> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("VAPID key state is invalid");
      const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<VapidKeys>;
      if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") throw new Error("VAPID key state is malformed");
      return parsed as VapidKeys;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const generated = webpush.generateVAPIDKeys();
  await writeFile(path, `${JSON.stringify(generated)}\n`, { mode: 0o600, flag: "wx" }).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  await chmod(path, 0o600);
  return loadOrCreateKeys(path);
}

async function loadSubscriptions(path: string): Promise<StoredSubscription[]> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_STORAGE_BYTES) throw new Error("Push subscription state is invalid");
      const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Push subscription state is malformed");
      const state = parsed as { version?: unknown; subscriptions?: unknown };
      if (state.version !== 1 || !Array.isArray(state.subscriptions) || state.subscriptions.length > MAX_SUBSCRIPTIONS || !state.subscriptions.every(validSubscription)) {
        throw new Error("Push subscription state does not match version 1");
      }
      return state.subscriptions;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

export function notificationPayload(session: OwnedSession, status: Extract<OwnedSessionStatus, "finished" | "blocked" | "crashed">): string {
  return JSON.stringify({
    title: status === "blocked" ? "Pi session needs input" : status === "crashed" ? "Pi session crashed" : "Pi session finished",
    body: status === "blocked" ? "Open PISS to answer the pending request." : status === "crashed" ? "Open PISS to review the runtime failure." : "Open PISS to review the completed work.",
    tag: `piss-v2-${session.id.slice(0, 128)}-${status}`,
    sessionId: session.id.slice(0, 128),
    url: `/?session=${encodeURIComponent(session.id.slice(0, 128))}`,
  });
}

async function persistSubscriptions(path: string, subscriptions: ReadonlyArray<StoredSubscription>): Promise<void> {
  const encoded = `${JSON.stringify({ version: 1, subscriptions })}\n`;
  if (subscriptions.length > MAX_SUBSCRIPTIONS || Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw new Error("Push subscription state exceeds its limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export const V2PushNotificationsLive = Layer.effect(
  V2PushNotifications,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* Effect.promise(async () => { await mkdir(config.stateDir, { recursive: true, mode: 0o700 }); await chmod(config.stateDir, 0o700); });
    const keys = yield* Effect.promise(() => loadOrCreateKeys(join(config.stateDir, "vapid-keys-v2.json")));
    webpush.setVapidDetails(process.env.PISS_V2_VAPID_SUBJECT ?? "mailto:piss-v2@localhost.localdomain", keys.publicKey, keys.privateKey);
    const storagePath = join(config.stateDir, "push-subscriptions-v2.json");
    const loaded = yield* Effect.promise(() => loadSubscriptions(storagePath));
    const subscriptions = new Map(loaded.map((subscription) => [subscription.endpoint, subscription]));
    const delivered = new Set<string>();
    let writeTail = Promise.resolve();
    const persist = () => {
      const snapshot = [...subscriptions.values()];
      const next = writeTail.then(() => persistSubscriptions(storagePath, snapshot));
      writeTail = next.catch(() => undefined);
      return next;
    };

    return V2PushNotifications.of({
      capability: { supported: true, vapidPublicKey: keys.publicKey },
      subscribe: (user, subscription) => Effect.tryPromise({
        try: async () => {
          const existingForUser = [...subscriptions.values()].filter((candidate) => candidate.user === user && candidate.endpoint !== subscription.endpoint);
          if (!subscriptions.has(subscription.endpoint) && subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error("Push subscription capacity is full");
          if (existingForUser.length >= MAX_SUBSCRIPTIONS_PER_USER) throw new Error("This identity has too many notification devices");
          subscriptions.set(subscription.endpoint, { ...subscription, user, createdAt: Date.now() });
          await persist();
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("Could not persist push subscription", { cause }),
      }),
      unsubscribe: (user, endpoint) => Effect.promise(async () => {
        const existing = subscriptions.get(endpoint);
        if (existing?.user !== user) return;
        subscriptions.delete(endpoint);
        await persist().catch(() => undefined);
      }),
      notify: (session, status) => Effect.promise(async () => {
        const dedupeKey = `${session.runtimeId}:${status}:${session.lastActivityAt}`;
        if (delivered.has(dedupeKey)) return;
        delivered.add(dedupeKey);
        while (delivered.size > MAX_DEDUPE_KEYS) delivered.delete(delivered.values().next().value!);
        const payload = notificationPayload(session, status);
        let changed = false;
        await Promise.all([...subscriptions.values()].map(async (subscription) => {
          try {
            await webpush.sendNotification(subscription, payload, { TTL: 15 * 60, urgency: status === "blocked" || status === "crashed" ? "high" : "normal" });
          } catch (cause) {
            const statusCode = typeof cause === "object" && cause !== null && "statusCode" in cause ? Number((cause as { statusCode?: unknown }).statusCode) : undefined;
            if (statusCode === 404 || statusCode === 410) {
              subscriptions.delete(subscription.endpoint);
              changed = true;
            } else {
              console.warn("V2 push notification delivery failed", { statusCode });
            }
          }
        }));
        if (changed) await persist().catch(() => undefined);
      }),
    });
  }),
);
