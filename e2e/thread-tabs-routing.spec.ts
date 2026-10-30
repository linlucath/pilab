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

test("worker conversations use MessageStream with editable native Message[] history", async ({ page }) => {
  const ownerSessionId = "worker-message-owner";
  await seedWorkspace(page, [{ id: ownerSessionId, title: "Worker messages", messages: [firstMessage] }], ownerSessionId);
  const worker = { id: "worker-edit", name: "edit-worker", role: "工程执行员", status: "running", model: "gpt-6", updatedAt: 1,
    ownerSessionId, hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "Latest reply" };
  let messages = [
    { id: "worker-system", role: "system", content: "Worker system instructions", enabled: true },
    { id: "worker-user", role: "user", content: "Inspect this project", enabled: true },
    { id: "worker-assistant", role: "assistant", content: "Worker reply is editable.", enabled: true },
  ];
  await page.route(/\/api\/gpt-sessions\?/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions: [worker] }),
  }));
  await page.route("**/api/gpt-sessions/*/messages?*", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ session: worker, messages }),
  }));

  await page.goto(`/?session=${ownerSessionId}`);
  await expect(page.getByRole("tab", { name: "💬 主会话 (Gemini)" })).toBeVisible();
  await page.getByRole("tab", { name: /edit-worker/ }).click();
  await expect(page.locator(".message-stream")).toContainText("Worker reply is editable.");
  await expect(page.locator(".message-stream")).toContainText("gpt-6 · edit-worker");
  await page.locator(".system-banner").getByRole("button", { name: /展开 \/ 编辑/ }).click();
  await expect(page.locator(".system-banner")).toContainText("Worker system instructions");

  const reply = page.locator('[data-message-id="worker-assistant"]');
  await reply.hover();
  await expect(reply.getByRole("button", { name: "复制消息" })).toBeVisible();
  await expect(reply.getByRole("button", { name: "从此处分支" })).toBeVisible();
  await expect(reply.getByRole("button", { name: "在下方插入消息" })).toBeVisible();
  await reply.getByRole("button", { name: "编辑消息" }).click();
  await reply.getByRole("textbox", { name: "编辑 gpt-6 · edit-worker 消息" }).fill("Edited through the shared message stream.");
  await reply.getByRole("button", { name: "保存消息" }).first().click();
  await expect(reply).toContainText("Edited through the shared message stream.");

  const prompt = page.locator('[data-message-id="worker-user"]');
  await prompt.hover();
  await prompt.getByRole("button", { name: "删除消息" }).click();
  await expect(page.locator('[data-message-id="worker-user"]')).toHaveCount(0);

  messages = [...messages, { id: "worker-next-reply", role: "assistant", content: "Worker replied after editing.", enabled: true }];
  await expect(page.locator(".message-stream")).toContainText("Worker replied after editing.");
  await expect(reply).toContainText("Edited through the shared message stream.");
  await expect(page.locator('[data-message-id="worker-user"]')).toHaveCount(0);
});

test("worker tool history and steering share the main conversation layout while the worker runs", async ({ page }) => {
  const ownerSessionId = "worker-tool-owner";
  await seedWorkspace(page, [{ id: ownerSessionId, title: "Worker tools", messages: [firstMessage] }], ownerSessionId);
  const worker = { id: "worker-running", name: "steer-worker", role: "implementer", status: "running", model: "gpt-6", updatedAt: 1,
    ownerSessionId, hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "" };
  const base = [
    { id: "stream-system", role: "system", content: "Worker system prompt", enabled: true },
    { id: "stream-user", role: "user", content: "Read a file", enabled: true },
    { id: "stream-tool-assistant", role: "assistant", content: "I am checking the file.", enabled: true,
      providerState: { api: "openai-responses", provider: "openai-codex", model: "gpt-6", thinking: [{ type: "thinking", thinking: "I should inspect the file." }] },
      toolCalls: [{ id: "stream-call", name: "read", arguments: JSON.stringify({ path: "README.md" }) }] },
    { id: "stream-tool-result", role: "tool", content: "README contents are available.", enabled: true, toolCallId: "stream-call", toolName: "read" },
    ...Array.from({ length: 36 }, (_, index) => ({ id: `stream-history-${index}`, role: "assistant", content: `History ${index + 1} · ${"worker conversation content ".repeat(16)}`, enabled: true })),
  ];
  let sentBody: Record<string, unknown> | undefined;
  let interruptCalls = 0;
  await page.route(/\/api\/gpt-sessions\?/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions: [worker] }),
  }));
  await page.route("**/api/gpt-sessions/*/messages?*", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ session: worker, messages: base }),
  }));
  await page.route("**/api/gpt-sessions/*/send", async (route) => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: worker, delivery: "accepted" }) });
  });
  await page.route("**/api/gpt-sessions/interrupt", async (route) => {
    interruptCalls++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: worker }) });
  });

  await page.goto(`/?session=${ownerSessionId}`);
  await page.getByRole("tab", { name: /steer-worker/ }).click();
  const stream = page.locator(".message-stream");
  await expect(stream).toContainText("History 36");
  await expect(stream).toContainText("gpt-6 · steer-worker");
  const tool = page.locator(".tool-step-row").first();
  await tool.locator(":scope > summary").click();
  await expect(tool).toContainText("README contents are available.");
  await expect(tool.getByText("gpt-6 · steer-worker 思考过程")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "给工兵发送指导" })).toHaveAttribute("placeholder", "给工兵发送直接指导 (Steer)…");
  await page.getByRole("textbox", { name: "给工兵发送指导" }).fill("Please focus on the failing test.");
  await page.getByRole("button", { name: "发送指导" }).click();
  await expect.poll(() => sentBody).toMatchObject({ ownerSessionId, message: "Please focus on the failing test.", mode: "steer" });
  await expect(stream).toContainText("Please focus on the failing test.");

  await page.locator(".thread-tab-option-wrap").filter({ hasText: "steer-worker" }).hover();
  await page.getByRole("button", { name: "关闭工兵标签 steer-worker" }).click();
  await expect(page.getByRole("tab", { name: "💬 主会话 (Gemini)" })).toHaveAttribute("aria-selected", "true");
  expect(interruptCalls).toBe(0);
  await expect(page.locator(".thread-worker-tab")).toHaveCount(0);
});
