import { createRequire } from "node:module";

const [url, workspace] = process.argv.slice(2);
if (!url || !workspace) throw new Error("browser test URL and workspace are required");
const require = createRequire(import.meta.url);
const { chromium } = require(`${workspace}/node_modules/playwright-core`);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is required");

const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desktop.on("console", (message) => {
    if (message.type() === "error") errors.push(`desktop console: ${message.text()}`);
  });
  desktop.on("pageerror", (error) => errors.push(`desktop page: ${error.message}`));
  await desktop.goto(url, { waitUntil: "networkidle" });
  const textarea = desktop.getByRole("textbox", { name: "Message agent" });
  await textarea.fill("Review @App before release");
  await textarea.evaluate((field) => {
    field.focus();
    field.setSelectionRange(11, 11);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  const appOption = desktop.getByRole("option", { name: /^App\.re web-next\/App\.re$/ });
  await appOption.waitFor();
  await desktop.locator("#file-mention-options").ariaSnapshot();
  await textarea.press("ArrowDown");
  await desktop.waitForFunction(
    () => document.querySelector("#file-mention-1")?.getAttribute("aria-selected") === "true",
  );
  await textarea.press("ArrowUp");
  await textarea.press("Escape");
  await desktop.locator("#file-mention-options").waitFor({ state: "detached" });
  await textarea.evaluate((field) =>
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })),
  );
  await appOption.waitFor();
  await textarea.press("Enter");
  const expected = "Review @web-next/App.re before release";
  if ((await textarea.inputValue()) !== expected) throw new Error("keyboard mention insertion lost surrounding text");
  const requestPromise = desktop.waitForRequest(
    (request) => request.url().includes("/api/v2/commands") && request.method() === "POST",
  );
  await desktop.getByRole("button", { name: "Send message" }).click();
  const body = (await requestPromise).postDataJSON();
  if (body.text !== expected || body.resources?.[0]?.path !== "web-next/App.re") {
    throw new Error(`typed ACP resource input missing: ${JSON.stringify(body)}`);
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on("console", (message) => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  mobile.on("pageerror", (error) => errors.push(`mobile page: ${error.message}`));
  await mobile.goto(url, { waitUntil: "networkidle" });
  const mobileTextarea = mobile.getByRole("textbox", { name: "Message agent" });
  await mobileTextarea.fill("Touch mention ");
  await mobile.getByRole("button", { name: "Mention a workspace file" }).tap();
  await mobileTextarea.type("App");
  const mobileOption = mobile.getByRole("option", { name: /^App\.re web-next\/App\.re$/ });
  await mobileOption.waitFor();
  await mobile.locator("#file-mention-options").ariaSnapshot();
  await mobileOption.tap();
  if ((await mobileTextarea.inputValue()) !== "Touch mention @web-next/App.re") {
    throw new Error("touch mention insertion failed");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("mention browser proof passed: cursor insertion, arrows, Escape, Enter, touch, resource payload, accessibility, and console");
} finally {
  await browser.close();
}
