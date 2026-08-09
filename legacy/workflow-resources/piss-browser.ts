import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PissBrowserManager } from "./browser/manager.ts";

const Label = Type.String({ minLength: 1, maxLength: 1024 });
const Exact = Type.Optional(Type.Boolean());

export default function (pi: ExtensionAPI) {
  const manager = new PissBrowserManager(
    process.env.PISS_BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "",
    process.env.PISS_BROWSER_ARTIFACT_STAGING_DIR ?? "",
    process.env.PISS_BROWSER_FFPROBE_PATH ?? "ffprobe",
  );

  pi.registerTool({
    name: "piss_browser_navigate", label: "PISS browser navigate",
    description: "Open a local development UI in PISS's isolated browser. Top-level navigation is limited to loopback HTTP(S).",
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4 * 1024 }) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.navigate(params.url));
      return { content: [{ type: "text", text: `Opened ${result.url}\nTitle: ${result.title || "(untitled)"}` }], details: result };
    },
  });
  pi.registerTool({
    name: "piss_browser_snapshot", label: "PISS browser snapshot",
    description: "Inspect the current local UI as a bounded accessibility snapshot before interacting or taking visual evidence.",
    parameters: Type.Object({}),
    async execute() {
      const result = await manager.run(() => manager.snapshot());
      return { content: [{ type: "text", text: `${result.url}\n${result.snapshot}` }], details: { url: result.url, title: result.title } };
    },
  });
  pi.registerTool({
    name: "piss_browser_click", label: "PISS browser click",
    description: "Click a local UI element by accessible role and name.",
    parameters: Type.Object({ role: Type.String({ minLength: 1, maxLength: 64 }), name: Label, exact: Exact }),
    async execute(_id, params) {
      await manager.run(() => manager.click(params.role, params.name, params.exact ?? true));
      return { content: [{ type: "text", text: `Clicked ${params.role} “${params.name}”` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_fill", label: "PISS browser fill",
    description: "Fill a local UI field by its accessible label.",
    parameters: Type.Object({ label: Label, value: Type.String({ maxLength: 64 * 1024 }), exact: Exact }),
    async execute(_id, params) {
      await manager.run(() => manager.fill(params.label, params.value, params.exact ?? true));
      return { content: [{ type: "text", text: `Filled “${params.label}”` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_type", label: "PISS browser type",
    description: "Type bounded text into the currently focused local UI control.",
    parameters: Type.Object({ text: Type.String({ maxLength: 64 * 1024 }), delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })) }),
    async execute(_id, params) {
      await manager.run(() => manager.typeText(params.text, params.delayMs ?? 0));
      return { content: [{ type: "text", text: `Typed ${Buffer.byteLength(params.text)} bytes into the focused control.` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_press", label: "PISS browser press",
    description: "Send one bounded keyboard key or shortcut to the local UI.",
    parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 128 }) }),
    async execute(_id, params) {
      await manager.run(() => manager.press(params.key));
      return { content: [{ type: "text", text: `Pressed ${params.key}` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_select", label: "PISS browser select",
    description: "Select one or more options by accessible field label and visible option labels.",
    parameters: Type.Object({ label: Label, options: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 100 }), exact: Exact }),
    async execute(_id, params) {
      await manager.run(() => manager.select(params.label, params.options, params.exact ?? true));
      return { content: [{ type: "text", text: `Selected ${params.options.join(", ")} in “${params.label}”` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_check", label: "PISS browser check",
    description: "Explicitly check or uncheck a checkbox/radio by accessible label.",
    parameters: Type.Object({ label: Label, checked: Type.Boolean(), exact: Exact }),
    async execute(_id, params) {
      await manager.run(() => manager.check(params.label, params.checked, params.exact ?? true));
      return { content: [{ type: "text", text: `${params.checked ? "Checked" : "Unchecked"} “${params.label}”` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_wait", label: "PISS browser wait",
    description: "Wait for an explicit bounded duration in the current local UI.",
    parameters: Type.Object({ milliseconds: Type.Integer({ minimum: 1, maximum: 10_000 }) }),
    async execute(_id, params) {
      await manager.run(() => manager.wait(params.milliseconds));
      return { content: [{ type: "text", text: `Waited ${params.milliseconds} ms.` }], details: {} };
    },
  });
  pi.registerTool({
    name: "piss_browser_resize", label: "PISS browser resize",
    description: "Resize the isolated browser viewport within production bounds.",
    parameters: Type.Object({ width: Type.Integer({ minimum: 320, maximum: 2560 }), height: Type.Integer({ minimum: 240, maximum: 1440 }) }),
    async execute(_id, params) {
      await manager.run(() => manager.resize(params.width, params.height));
      return { content: [{ type: "text", text: `Resized viewport to ${params.width}×${params.height}.` }], details: { width: params.width, height: params.height } };
    },
  });
  pi.registerTool({
    name: "piss_browser_info", label: "PISS browser info",
    description: "Inspect the current validated loopback URL and bounded page title.",
    parameters: Type.Object({}),
    async execute() {
      const result = await manager.run(() => manager.info());
      return { content: [{ type: "text", text: `${result.url}\nTitle: ${result.title || "(untitled)"}` }], details: result };
    },
  });
  pi.registerTool({
    name: "piss_browser_console_errors", label: "PISS browser console errors",
    description: "Inspect a bounded ring of console errors and uncaught page errors from the current local UI.",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), clear: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.inspectConsoleErrors(params.limit ?? 20, params.clear ?? false));
      const text = result.errors.length === 0 ? "No browser console errors." : result.errors.map((entry) => `${entry.timestamp} [${entry.source}] ${entry.message}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: result.errors.length, errors: result.errors } };
    },
  });
  pi.registerTool({
    name: "piss_browser_screenshot", label: "PISS browser screenshot",
    description: "Capture deliberate visual evidence of the current local UI. The PNG is shown to the model and automatically published in PISS chat.",
    parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean()), label: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.screenshot(params.fullPage ?? false, params.label));
      return {
        content: [{ type: "text", text: `Captured ${result.candidate.artifact.width}×${result.candidate.artifact.height} browser evidence.` }, { type: "image", data: result.bytes.toString("base64"), mimeType: "image/png" }],
        details: { pissBrowserArtifact: result.candidate },
      };
    },
  });
  pi.registerTool({
    name: "piss_browser_video_start", label: "PISS browser video start",
    description: "Start a private bounded WebM recording of the current local UI. Only one recording may be active.",
    parameters: Type.Object({ label: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }),
    async execute(_id, params) {
      const result = await manager.run(() => manager.startVideo(params.label));
      return {
        content: [{ type: "text", text: `Started browser recording ${result.id}; limited to ${result.maxDurationMs / 1000}s and ${result.maxBytes / 1024 / 1024} MiB.` }],
        details: { pissBrowserRecording: { version: 1, state: "started", recordingId: result.id, maxDurationMs: result.maxDurationMs, maxBytes: result.maxBytes } },
      };
    },
  });
  pi.registerTool({
    name: "piss_browser_video_stop", label: "PISS browser video stop",
    description: "Stop and finalize the active browser recording. A valid WebM is automatically published in PISS chat.",
    parameters: Type.Object({}),
    async execute() {
      const result = await manager.run(() => manager.stopVideo());
      const artifact = result.candidate.artifact;
      return {
        content: [{ type: "text", text: `Finalized ${artifact.width}×${artifact.height} WebM (${Math.ceil(artifact.durationMs / 100) / 10}s, ${artifact.byteCount} bytes)${result.stoppedBy === "manual" ? "." : `; stopped at the ${result.stoppedBy} limit.`}` }],
        details: { pissBrowserArtifact: result.candidate, pissBrowserRecording: { version: 1, state: "finalized", recordingId: artifact.id, stoppedBy: result.stoppedBy } },
      };
    },
  });
  pi.registerTool({
    name: "piss_browser_close", label: "PISS browser close",
    description: "Close and reset this session's managed browser.",
    parameters: Type.Object({}),
    async execute() {
      const result = await manager.run(() => manager.close());
      return {
        content: [{ type: "text", text: result.interruptedRecordingId ? "Closed the PISS browser and discarded its unfinished recording." : "Closed the PISS browser." }],
        details: result.interruptedRecordingId ? { pissBrowserRecording: { version: 1, state: "interrupted", recordingId: result.interruptedRecordingId, message: "Browser recording was interrupted by browser close" } } : {},
      };
    },
  });
  pi.on("session_shutdown", async () => { await manager.shutdown(); });
}
