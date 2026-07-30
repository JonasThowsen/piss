import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { consumeUpdateActivation } from "./updateActivation.ts";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

const syncVisibleViewport = () => {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
};
syncVisibleViewport();
window.requestAnimationFrame(syncVisibleViewport);
window.setTimeout(syncVisibleViewport, 250);
window.addEventListener("resize", syncVisibleViewport);
window.addEventListener("pageshow", syncVisibleViewport);
window.visualViewport?.addEventListener("resize", syncVisibleViewport);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncVisibleViewport();
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // A worker activated from another tab must not interrupt a session being
    // read here. Only the tab whose user chose Apply update reloads itself.
    if (consumeUpdateActivation()) window.location.reload();
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).then((registration) => {
      const announceWaiting = () => {
        if (registration.waiting) window.dispatchEvent(new CustomEvent("piss-update-ready", { detail: registration }));
      };
      announceWaiting();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => { if (worker.state === "installed" && navigator.serviceWorker.controller) announceWaiting(); });
      });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void registration.update(); });
    }).catch(() => undefined);
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
