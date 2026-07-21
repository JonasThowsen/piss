import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import type { BrowserPushSubscription, NotificationCapability, SessionInfo } from "../shared/protocol.ts";

type StoredSubscription = BrowserPushSubscription & {
  user: string;
  createdAt: number;
};

type VapidKeys = { publicKey: string; privateKey: string };

function validSubscription(value: unknown): value is StoredSubscription {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSubscription>;
  return typeof candidate.user === "string" && candidate.user.length > 0 &&
    typeof candidate.endpoint === "string" && candidate.endpoint.startsWith("https://") &&
    typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt) &&
    !!candidate.keys && typeof candidate.keys.p256dh === "string" && typeof candidate.keys.auth === "string";
}

async function loadOrCreateKeys(path: string): Promise<VapidKeys> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") return parsed as VapidKeys;
  } catch {
    // Generate a fresh pair below. Subscriptions live in the same state directory,
    // so losing these keys and losing the subscriptions have the same recovery path.
  }

  const keys = webpush.generateVAPIDKeys();
  await writeFile(path, `${JSON.stringify(keys)}\n`, { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const parsed = JSON.parse(await readFile(path, "utf8")) as VapidKeys;
    keys.publicKey = parsed.publicKey;
    keys.privateKey = parsed.privateKey;
  });
  await chmod(path, 0o600);
  return keys;
}

export class PushNotifications {
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly subscriptionsPath: string,
    readonly capability: NotificationCapability,
  ) {}

  static async create(stateDir: string): Promise<PushNotifications> {
    const keys = await loadOrCreateKeys(join(stateDir, "vapid-keys.json"));
    webpush.setVapidDetails(process.env.PISS_VAPID_SUBJECT ?? "mailto:piss@localhost.localdomain", keys.publicKey, keys.privateKey);
    const manager = new PushNotifications(join(stateDir, "push-subscriptions.json"), {
      supported: true,
      vapidPublicKey: keys.publicKey,
    });
    await manager.load();
    return manager;
  }

  private async load() {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.subscriptionsPath, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const subscription of parsed) {
        if (validSubscription(subscription)) this.subscriptions.set(subscription.endpoint, subscription);
      }
    } catch {
      // No subscriptions yet, or a damaged cache. A future browser opt-in rewrites it.
    }
  }

  private persist() {
    const snapshot = JSON.stringify([...this.subscriptions.values()]);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.subscriptionsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporary, this.subscriptionsPath);
      await chmod(this.subscriptionsPath, 0o600);
    }).catch((error) => console.error("Unable to persist push subscriptions:", error instanceof Error ? error.message : String(error)));
  }

  subscribe(user: string, subscription: BrowserPushSubscription) {
    this.subscriptions.set(subscription.endpoint, { ...subscription, user, createdAt: Date.now() });
    this.persist();
  }

  unsubscribe(user: string, endpoint: string) {
    const existing = this.subscriptions.get(endpoint);
    if (existing?.user !== user) return;
    this.subscriptions.delete(endpoint);
    this.persist();
  }

  async notifySettled(session: SessionInfo) {
    if (this.subscriptions.size === 0) return;
    const project = (session.name || session.cwd.split("/").filter(Boolean).at(-1) || "Pi session").slice(0, 100);
    const branch = session.branch?.slice(0, 100);
    const blocked = session.status === "blocked";
    const payload = JSON.stringify({
      title: blocked ? `${project} needs attention` : `${project} is finished`,
      body: blocked
        ? `The agent stopped before completing its task${branch ? ` on ${branch}` : ""}.`
        : `The agent completed its task${branch ? ` on ${branch}` : ""}.`,
      tag: `piss-session-${session.sessionId.slice(0, 128)}`,
      url: session.sessionId.length <= 256 ? `/?session=${encodeURIComponent(session.sessionId)}` : "/",
    });

    await Promise.all([...this.subscriptions.values()].map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 15 * 60, urgency: blocked ? "high" : "normal" });
      } catch (error) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : undefined;
        if (statusCode === 404 || statusCode === 410) {
          this.subscriptions.delete(subscription.endpoint);
          this.persist();
          return;
        }
        console.warn(`Push notification failed${statusCode ? ` (${statusCode})` : ""}`);
      }
    }));
  }
}
