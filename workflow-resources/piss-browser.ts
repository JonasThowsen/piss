import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PissBrowserManager } from "./browser/manager.ts";

export default function (pi: ExtensionAPI) {
  const manager = new PissBrowserManager(
    process.env.PISS_BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "",
    process.env.PISS_BROWSER_ARTIFACT_STAGING_DIR ?? "",
  );

  pi.registerTool({
    name: "piss_browser_navigate",
    label: "PISS browser navigate",
    description: "Open a local development UI in PISS's isolated browser. Top-level navigation is limited to loopback HTTP(S).",
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4 * 1024 }) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.navigate(params.url));
      return { content: [{ type: "text", text: `Opened ${result.url}\nTitle: ${result.title || "(untitled)"}` }], details: result };
    },
  });

  pi.registerTool({
    name: "piss_browser_snapshot",
    label: "PISS browser snapshot",
    description: "Inspect the current local UI as a bounded accessibility snapshot before interacting or taking visual evidence.",
    parameters: Type.Object({}),
    async execute() {
      const result = await manager.run(() => manager.snapshot());
      return { content: [{ type: "text", text: `${result.url}\n${result.snapshot}` }], details: { url: result.url, title: result.title } };
    },
  });

  pi.registerTool({
    name: "piss_browser_click",
    label: "PISS browser click",
    description: "Click a local UI element by accessible role and name.",
    parameters: Type.Object({ role: Type.String({ minLength: 1, maxLength: 64 }), name: Type.String({ minLength: 1, maxLength: 1024 }), exact: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      await manager.run(() => manager.click(params.role, params.name, params.exact ?? true));
      return { content: [{ type: "text", text: `Clicked ${params.role} “${params.name}”` }], details: {} };
    },
  });

  pi.registerTool({
    name: "piss_browser_fill",
    label: "PISS browser fill",
    description: "Fill a local UI field by its accessible label.",
    parameters: Type.Object({ label: Type.String({ minLength: 1, maxLength: 1024 }), value: Type.String({ maxLength: 64 * 1024 }), exact: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      await manager.run(() => manager.fill(params.label, params.value, params.exact ?? true));
      return { content: [{ type: "text", text: `Filled “${params.label}”` }], details: {} };
    },
  });

  pi.registerTool({
    name: "piss_browser_screenshot",
    label: "PISS browser screenshot",
    description: "Capture deliberate visual evidence of the current local UI. The PNG is shown to the model and automatically published in PISS chat.",
    parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean()), label: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.screenshot(params.fullPage ?? false, params.label));
      return {
        content: [
          { type: "text", text: `Captured ${result.candidate.artifact.width}×${result.candidate.artifact.height} browser evidence.` },
          { type: "image", data: result.bytes.toString("base64"), mimeType: "image/png" },
        ],
        details: { pissBrowserArtifact: result.candidate },
      };
    },
  });

  pi.registerTool({
    name: "piss_browser_close",
    label: "PISS browser close",
    description: "Close and reset this session's managed browser.",
    parameters: Type.Object({}),
    async execute() {
      await manager.run(() => manager.close());
      return { content: [{ type: "text", text: "Closed the PISS browser." }], details: {} };
    },
  });

  pi.on("session_shutdown", async () => { await manager.shutdown(); });
}
