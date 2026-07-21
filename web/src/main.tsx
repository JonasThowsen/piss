import React, { type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error?: Error };

declare global {
  interface Window {
    __PISS_MARK_BOOTED__?: () => void;
  }
}

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

if (import.meta.env.PROD && "serviceWorker" in navigator) {
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
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
window.__PISS_MARK_BOOTED__?.();
