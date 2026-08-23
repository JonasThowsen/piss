/* Piss uses the network as the source of truth for every frontend asset.
   This worker exists for installed-app lifecycle and to retire caches left by
   the former frontend at the stable Piss origin. */
const LEGACY_CACHE_PREFIX = "piss-shell-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const legacyKeys = keys.filter((key) => key.startsWith(LEGACY_CACHE_PREFIX));
    await Promise.all(legacyKeys.map((key) => caches.delete(key)));
    await self.clients.claim();

    // The retired worker served its cached shell before it could discover this
    // replacement. Reload those controlled windows once after cache removal so
    // the stable Piss address cuts over without a hard refresh or cache purge.
    if (legacyKeys.length > 0) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin) {
            // Issue navigation while activation is alive, but do not await it:
            // Chromium resolves navigate() only after activation completes.
            void client.navigate(client.url).catch(() => undefined);
          }
        } catch {
          // A closing client must not block the one-time migration reload.
        }
      }
    }
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "piss:show-notification") return;

  const title = typeof message.title === "string" ? message.title : "Piss";
  const body = typeof message.body === "string" ? message.body : "";
  const tag = typeof message.tag === "string" ? message.tag : "piss-session";
  const data = message.data && typeof message.data === "object" ? message.data : {};
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requested = event.notification.data?.url;
    const target = new URL(typeof requested === "string" ? requested : "/", self.location.origin);
    if (target.origin !== self.location.origin) return;

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin) continue;
        const navigated = await client.navigate(target.href);
        await (navigated ?? client).focus();
        return;
      } catch {
        // Try another window or open a fresh installed-app window below.
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
