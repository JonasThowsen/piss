import React, { type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error?: Error };

class AppErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("PISS UI crashed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-state" role="alert">
      <span>π</span>
      <h1>The interface hit an error</h1>
      <p>Your Pi session is still running. Reload the client to reconnect safely.</p>
      {import.meta.env.DEV && <pre>{this.state.error.message}</pre>}
      <button onClick={() => location.reload()}>RELOAD PISS</button>
    </main>;
  }
}

if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void (async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const wasControlled = navigator.serviceWorker.controller !== null || registrations.length > 0;
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("piss-shell-")).map((key) => caches.delete(key)));
    }

    const reloadKey = "piss:dev-without-service-worker";
    if (wasControlled && sessionStorage.getItem(reloadKey) !== "1") {
      sessionStorage.setItem(reloadKey, "1");
      location.reload();
    } else {
      sessionStorage.removeItem(reloadKey);
    }
  })().catch(() => undefined);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void (async () => {
      let reloadOnControllerChange = navigator.serviceWorker.controller !== null;
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadOnControllerChange && !reloading) {
          reloading = true;
          location.reload();
        }
        reloadOnControllerChange = true;
      });
      const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" });
      const checkForUpdate = () => { if (document.visibilityState === "visible") void registration.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", checkForUpdate);
      window.addEventListener("online", checkForUpdate);
      checkForUpdate();
      window.setInterval(checkForUpdate, 60 * 60_000);
    })().catch(() => undefined);
  });
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
