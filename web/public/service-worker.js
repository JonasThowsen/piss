const CACHE_VERSION = "piss-shell-v4";
const CACHE_PREFIX = "piss-shell-";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(APP_SHELL.map(async (path) => {
        try {
          const response = await fetch(path, { cache: "reload" });
          if (response.ok) await cache.put(path, response);
        } catch {
          // A partial shell is preferable to blocking an update indefinitely.
        }
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const migratingLegacyClient = keys.includes("piss-shell-v1");
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION).map((key) => caches.delete(key)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();

    // The previous client cannot know that its app bundle is obsolete. Move any
    // open PWA window onto the newly activated shell immediately.
    if (migratingLegacyClient) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => undefined)));
    }
  })());
});

async function cacheResponse(request, response, key = request) {
  if (response.ok) {
    await caches.open(CACHE_VERSION)
      .then((cache) => cache.put(key, response.clone()))
      .catch(() => undefined);
  }
  return response;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { /* show a generic alert */ }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.focused)) return;
    await self.registration.showNotification(payload.title ?? "Pi agent finished", {
      body: payload.body ?? "A Pi session has settled.",
      tag: payload.tag ?? "piss-agent-settled",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url ?? "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(target).catch(() => undefined);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cachedPromise = caches.match("/");
      const network = (async () => {
        try {
          const preloaded = await event.preloadResponse;
          return cacheResponse(request, preloaded ?? await fetch(request, { cache: "no-store" }), "/");
        } catch {
          const fallback = await cachedPromise;
          if (fallback) return fallback;
          return new Response("PISS is offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
      })();
      event.waitUntil(network.then(() => undefined).catch(() => undefined));
      const cached = await cachedPromise;

      if (!cached) return network;
      return Promise.race([
        network,
        new Promise((resolve) => setTimeout(() => resolve(cached), 2000)),
      ]);
    })());
    return;
  }

  const isVersionedAsset = url.pathname.startsWith("/assets/");
  if (isVersionedAsset) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((response) => cacheResponse(request, response))),
    );
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      return cacheResponse(request, await fetch(request, { cache: "no-cache" }));
    } catch {
      return cached ?? Response.error();
    }
  })());
});
