import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function portFromEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

const devServerId = `${Date.now().toString(36)}-${process.pid}`;
const devBootRecovery: Plugin = {
  name: "piss-dev-boot-recovery",
  apply: "serve",
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      {
        tag: "style",
        injectTo: "head-prepend",
        children: "#root>.boot-state{height:100vh;display:grid;place-content:center;justify-items:center;gap:8px;color:#6b6b73}#root>.boot-state strong{color:#c2410c;font:700 12px sans-serif;letter-spacing:.16em}#root>.boot-state p{margin:0;font:12px sans-serif}",
      },
      {
        tag: "script",
        injectTo: "head-prepend",
        children: `(() => {
          const serverId = ${JSON.stringify(devServerId)};
          const attemptsKey = "piss:dev-boot-attempts:" + serverId;
          let timer;
          window.__PISS_MARK_BOOTED__ = () => {
            clearTimeout(timer);
            sessionStorage.removeItem(attemptsKey);
          };
          const clearWorker = async () => {
            if ("serviceWorker" in navigator) {
              const registrations = await navigator.serviceWorker.getRegistrations();
              await Promise.all(registrations.map((registration) => registration.unregister()));
            }
            if ("caches" in window) {
              const keys = await caches.keys();
              await Promise.all(keys.filter((key) => key.startsWith("piss-shell-")).map((key) => caches.delete(key)));
            }
          };
          const recover = async () => {
            await clearWorker().catch(() => undefined);
            const attempts = Number(sessionStorage.getItem(attemptsKey) || "0");
            const status = document.querySelector(".boot-state p");
            if (attempts >= 3) {
              if (status) status.textContent = "Development client failed to start. Restart the dev server, then reload.";
              return;
            }
            try {
              const paths = ["/src/main.tsx", "/src/App.tsx", "/src/styles.css"];
              const responses = await Promise.all(paths.map((path) => fetch(path + "?boot=" + Date.now(), { cache: "no-store" })));
              if (!responses.every((response) => response.ok)) throw new Error("development modules unavailable");
              sessionStorage.setItem(attemptsKey, String(attempts + 1));
              location.reload();
            } catch {
              if (status) status.textContent = "Reconnecting to the development server…";
              timer = setTimeout(recover, 2500);
            }
          };
          void clearWorker().catch(() => undefined);
          timer = setTimeout(recover, 4000);
        })();`,
      },
    ],
  },
};

export default defineConfig(() => {
  const backendPort = portFromEnvironment("PISS_PORT", 4317);
  const webPort = portFromEnvironment("PISS_DEV_WEB_PORT", 5173);
  const tailnetHost = process.env.PISS_DEV_HOST?.replace(/\.$/, "");

  return {
    plugins: [devBootRecovery, react()],
    root: "web",
    build: {
      outDir: "../dist/public",
      emptyOutDir: true,
    },
    server: {
      port: webPort,
      strictPort: true,
      allowedHosts: tailnetHost ? [tailnetHost] : [],
      hmr: tailnetHost ? { protocol: "wss", host: tailnetHost, clientPort: 443 } : undefined,
      proxy: {
        "/api": { target: `http://127.0.0.1:${backendPort}`, ws: true },
      },
    },
  };
});
