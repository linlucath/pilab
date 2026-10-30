import { expect, test } from "@playwright/test";
import { openWorkspace, resetWorkspace, ui } from "./fixtures/index";

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
  await openWorkspace(page);
});

test("PERF-01 unchanged workspace polls stay revision-only and remote revisions refresh", async ({ page }) => {
  let fullWorkspaceGets = 0;
  let revisionGets = 0;
  let revisionPayloadBytes = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET") return;
    if (url.pathname === "/api/workspace") fullWorkspaceGets++;
    if (url.pathname === "/api/workspace/revision") revisionGets++;
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== "/api/workspace/revision") return;
    revisionPayloadBytes = (await response.body()).byteLength;
  });

  await page.waitForTimeout(2_300);
  expect(revisionGets).toBeGreaterThan(0);
  expect(fullWorkspaceGets).toBe(0);
  expect(revisionPayloadBytes).toBeLessThan(100);
  console.info(`PERF-01 unchanged polls: ${revisionGets} revision requests, ${revisionPayloadBytes} response bytes, ${fullWorkspaceGets} full workspace requests`);

  const draft = "composer draft survives remote workspace updates";
  await ui(page).composer.fill(draft);
  const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  const workspace = (await saved.json()).workspace as { revision: number; active: string };
  const externalUpdate = await page.context().request.patch(new URL("/api/workspace/changes", page.url()).href, {
    data: { baseRevision: workspace.revision, sessions: [{ id: workspace.active, title: "remote-revision-update" }] },
  });
  expect(externalUpdate.ok()).toBeTruthy();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("remote-revision-update", { timeout: 5_000 });
  await expect(ui(page).composer).toHaveValue(draft);
  expect(fullWorkspaceGets).toBe(1);
});

test("PERF-02 composer input event handling stays below 5ms P95", async ({ page }) => {
  await page.evaluate(() => {
    const samples: number[] = [];
    const starts = new WeakMap<Event, number>();
    document.addEventListener("input", (event) => starts.set(event, performance.now()), true);
    document.addEventListener("input", (event) => {
      if ((event.target as HTMLElement | null)?.getAttribute("aria-label") !== "撰写新消息") return;
      const start = starts.get(event);
      if (start !== undefined) samples.push(performance.now() - start);
    });
    (window as typeof window & { __composerInputLatency?: number[] }).__composerInputLatency = samples;
  });
  await ui(page).composer.focus();
  await ui(page).composer.pressSequentially("p95 input latency validation ".repeat(3), { delay: 10 });
  const latencies = await page.evaluate(() => (window as typeof window & { __composerInputLatency?: number[] }).__composerInputLatency || []);
  expect(latencies.length).toBeGreaterThan(20);
  const sorted = [...latencies].sort((left, right) => left - right);
  const p50 = sorted[Math.ceil(sorted.length * 0.50) - 1];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const max = sorted.at(-1)!;
  console.info(`PERF-02 composer input handler: n=${sorted.length}, p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${max.toFixed(2)}ms`);
  expect(p95).toBeLessThan(5);
});
