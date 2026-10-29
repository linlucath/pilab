import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, setMockScript, ui } from "./fixtures/index";

async function prepare(page: Page) {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
}

async function selectedSessionId(page: Page) {
  const id = await page.locator(".session-row.selected").getAttribute("data-session-id");
  expect(id).toBeTruthy();
  return id!;
}

async function workspaceSession(page: Page, id: string) {
  const response = await page.request.get(new URL("/api/workspace", page.url()).href);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  return data.workspace.sessions.find((session: { id: string }) => session.id === id);
}

test.beforeEach(async ({ page }) => prepare(page));

test("B: detach from A, keep B interactive, then attach with afterSeq and replay A", async ({ page }) => {
  const cursors: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^\/api\/runs\/[^/]+\/stream$/.test(url.pathname)) cursors.push(Number(url.searchParams.get("afterSeq") || 0));
  });
  const sessionA = await selectedSessionId(page);
  await setMockScript(page, [{ type: "slow", text: `A-DETACHED-OUTPUT ${"tail ".repeat(180)}`, chunkSize: 2, delayMs: 30 }]);
  await ui(page).composer.fill("A-DETACHED-PROMPT");
  await ui(page).send.click();
  await expect(page.locator("article.chat-message.assistant").filter({ hasText: "A-DETACHED-OUTPUT" })).toBeVisible();
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionA}"] .session-running-indicator`)).toBeVisible();

  await page.locator(".new-conversation").click();
  const sessionB = await selectedSessionId(page);
  expect(sessionB).not.toBe(sessionA);
  await expect(ui(page).composer).toBeEnabled();
  await setMockScript(page, [{ type: "text", text: "B-INDEPENDENT-REPLY" }]);
  await ui(page).composer.fill("B-INDEPENDENT-PROMPT");
  await ui(page).send.click();
  await expect(page.getByText("B-INDEPENDENT-REPLY", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionA}"] .session-running-indicator`)).toBeVisible();

  await page.locator(`[data-session-id="${sessionA}"] .session-main`).click();
  await expect.poll(() => cursors.length).toBeGreaterThan(2);
  expect(cursors[0]).toBe(0);
  expect(cursors[2]).toBeGreaterThan(0);
  await expect(page.locator("article.chat-message.assistant").filter({ hasText: "A-DETACHED-OUTPUT" })).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionA}"] .session-running-indicator`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("article.chat-message.assistant")).toHaveCount(1);
  expect((await workspaceSession(page, sessionB)).messages.some((message: { content: string }) => message.content.includes("A-DETACHED-OUTPUT"))).toBe(false);
});

test("C: Stop explicitly aborts the server run and preserves partial output", async ({ page }) => {
  let abortUrl = "";
  page.on("request", (request) => {
    if (/^\/api\/runs\/[^/]+\/abort$/.test(new URL(request.url()).pathname) && request.method() === "POST") abortUrl = request.url();
  });
  const sessionId = await selectedSessionId(page);
  await setMockScript(page, [{ type: "slow", text: `C-PARTIAL-OUTPUT ${"retained ".repeat(300)}`, chunkSize: 2, delayMs: 40 }]);
  await ui(page).composer.fill("C-ABORT-PROMPT");
  await ui(page).send.click();
  await expect(page.getByText(/C-PARTIAL-OUTPUT/)).toBeVisible();
  const abortRequest = page.waitForRequest((request) => /^\/api\/runs\/[^/]+\/abort$/.test(new URL(request.url()).pathname) && request.method() === "POST");
  await ui(page).stop.click();
  const request = await abortRequest;
  expect(new URL(request.url()).pathname).toMatch(/^\/api\/runs\/[^/]+\/abort$/);
  await expect(ui(page).stop).toHaveCount(0);
  await expect.poll(async () => {
    const session = await workspaceSession(page, sessionId);
    return session.messages.some((message: { role: string; content: string }) => message.role === "assistant" && message.content.startsWith("C-PARTIAL-OUTPUT"));
  }).toBe(true);
  expect(abortUrl).toBe(request.url());
});

test("D: refresh discovers an active run and reattaches without starting a duplicate", async ({ page }) => {
  let afterRefresh = false;
  let activePolls = 0;
  let runStarts = 0;
  const streamCursors: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/runs" && request.method() === "POST") runStarts++;
    if (afterRefresh && url.pathname === "/api/runs/active") activePolls++;
    if (/^\/api\/runs\/[^/]+\/stream$/.test(url.pathname)) streamCursors.push(Number(url.searchParams.get("afterSeq") || 0));
  });
  const sessionId = await selectedSessionId(page);
  await setMockScript(page, [{ type: "slow", text: `D-RESUMED-OUTPUT ${"continues ".repeat(100)}`, chunkSize: 2, delayMs: 30 }]);
  await ui(page).composer.fill("D-REFRESH-PROMPT");
  await ui(page).send.click();
  await expect(page.getByText(/D-RESUMED-OUTPUT/)).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionId}"] .session-running-indicator`)).toBeVisible();

  afterRefresh = true;
  await page.reload();
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect.poll(() => activePolls).toBeGreaterThan(0);
  await expect.poll(() => streamCursors.length).toBeGreaterThan(1);
  expect(streamCursors.at(-1)).toBe(0);
  expect(runStarts).toBe(1);
  await expect(page.locator("article.chat-message.assistant").filter({ hasText: "D-RESUMED-OUTPUT" })).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionId}"] .session-running-indicator`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("article.chat-message.assistant")).toHaveCount(1);
});

test("E: two sessions keep independent running and ComposerBar state", async ({ page }) => {
  const sessionA = await selectedSessionId(page);
  await setMockScript(page, [{ type: "slow", text: `E-A-OUTPUT ${"short ".repeat(100)}`, chunkSize: 2, delayMs: 25 }]);
  await ui(page).composer.fill("E-A-PROMPT");
  await ui(page).send.click();
  await expect(page.locator("article.chat-message.assistant").filter({ hasText: "E-A-OUTPUT" })).toBeVisible();

  await page.locator(".new-conversation").click();
  const sessionB = await selectedSessionId(page);
  await setMockScript(page, [{ type: "slow", text: `E-B-OUTPUT ${"long ".repeat(240)}`, chunkSize: 2, delayMs: 35 }]);
  await ui(page).composer.fill("E-B-PROMPT");
  await ui(page).send.click();
  await expect(page.locator("article.chat-message.assistant").filter({ hasText: "E-B-OUTPUT" })).toBeVisible();
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionA}"] .session-running-indicator`)).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionB}"] .session-running-indicator`)).toBeVisible();

  await page.locator(`[data-session-id="${sessionA}"] .session-main`).click();
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect(ui(page).stop).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionB}"] .session-running-indicator`)).toBeVisible();
  await expect(page.locator(`[data-session-id="${sessionA}"] .session-running-indicator`)).toHaveCount(0, { timeout: 12_000 });
  await expect(ui(page).composer).toBeEnabled();
  await expect(page.locator(`[data-session-id="${sessionB}"] .session-running-indicator`)).toBeVisible();
  await page.locator(`[data-session-id="${sessionB}"] .session-main`).click();
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect(ui(page).stop).toBeVisible();
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
});
