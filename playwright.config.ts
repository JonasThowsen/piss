import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./v2/browser-test",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "vite --config v2/vite.config.ts --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
