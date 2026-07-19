import type { IncomingMessage } from "node:http";

export interface BrowserAuthConfig {
  devBypass: boolean;
  allowedUsers: ReadonlySet<string>;
  devAllowedOrigins: ReadonlySet<string>;
}

export function defaultDevOrigins(webPort: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
    `http://[::1]:${webPort}`,
  ]);
}

export function browserUser(request: IncomingMessage, config: BrowserAuthConfig): string | undefined {
  if (config.devBypass) return "local-development";
  const value = request.headers["tailscale-user-login"];
  const login = Array.isArray(value) ? value[0] : value;
  if (!login || (config.allowedUsers.size > 0 && !config.allowedUsers.has(login))) return;
  return login;
}

export function validBrowserOrigin(request: IncomingMessage, config: BrowserAuthConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (config.devBypass) return config.devAllowedOrigins.has(origin);

  const expectedHost = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (!expectedHost || Array.isArray(expectedHost)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.host === expectedHost;
  } catch {
    return false;
  }
}
