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
  await expect(page.locator(".right-panel .worker-panel")).toHaveCount(0);
});
