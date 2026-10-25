import { defineConfig } from "@playwright/test";
import { e2eOrigin, selectE2ePort } from "./scripts/e2e-port.mjs";

const e2ePort = await selectE2ePort();
const baseURL = e2eOrigin(e2ePort);

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
    baseURL,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 8_000,
  },
  webServer: {
    command: "node scripts/start-e2e-server.mjs",
    url: `${baseURL}/api/health`,
    env: { PI_LAB_E2E_PORT: String(e2ePort), PI_LAB_E2E_PORT_RESOLVED: "1" },
    timeout: 90_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
