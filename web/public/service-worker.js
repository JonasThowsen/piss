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
