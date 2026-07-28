import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing V2 application root");

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloadOnControllerChange = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadOnControllerChange) window.location.reload();
    reloadOnControllerChange = true;
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).then((registration) => {
      const announceWaiting = () => {
        if (registration.waiting) window.dispatchEvent(new CustomEvent("piss-v2-update-ready", { detail: registration }));
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
