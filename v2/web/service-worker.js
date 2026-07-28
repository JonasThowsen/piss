const CACHE_NAME = __PISS_CACHE_NAME__;
const CACHE_PREFIX = "piss-v2-shell-";
const BUILD_ASSETS = __PISS_ASSETS__;
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", ...BUILD_ASSETS];
const NOTIFICATION_ICON = "/icon-192.png";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await Promise.all(SHELL_ASSETS.map(async (path) => {
        const response = await fetch(path, { cache: "reload" });
        if (!response.ok) throw new Error(`Could not cache ${path}`);
        await cache.put(path, response);
      }));
    } catch (cause) {
      await caches.delete(CACHE_NAME);
      throw cause;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => (key.startsWith(CACHE_PREFIX) || key.startsWith("piss-shell-")) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { /* use privacy-safe defaults */ }
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const alreadyVisible = windows.some((client) => {
      if (!client.focused || !sessionId) return false;
      try { return new URL(client.url).searchParams.get("session") === sessionId; } catch { return false; }
    });
    if (alreadyVisible) return;
    await self.registration.showNotification(typeof payload.title === "string" ? payload.title : "Pi session needs attention", {
      body: typeof payload.body === "string" ? payload.body : "Open PISS to review the session.",
      tag: typeof payload.tag === "string" ? payload.tag : `piss-v2-${sessionId || "attention"}`,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { url: typeof payload.url === "string" ? payload.url : "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requested = new URL(event.notification.data?.url ?? "/", self.location.origin);
    const target = requested.origin === self.location.origin ? requested.href : new URL("/", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(target).catch(() => undefined);
      await existing.focus();
    } else await self.clients.openWindow(target);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const shellKey = request.mode === "navigate" ? "/" : SHELL_ASSETS.includes(url.pathname) ? url.pathname : undefined;
  if (!shellKey) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(shellKey);
    if (cached) return cached;
    try { return await fetch(request, { cache: "no-store" }); }
    catch { return new Response("PISS V2 is offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }); }
  })());
});
