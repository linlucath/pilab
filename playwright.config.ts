import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: "./artifacts/playwright",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 8_000,
  },
  webServer: {
    command: "node scripts/start-e2e-server.mjs",
    url: "http://127.0.0.1:3100/api/health",
    timeout: 90_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
