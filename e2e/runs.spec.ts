import { expect, test, type Page } from "@playwright/test";
import { addMessage, openRequestInspector, openWorkspace, resetWorkspace, setMockScript, ui } from "./fixtures/index";

async function ready(page: Page) {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
}
async function expectNoToast(page: Page) {
  // Let any asynchronous notification handler finish before checking absence.
  await page.waitForTimeout(250);
  await expect(page.locator(".toast")).toHaveCount(0);
}
async function runCurrent(page: Page) {
  await page.locator("button.run-current").click();
}
async function openHistory(page: Page) {
  await page.locator(".debug-menu > summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByRole("dialog", { name: "运行记录" })).toBeVisible();
}
async function excludeMessage(page: Page, snippet: string) {
  const row = page.locator(".message-row").filter({ hasText: snippet });
  await row.locator("article").hover();
  await row.getByRole("button", { name: "排除上下文" }).click();
  await expect(row.locator("article")).toHaveClass(/excluded/);
}

test.beforeEach(async ({ page }) => ready(page));

test("RUN-01 请求严格使用已启用的可见历史顺序，不合成隐藏 user 消息", async ({ page }) => {
  await addMessage(page, "user", "RUN01-KEEP-USER");
  await addMessage(page, "assistant", "RUN01-KEEP-ASSISTANT");
  await addMessage(page, "user", "RUN01-EXCLUDED-USER");
  await excludeMessage(page, "RUN01-EXCLUDED-USER");
  await setMockScript(page, [{ type: "text", text: "RUN01-RESPONSE" }]);
  await runCurrent(page);
  await expect(page.getByText("RUN01-RESPONSE", { exact: true })).toBeVisible();
  await openRequestInspector(page);
  const requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("RUN01-KEEP-USER");
  expect(requestText).toContain("RUN01-KEEP-ASSISTANT");
  expect(requestText).not.toContain("RUN01-EXCLUDED-USER");
  const matches = [...requestText.matchAll(/RUN01-KEEP-(?:USER|ASSISTANT)/g)].map((match) => match[0]);
  expect(matches).toEqual(["RUN01-KEEP-USER", "RUN01-KEEP-ASSISTANT"]);
});

test("RUN-01 空或全部排除的上下文被拒绝且不创建运行", async ({ page }) => {
  await addMessage(page, "user", "RUN01-ONLY-USER");
  await page.getByRole("button", { name: "展开 / 编辑" }).click();
  const systemEye = page.locator(".system-message-meta").first().getByRole("button", { name: "排除上下文" });
  await systemEye.click();
  await excludeMessage(page, "RUN01-ONLY-USER");
  await runCurrent(page);
  await expect(ui(page).alerts).toContainText("请先添加至少一条有内容且已启用的消息");
  await expect(ui(page).assistantMessages).toHaveCount(0);
  await openHistory(page);
  await expect(page.getByText("还没有运行记录")).toBeVisible();
});

test("RUN-02 Enter 发送、Shift+Enter 换行，IME 组字确认不触发运行", async ({ page }) => {
  const composer = ui(page).composer;
  await composer.fill("first-line");
  await composer.press("Shift+Enter");
  await composer.type("second-line");
  await expect(composer).toHaveValue("first-line\nsecond-line");
  await composer.dispatchEvent("compositionstart");
  await composer.press("Enter");
  await expect(ui(page).stop).toHaveCount(0);
  await expect(composer).toHaveValue(/first-line\nsecond-line/);
  await composer.dispatchEvent("compositionend");
  await composer.fill("RUN02-ENTER-SEND");
  await setMockScript(page, [{ type: "text", text: "RUN02-ENTER-REPLY" }]);
  await composer.press("Enter");
  await expect(page.getByText("RUN02-ENTER-REPLY", { exact: true })).toBeVisible();
});

test("RUN-02 消息编辑器的 Ctrl+Enter 保存，不冒泡运行会话", async ({ page }) => {
  await addMessage(page, "user", "RUN02-EDIT-TARGET");
  const row = page.locator(".message-row--user-bubble").filter({ hasText: "RUN02-EDIT-TARGET" });
  await row.locator("article").hover();
  await row.getByRole("button", { name: "编辑消息" }).click();
  const editor = row.getByRole("textbox", { name: "编辑 You 消息" });
  await editor.fill("RUN02-EDIT-SAVED");
  await page.getByRole("textbox", { name: "编辑 You 消息" }).press("Control+Enter");
  await expect(page.locator(".message-row").filter({ hasText: "RUN02-EDIT-SAVED" })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openHistory(page);
  await expect(page.getByText("还没有运行记录")).toBeVisible();
});

test("RUN-03 正文、思考与多条助手消息分别呈现，结束后可编辑", async ({ page }) => {
  await setMockScript(page, [
    { type: "tool", input: "run03-tool", assistantText: "RUN03-PROSE-BEFORE-TOOL", thinking: "RUN03-THINKING-ONE" },
    { type: "text", text: "RUN03-FINAL-ASSISTANT", thinking: "RUN03-THINKING-TWO" },
  ]);
  await ui(page).composer.fill("RUN03-START");
  await ui(page).send.click();
  await expect(page.getByText("RUN03-PROSE-BEFORE-TOOL", { exact: true })).toBeVisible();
  await expect(page.getByText("RUN03-FINAL-ASSISTANT", { exact: true })).toBeVisible();
  await expect(ui(page).assistantMessages).toHaveCount(2);
  const thinking = page.locator(".thinking-accordion");
  await expect(thinking).toHaveCount(2);
  await expect(thinking.nth(0)).toContainText("RUN03-THINKING-ONE");
  await expect(thinking.nth(1)).toContainText("RUN03-THINKING-TWO");
  await expect(ui(page).stop).toHaveCount(0);
  const finalRow = page.locator(".message-row").filter({ hasText: "RUN03-FINAL-ASSISTANT" });
  await finalRow.hover();
  await expect(finalRow.getByRole("button", { name: "编辑消息" })).toBeEnabled();
});

test("RUN-03 浏览旧内容时不被长流拉到底部，可一键回到底部", async ({ page }) => {
  await setMockScript(page, [
    { type: "text", text: "RUN03-OLD-HISTORY " + "old-content ".repeat(900), chunkSize: 1000 },
    { type: "slow", text: "RUN03-LONG-STREAM " + "new-content ".repeat(500), chunkSize: 100, delayMs: 60 },
  ]);
  await ui(page).composer.fill("create a long scroll history");
  await ui(page).send.click();
  await expect(page.getByText(/RUN03-OLD-HISTORY/)).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  const stream = page.locator(".message-stream");
  await stream.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "跳到底部" })).toBeVisible();
  await runCurrent(page);
  await expect(ui(page).stop).toBeVisible();
  await page.waitForTimeout(350);
  await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBeLessThan(80);
  await expect(page.getByRole("button", { name: "跳到底部" })).toBeVisible();
  await expect(page.getByText(/RUN03-LONG-STREAM/)).toBeVisible();
  await expect(ui(page).stop).toBeVisible();
  await stream.hover();
  await page.mouse.wheel(0, -8000);
  await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBeLessThan(80);
  const topBefore = await stream.evaluate((element) => element.scrollTop);
  await expect(page.getByText("RUN03-LONG-STREAM", { exact: false })).toBeVisible();
  await page.waitForTimeout(250);
  const topAfter = await stream.evaluate((element) => element.scrollTop);
  expect(topBefore).toBeLessThan(80);
  expect(topAfter).toBeLessThan(80);
  await expect(page.getByRole("button", { name: "跳到底部" })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await page.getByRole("button", { name: "跳到底部" }).click();
  await expect.poll(() => stream.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(120);
});

test("RUN-04 停止流式生成后保留可编辑的部分正文并记录已停止", async ({ page }) => {
  await setMockScript(page, [{ type: "slow", text: "RUN04-PARTIAL-" + "retained text ".repeat(800), chunkSize: 3, delayMs: 30 }]);
  await ui(page).composer.fill("RUN04-STOP-TASK");
  await ui(page).send.click();
  await expect(page.getByText(/RUN04-PARTIAL-/)).toBeVisible();
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
  const partialRow = page.locator(".message-row").filter({ hasText: "RUN04-PARTIAL-" });
  await expect(partialRow).toBeVisible();
  await partialRow.locator("article").hover();
  await partialRow.getByRole("button", { name: "编辑消息" }).click();
  await expect(partialRow.getByRole("textbox", { name: "编辑 Gemini 消息" })).toHaveValue(/RUN04-PARTIAL-/);
  await partialRow.getByRole("button", { name: "取消编辑" }).click();
  await openHistory(page);
  await expect(page.locator(".history-card").first()).toContainText("已停止");
});

test("RUN-04 在首段正文到达前停止会移除空助手占位", async ({ page }) => {
  await setMockScript(page, [{ type: "slow", text: "SHOULD-NEVER-ARRIVE", delayBeforeMs: 1800 }]);
  await ui(page).composer.fill("stop before first token");
  await ui(page).send.click();
  await expect(ui(page).stop).toBeVisible();
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
  await expect(ui(page).assistantMessages).toHaveCount(0);
  await expect(page.getByText("SHOULD-NEVER-ARRIVE", { exact: true })).toHaveCount(0);
});

test("RUN-05 本地连接失败和模型错误显示不同原因", async ({ page }) => {
  await page.route("**/api/runs", (route) => route.abort());
  await ui(page).composer.fill("RUN05-CONNECTION-FAIL");
  await ui(page).send.click();
  await expect(ui(page).alerts).toContainText("网页连接本地服务失败");
  await expectNoToast(page);
  await page.unroute("**/api/runs");

  await setMockScript(page, [{ type: "error", message: "RUN05-UPSTREAM-MODEL-ERROR" }]);
  await ui(page).composer.fill("RUN05-MODEL-FAIL");
  await ui(page).send.click();
  await expect(ui(page).alerts).toContainText("RUN05-UPSTREAM-MODEL-ERROR");
  await expectNoToast(page);
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
});

test("RUN-06 达到输出长度上限时保留正文、状态并允许再次运行", async ({ page }) => {
  await page.getByRole("button", { name: "显示工作台" }).click().catch(() => {});
  await page.getByRole("button", { name: /高级设置与调试/ }).click();
  await page.locator("#max-tokens").fill("1");
  await setMockScript(page, [{ type: "text", text: "RUN06-LENGTH-PARTIAL", reason: "length" }]);
  await ui(page).composer.fill("RUN06-LENGTH-TASK");
  await ui(page).send.click();
  await expect(page.getByText("RUN06-LENGTH-PARTIAL", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("已达到输出上限");
  await openHistory(page);
  await expect(page.locator(".history-card").first()).toContainText("达到长度上限");
  await page.getByRole("button", { name: "关闭调试面板" }).click();
  await setMockScript(page, [{ type: "text", text: "RUN06-CONTINUE-AGAIN" }]);
  await runCurrent(page);
  await expect(page.getByText("RUN06-CONTINUE-AGAIN", { exact: true })).toBeVisible();
});

test("RUN-06 达到 Agent 轮数上限保留已完成工具结果", async ({ page }) => {
  await page.getByRole("button", { name: "显示工作台" }).click().catch(() => {});
  await page.getByRole("button", { name: /高级设置与调试/ }).click();
  await page.locator("#max-turns").fill("1");
  await setMockScript(page, [{ type: "tool", input: "RUN06-TOOL-RESULT" }]);
  await ui(page).composer.fill("RUN06-TURN-LIMIT-TASK");
  await ui(page).send.click();
  await expect(ui(page).stop).toHaveCount(0);
  await page.locator(".tool-group").first().locator(":scope > details > summary").click();
  await ui(page).tool().locator("summary").click();
  await expect(page.getByText("Mock tool result: RUN06-TOOL-RESULT", { exact: true })).toBeVisible();
  await expect(page.locator(".toast")).toContainText("已达到 Agent 最大轮数");
  await openHistory(page);
  await expect(page.locator(".history-card").first()).toContainText("达到 Agent 轮次上限");
  await expect(page.locator(".history-card").first()).toContainText("RUN06-TOOL-RESULT");
});

test("RUN-07 Assistant 结尾续写沿用原历史，不插入合成 user 消息", async ({ page }) => {
  await addMessage(page, "assistant", "RUN07-ASSISTANT-TAIL");
  await setMockScript(page, [{ type: "text", text: "RUN07-CONTINUED" }]);
  await runCurrent(page);
  await expect(page.getByText("RUN07-CONTINUED", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openRequestInspector(page);
  const request = JSON.parse(await page.locator(".request-turn pre").innerText()) as { messages?: Array<{ role?: string; content?: unknown }>; input?: Array<{ type?: string; role?: string; content?: unknown }> };
  const transcript = request.messages || request.input;
  expect(transcript?.at(-1)?.role).toBe("assistant");
  expect(JSON.stringify(transcript)).toContain("RUN07-ASSISTANT-TAIL");
  expect(JSON.stringify(transcript)).not.toContain("RUN07-CONTINUED");
});
