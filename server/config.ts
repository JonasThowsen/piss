import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { defaultDevOrigins, type BrowserAuthConfig } from "./browser-auth.ts";
import { WorkspaceSeed } from "../shared/domain.ts";
import { ConfigurationError } from "./errors.ts";

export interface AppConfigShape {
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  readonly publicDir: string;
  readonly piCommand: string;
  readonly piSessionRoots?: ReadonlyArray<string>;
  readonly workflowResourceDir?: string;
  readonly browserExecutablePath?: string;
  readonly browserFfprobePath?: string;
  readonly browserAuth: BrowserAuthConfig;
  readonly workspaceSeeds: ReadonlyArray<WorkspaceSeed>;
  readonly workspaceDiscoveryRoots: ReadonlyArray<string>;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("@piss/AppConfig") {}

const decodeWorkspaceSeeds = Schema.decodeUnknownSync(Schema.Array(WorkspaceSeed));
const decodeWorkspaceDiscoveryRoots = Schema.decodeUnknownSync(Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024), Schema.isPattern(/^\//)),
).check(Schema.isMaxLength(16)));

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PISS_PORT must be a valid TCP port");
  }
  return port;
}

function loadFromEnvironment(): AppConfigShape {
  const host = process.env.PISS_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("PISS only permits a loopback bind; use its private Tailscale node for remote access");
  }

  const port = parsePort(process.env.PISS_PORT ?? "4317");
  const devWebPort = parsePort(process.env.PISS_DEV_WEB_PORT ?? "5173");
  const devBypass = process.env.PISS_DEV_BYPASS_AUTH === "1";
  if (devBypass && process.env.NODE_ENV === "production") {
    throw new Error("PISS development auth bypass is forbidden with NODE_ENV=production");
  }

  const allowedUsers = new Set(
    (process.env.PISS_ALLOWED_USERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const configuredOrigins = new Set(
    (process.env.PISS_DEV_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const rawWorkspaces = process.env.PISS_WORKSPACES ?? "[]";
  const workspaceSeeds = decodeWorkspaceSeeds(JSON.parse(rawWorkspaces));
  const workspaceDiscoveryRoots = decodeWorkspaceDiscoveryRoots(
    JSON.parse(process.env.PISS_WORKSPACE_DISCOVERY_ROOTS ?? "[]"),
  );

  return {
    host,
    port,
    stateDir:
      process.env.PISS_STATE_DIR ??
      join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "piss"),
    publicDir: process.env.PISS_PUBLIC_DIR ?? fileURLToPath(new URL("./public", import.meta.url)),
    piCommand: process.env.PISS_PI_COMMAND ?? "pi",
    piSessionRoots: process.env.PISS_PI_SESSION_ROOTS
      ? decodeWorkspaceDiscoveryRoots(JSON.parse(process.env.PISS_PI_SESSION_ROOTS))
      : [join(homedir(), ".pi", "agent", "sessions")],
    workflowResourceDir: process.env.PISS_WORKFLOW_RESOURCE_DIR
      ?? fileURLToPath(new URL("../workflow-resources", import.meta.url)),
    browserExecutablePath: process.env.PISS_BROWSER_EXECUTABLE_PATH
      ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    browserFfprobePath: process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe",
    browserAuth: {
      devBypass,
      allowedUsers,
      devAllowedOrigins: configuredOrigins.size > 0 ? configuredOrigins : defaultDevOrigins(devWebPort),
    },
    workspaceSeeds,
    workspaceDiscoveryRoots,
  };
}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.try({
    try: loadFromEnvironment,
    catch: (cause) =>
      new ConfigurationError({
        message: cause instanceof Error ? cause.message : "Invalid PISS configuration",
      }),
  }),
);
