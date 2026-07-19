import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { browserUser, defaultDevOrigins, validBrowserOrigin, type BrowserAuthConfig } from "../server/browser-auth.ts";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

const development: BrowserAuthConfig = {
  devBypass: true,
  allowedUsers: new Set(),
  devAllowedOrigins: defaultDevOrigins(5173),
};

test("development bypass remains restricted to the Vite origin", () => {
  assert.equal(browserUser(request({}), development), "local-development");
  assert.equal(validBrowserOrigin(request({ origin: "http://127.0.0.1:5173" }), development), true);
  assert.equal(validBrowserOrigin(request({ origin: "http://localhost:5173" }), development), true);
  assert.equal(validBrowserOrigin(request({ origin: "https://attacker.example" }), development), false);
  assert.equal(validBrowserOrigin(request({}), development), false);
});

test("production browser authentication requires matching identity and HTTPS origin", () => {
  const production: BrowserAuthConfig = {
    devBypass: false,
    allowedUsers: new Set(["allowed@example.com"]),
    devAllowedOrigins: new Set(),
  };
  const allowed = request({
    origin: "https://piss.example.ts.net",
    host: "127.0.0.1:4317",
    "x-forwarded-host": "piss.example.ts.net",
    "tailscale-user-login": "allowed@example.com",
  });
  assert.equal(browserUser(allowed, production), "allowed@example.com");
  assert.equal(validBrowserOrigin(allowed, production), true);
  assert.equal(browserUser(request({ "tailscale-user-login": "other@example.com" }), production), undefined);
  assert.equal(validBrowserOrigin(request({ origin: "http://piss.example.ts.net", "x-forwarded-host": "piss.example.ts.net" }), production), false);
});
