import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function renderServiceWorker(cacheName: string, assets: ReadonlyArray<string>): string {
  const template = readFileSync(fileURLToPath(new URL("./web/service-worker.js", import.meta.url)), "utf8");
  return template
    .replace("__PISS_CACHE_NAME__", JSON.stringify(cacheName))
    .replace("__PISS_ASSETS__", JSON.stringify(assets));
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: "piss-v2-service-worker",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/service-worker.js") return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(renderServiceWorker("piss-v2-shell-development", []));
      });
    },
    generateBundle(_options, bundle) {
      const executableAssets = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => fileName.endsWith(".js") || fileName.endsWith(".css"))
        .sort();
      if (!executableAssets.some((fileName) => fileName.endsWith(".js"))) throw new Error("V2 service worker requires a JavaScript entry asset");
      const version = createHash("sha256").update(executableAssets.join("\n")).digest("hex").slice(0, 16);
      const source = renderServiceWorker(`piss-v2-shell-${version}`, executableAssets.map((fileName) => `/${fileName}`));
      this.emitFile({ type: "asset", fileName: "service-worker.js", source });
    },
  };
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid port`);
  return value;
}

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  root: fileURLToPath(new URL("./web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("../dist-v2/public", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: port("PISS_V2_DEV_WEB_PORT", 5174),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${port("PISS_V2_PORT", 4318)}`,
      },
    },
  },
});
