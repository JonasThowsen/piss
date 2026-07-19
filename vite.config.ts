import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function portFromEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

export default defineConfig(() => {
  const backendPort = portFromEnvironment("PISS_PORT", 4317);
  const webPort = portFromEnvironment("PISS_DEV_WEB_PORT", 5173);
  const tailnetHost = process.env.PISS_DEV_HOST?.replace(/\.$/, "");

  return {
    plugins: [react()],
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
