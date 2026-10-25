import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { resetWorkspace } from "../e2e/fixtures/index";
import { shotScenarios } from "./shot-scenarios";

const root = process.cwd();
const output = path.join(root, "artifacts", "shots");
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["scripts/start-e2e-server.mjs"], { cwd: root, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("isolated E2E server exited before becoming ready");
    try {
      const response = await fetch("http://127.0.0.1:3100/api/health");
      if (response.ok) { ready = true; break; }
    } catch { /* The child is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("isolated E2E server did not become ready within 90 seconds");
  browser = await chromium.launch();
  for (const scene of shotScenarios) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    try {
      await resetWorkspace(page);
      await scene.run(page);
      await page.screenshot({ path: path.join(output, `${scene.name}.png`), fullPage: true, animations: "disabled" });
    } finally { await context.close(); }
  }
  console.log(`UI shots: ${shotScenarios.length} saved to artifacts/shots/`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  }
}
