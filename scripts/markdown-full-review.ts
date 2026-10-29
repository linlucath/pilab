import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { e2eSession, openWorkspace, seedWorkspace } from "../e2e/fixtures/index";
import type { Message } from "../shared/schema";
import { e2eOrigin, selectE2ePort } from "./e2e-port.mjs";

const root = process.cwd();
const e2ePort = await selectE2ePort();
process.env.PI_LAB_E2E_PORT = String(e2ePort);
const baseURL = e2eOrigin(e2ePort);
const output = path.join(root, "artifacts", "shots", "markdown-full-review.png");
await mkdir(path.dirname(output), { recursive: true });

const server = spawn(process.execPath, ["scripts/start-e2e-server.mjs"], {
  cwd: root,
  env: { ...process.env, PI_LAB_E2E_PORT: String(e2ePort), PI_LAB_E2E_PORT_RESOLVED: "1" },
  stdio: "ignore",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("isolated E2E server exited before becoming ready");
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* The isolated server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("isolated E2E server did not become ready within 90 seconds");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const content = [
      "## Markdown full-feature review",
      "",
      "> A blockquote should have a clear accent rail and contain inline math $E = mc^2$.",
      "",
      "### Unordered list",
      "- Parent item",
      "  - Nested item",
      "    - Third-level item",
      "- Second parent",
      "",
      "### Ordered list",
      "1. First step",
      "   1. Nested step",
      "   2. Another nested step",
      "2. Final step",
      "",
      "### GFM table",
      "| Feature | Markdown | Result |",
      "| :--- | :--- | :--- |",
      "| Quote | `> text` | Styled blockquote |",
      "| Math | `$E = mc^2$` | KaTeX formula |",
      "| Lists | `- item` | Nested markers |",
      "",
      "### Fenced code",
      "```ts",
      "type Equation = { value: 'E = mc²' };",
      "const equation: Equation = { value: 'E = mc²' };",
      "```",
      "",
      "### LaTeX",
      "Inline: $E = mc^2$ and $\\sqrt{x^2 + y^2}$.",
      "",
      "$$",
      "\\frac{a}{b} = \\int_0^1 x^2 \, dx",
      "$$",
    ].join("\n");
    const message: Message = { id: "markdown-review-message", role: "assistant", content, enabled: true };
    await seedWorkspace(page, [e2eSession("markdown-review-session", "Markdown full review", [message])]);
    await openWorkspace(page);

    const body = page.locator('.message-row[data-message-id="markdown-review-message"] .markdown-body');
    await expect(body.locator("blockquote")).toBeVisible();
    await expect(body.locator("ul ul ul")).toBeVisible();
    await expect(body.locator("ol ol")).toBeVisible();
    await expect(body.locator(".table-scroll table tbody tr")).toHaveCount(3);
    await expect(body.locator('.markdown-code .code-head span')).toHaveText("ts");
    await expect(body.locator(".katex").first()).toBeVisible();
    await expect(body.locator(".katex-display")).toBeVisible();

    const markerStyles = await body.evaluate((element) => ({
      unordered: getComputedStyle(element.querySelector("ul")!).listStyleType,
      ordered: getComputedStyle(element.querySelector("ol")!).listStyleType,
      quoteBorder: getComputedStyle(element.querySelector("blockquote")!).borderLeftWidth,
      tableOverflow: getComputedStyle(element.querySelector(".table-scroll")!).overflowX,
    }));
    if (markerStyles.unordered !== "disc" || markerStyles.ordered !== "decimal" || markerStyles.quoteBorder !== "3px" || markerStyles.tableOverflow !== "auto") {
      throw new Error(`Markdown styles missing: ${JSON.stringify(markerStyles)}`);
    }

    await page.screenshot({ path: output, fullPage: true, animations: "disabled" });
    console.log(`Markdown review screenshot saved to ${path.relative(root, output)}`);
  } finally {
    await context.close();
  }
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
