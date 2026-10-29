import { expect, test, type Page } from "@playwright/test";
import { seedWorkspace } from "./fixtures/index";

const firstMessage = { id: "route-system", role: "system" as const, content: "system", enabled: true };

async function seedTwoSessions(page: Page) {
  await seedWorkspace(page, [
    { id: "route-first", title: "First route", messages: [firstMessage] },
    { id: "route-second", title: "Second route", messages: [firstMessage] },
  ], "route-first");
}

test("LAY-09 URL session routes remain independent across tabs and refresh", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  try {
    await seedTwoSessions(first);
    await first.goto("/?session=route-first");
    await second.goto("/?session=route-second");
    await expect(first.getByRole("textbox", { name: "会话标题" })).toHaveValue("First route");
    await expect(second.getByRole("textbox", { name: "会话标题" })).toHaveValue("Second route");

    await first.reload();
    await second.reload();
    await expect(first.getByRole("textbox", { name: "会话标题" })).toHaveValue("First route");
    await expect(second.getByRole("textbox", { name: "会话标题" })).toHaveValue("Second route");
    await expect(first).toHaveURL(/\?session=route-first$/);
    await expect(second).toHaveURL(/\?session=route-second$/);
  } finally {
    await context.close();
  }
});

test("GPT worker transcript loads the complete reply history by default", async ({ page }) => {
  const ownerSessionId = "transcript-owner";
  await seedWorkspace(page, [{ id: ownerSessionId, title: "Transcript owner", messages: [firstMessage] }], ownerSessionId);
  const worker = { id: "worker-history", name: "history-worker", status: "idle", model: "codex-mock", updatedAt: 1,
    ownerSessionId, hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "Latest reply" };
  const history = Array.from({ length: 101 }, (_, index) => ({ sequence: index + 1, at: index + 1, type: "assistant", text: `Historical reply ${index + 1}` }));
  let initialLimit: string | null | undefined;
  await page.route(/\/api\/gpt-sessions\?/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions: [worker] }),
  }));
  await page.route("**/api/gpt-sessions/*/transcript?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("after")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: [], hasMore: false }) });
      return;
    }
    initialLimit = query.get("limit");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: history, hasMore: false }) });
  });
  await page.goto(`/?session=${ownerSessionId}`);
  await page.locator(".thread-tab-select").filter({ hasText: "history-worker" }).click();
  await expect(page.locator(".worker-thread-view")).toContainText("Historical reply 101");
  await expect(page.getByText("Historical reply 1", { exact: true })).toBeVisible();
  expect(initialLimit).toBeNull();
  await expect(page.getByRole("button", { name: "读取更早记录" })).toHaveCount(0);
});

test("GPT worker tabs expose compact tool logs, persona context, and sticky scrolling", async ({ page }) => {
  const ownerSessionId = "worker-ux-owner";
  await seedWorkspace(page, [{ id: ownerSessionId, title: "Worker UX", messages: [firstMessage] }], ownerSessionId);
  const worker = { id: "worker-ux", name: "ux-worker", role: "工程执行员", rolePreset: "implementer", status: "running", model: "codex-mock", updatedAt: 1,
    ownerSessionId, hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "" };
  const events = [
    { sequence: 1, at: 1, type: "message_sent", text: "Implement the requested UX and verify the focused browser tests." },
    { sequence: 2, at: 2, type: "tool_start", text: '{"path":"specs/behaviors.md"}', toolName: "read", toolCallId: "read-1" },
    { sequence: 3, at: 3, type: "tool_progress", text: "Reading behavior expectations", toolName: "read", toolCallId: "read-1" },
    { sequence: 4, at: 4, type: "tool_end", text: "Behavior expectations loaded", toolName: "read", toolCallId: "read-1" },
    { sequence: 5, at: 5, type: "tool_start", text: '{"path":"src/MessageStream.tsx"}', toolName: "edit", toolCallId: "edit-1" },
    { sequence: 6, at: 6, type: "tool_end", text: "Updated stream scrolling", toolName: "edit", toolCallId: "edit-1" },
    ...Array.from({ length: 25 }, (_, index) => ({ sequence: index + 7, at: index + 7, type: "assistant", text: `History ${index + 1} · ${"worker history content ".repeat(18)}` })),
  ];
  await page.route(/\/api\/gpt-sessions\?/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions: [worker] }),
  }));
  await page.route("**/api/gpt-sessions/*/transcript?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("after")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        events: [{ sequence: 32, at: 32, type: "assistant", text: "New reply arrived while reading history." }],
        persona: { dispatchContext: events[0].text },
      }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      events, hasMore: false,
      persona: { dispatchContext: events[0].text },
    }) });
  });
  await page.goto(`/?session=${ownerSessionId}`);
  await page.locator(".thread-tab-select").filter({ hasText: "ux-worker" }).click();
  const persona = page.locator(".worker-persona");
  await expect(persona).toContainText("工兵人设 · 工程执行员 implementer");
  await persona.getByRole("button").click();
  await expect(persona).toContainText("System prompt");
  await expect(persona).toContainText("你是工程执行员");
  await expect(persona).toContainText("Implement the requested UX and verify the focused browser tests.");

  const toolGroup = page.locator(".worker-tool-group");
  await expect(toolGroup).toHaveCount(1);
  await expect(toolGroup.locator(".worker-tool-call").first()).toBeHidden();
  await toolGroup.locator(":scope > summary").click();
  await expect(toolGroup).toContainText("已读取 specs/behaviors.md");
  await expect(toolGroup).toContainText("已编辑 src/MessageStream.tsx");
  const readCall = toolGroup.locator(".worker-tool-call").first();
  await readCall.locator(":scope > summary").click();
  await expect(readCall).toContainText("Behavior expectations loaded");
  await persona.getByRole("button").click();

  const scroll = page.locator(".worker-transcript-scroll");
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(page.getByRole("button", { name: "跳到底部工兵记录" })).toBeVisible();
  await expect(page.getByText("New reply arrived while reading history.", { exact: true })).toBeVisible({ timeout: 6_000 });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThan(80);
  await page.getByRole("button", { name: "跳到底部工兵记录" }).click();
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await persona.getByRole("button").click();
  const personaColumns = await persona.locator(".worker-persona-content").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(personaColumns).toBe(1);
  const transcriptWidth = await page.locator(".worker-thread-view").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(transcriptWidth.scroll).toBeLessThanOrEqual(transcriptWidth.client);
});

test("GPT worker tabs expose owned transcripts and send guidance without the old workbench drawer", async ({ page }) => {
  const ownerSessionId = "thread-owner";
  await seedWorkspace(page, [{ id: ownerSessionId, title: "Owner", messages: [firstMessage] }], ownerSessionId);
  let sessions = [
    { id: "worker-live", name: "live-worker", role: "implementer", status: "running", model: "codex-mock", updatedAt: 1,
      ownerSessionId, hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "" },
    { id: "worker-idle", name: "idle-worker", status: "idle", model: "codex-mock", updatedAt: 2,
      ownerSessionId, hasUnreadReply: true, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "Completed" },
  ];
  let sentBody: Record<string, unknown> | undefined;
  await page.route(/\/api\/gpt-sessions\?/, async (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions }),
  }));
  await page.route("**/api/gpt-sessions/*/transcript?*", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ events: [{ sequence: 1, at: 1, type: "assistant", text: "Transcript marker" }], hasMore: false }),
  }));
  await page.route("**/api/gpt-sessions/*/send", async (route) => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });
  await page.goto("/?session=thread-owner");

  await expect(page.locator(".thread-tab").filter({ hasText: "live-worker" })).toContainText("运行中");
  await expect(page.locator(".thread-tab").filter({ hasText: "idle-worker" })).toContainText("空闲");
  await page.locator(".thread-tab-select").filter({ hasText: "live-worker" }).click();
  await expect(page.locator(".worker-thread-view")).toContainText("Transcript marker");
  await page.getByRole("textbox", { name: "指导工兵" }).fill("Please verify the edge case");
  await page.getByRole("button", { name: "发送指导" }).click();
  await expect.poll(() => sentBody).toMatchObject({ ownerSessionId, message: "Please verify the edge case" });
  await expect(page.locator(".right-panel")).toHaveCount(0);
});
