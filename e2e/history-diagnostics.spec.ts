import { test, expect, type Page } from "@playwright/test";
import { prepareE2eWorkspace, setMockScript, type SeedSession } from "./fixtures/index";

const settings = {
  model: "history-fixture-model",
  reasoning: false,
  reasoningEffort: "off" as const,
};
const session = (id = "history-session", model = settings.model): SeedSession => ({
  id,
  title: id,
  settings: { ...settings, model },
  messages: [{ id: `${id}-user`, role: "user", content: "HISTORY-FIXTURE-PROMPT", enabled: true }],
});

async function openDebugPanel(page: Page, name: string) {
  await page.locator("details.debug-menu > summary").click();
  await page.getByRole("button", { name }).click();
}

async function runCurrent(page: Page, script: Parameters<typeof setMockScript>[1], marker: string) {
  await setMockScript(page, script);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText(marker, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
}

async function postClientLog(page: Page, event: string, message: string) {
  const response = await page.context().request.post(new URL("/api/logs/client", page.url()).href, {
    data: { level: "info", event, message, data: { fixture: true } },
  });
  expect(response.ok(), `client log rejected: ${response.status()}`).toBeTruthy();
}

test("HIS-01 最近运行按时间倒序展示状态、输出和轨迹，最多保留 30 条", async ({ page }) => {
  test.setTimeout(90_000);
  await prepareE2eWorkspace(page, [session()]);

  await runCurrent(page, [{ type: "text", text: "HIS01-OLDEST-RUN" }], "HIS01-OLDEST-RUN");
  await runCurrent(page, [
    { type: "tool", input: "history-trace" },
    { type: "text", text: "HIS01-TOOL-OUTPUT" },
  ], "HIS01-TOOL-OUTPUT");

  await setMockScript(page, [{ type: "slow", text: `HIS01-STOP-PARTIAL-${"streaming ".repeat(120)}`, chunkSize: 3, delayMs: 40 }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText(/HIS01-STOP-PARTIAL/)).toBeVisible();
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  await setMockScript(page, [{ type: "error", message: "HIS01-SCRIPTED-FAILURE" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByRole("alert")).toContainText("HIS01-SCRIPTED-FAILURE");
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  for (let index = 4; index <= 30; index++) {
    const marker = `HIS01-OUTPUT-${index}`;
    await runCurrent(page, [{ type: "text", text: marker }], marker);
  }

  await openDebugPanel(page, "运行记录");
  const cards = page.locator(".history-card");
  await expect(cards).toHaveCount(30);
  await expect(cards.first()).toContainText("HIS01-OUTPUT-30");
  await expect(cards.filter({ hasText: "HIS01-OLDEST-RUN" })).toHaveCount(0);
  await expect(cards.first().locator(".history-meta")).toContainText("history-fixture-model");
  await expect(cards.first()).toContainText("reasoning off");
  await expect(cards.first()).toContainText("已完成");
  await expect(cards.first()).toContainText("tokens");
  await expect(cards.filter({ hasText: "HIS01-TOOL-OUTPUT" }).locator("details")).toHaveCount(1);
  await expect(cards.filter({ hasText: "HIS01-STOP-PARTIAL" })).toContainText("已停止");
  await expect(cards.filter({ hasText: "HIS01-SCRIPTED-FAILURE" })).toContainText("运行失败");
  await expect(cards.first().locator("details")).toHaveCount(0);
});

test("HIS-02 恢复旧运行快照的消息与模型参数，不触发新运行", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-restore", "history-model-before")]);
  await runCurrent(page, [{ type: "text", text: "HIS02-FIRST-RUN" }], "HIS02-FIRST-RUN");

  await page.getByRole("button", { name: /选择模型/ }).click();
  await page.getByLabel("自定义模型 ID").fill("history-model-after");
  const message = page.locator('.message-row[data-message-id="history-restore-user"]');
  await message.locator("article.chat-message").hover();
  await message.getByRole("button", { name: "编辑消息" }).click();
  await page.getByLabel("编辑 You 消息").fill("HIS02-EDITED-CURRENT-PROMPT");
  await page.getByRole("button", { name: "保存消息" }).click();
  await runCurrent(page, [{ type: "text", text: "HIS02-SECOND-RUN" }], "HIS02-SECOND-RUN");

  await openDebugPanel(page, "运行记录");
  const historyCards = page.locator(".history-card");
  await expect(historyCards).toHaveCount(2);
  await historyCards.nth(1).getByRole("button", { name: "恢复输入" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("history-restore");
  await expect(page.getByRole("button", { name: /选择模型，当前 history-model-before/ })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p")).toContainText("HISTORY-FIXTURE-PROMPT");
  await expect(page.locator(".message-row").getByText("HIS02-EDITED-CURRENT-PROMPT")).toHaveCount(0);
  await expect(page.locator(".message-row").getByText("HIS02-FIRST-RUN")).toHaveCount(0);

  const response = await page.context().request.get(new URL("/api/logs?category=run", page.url()).href);
  const { logs } = await response.json() as { logs: { event: string }[] };
  expect(logs.filter((entry) => entry.event === "run_started")).toHaveLength(2);
  const workspaceResponse = await page.context().request.get(new URL("/api/workspace", page.url()).href);
});

test("HIS-03 请求检查展示逐轮实际请求并复制完整多轮 JSON", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-inspector")]);
  await setMockScript(page, [
    { type: "tool", input: "inspector-tool" },
    { type: "text", text: "HIS03-MULTI-TURN-COMPLETE" },
  ]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("HIS03-MULTI-TURN-COMPLETE")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  await openDebugPanel(page, "请求检查");
  const inspector = page.locator(".inspector-view");
  await expect(inspector.locator(".inspector-panel").first()).toContainText("HISTORY-FIXTURE-PROMPT");
  await expect(inspector.getByText("第 1 轮请求")).toBeVisible();
  await expect(inspector.getByText("第 2 轮请求")).toBeVisible();
  await expect(inspector.getByText("e2e_mock_tool").first()).toBeVisible();

  await inspector.getByRole("button", { name: "收起全部" }).click();
  await expect(inspector.locator("details.request-turn[open]")).toHaveCount(0);
  await inspector.getByRole("button", { name: "展开全部" }).click();
  await expect(inspector.locator("details.request-turn[open]")).toHaveCount(2);
  await inspector.getByRole("button", { name: "紧凑 JSON" }).click();
  await expect(inspector.getByRole("button", { name: "美化 JSON" })).toBeVisible();
  await inspector.getByRole("button", { name: "美化 JSON" }).click();
  await expect(inspector.getByRole("button", { name: "紧凑 JSON" })).toBeVisible();
  const wrap = inspector.getByRole("button", { name: "换行" });
  await expect(wrap).toHaveClass(/active/);
  await wrap.click();
  await expect(wrap).not.toHaveClass(/active/);
  await wrap.click();
  await expect(wrap).toHaveClass(/active/);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await inspector.getByRole("button", { name: "复制 JSON" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const requests = JSON.parse(copied) as Record<string, unknown>[];
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0])).toContain("HISTORY-FIXTURE-PROMPT");
  expect(JSON.stringify(requests[1])).toContain("e2e_mock_tool");
  expect(copied).not.toMatch(/authorization|apiKey/i);
});

test("HIS-04 诊断日志支持分类、搜索、展开、复制筛选结果和确认清空", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-diagnostics")]);

  const malformed = await page.context().request.post(new URL("/api/workspace", page.url()).href, {
    data: "{malformed-json",
    headers: { "Content-Type": "application/json" },
  });
  expect(malformed.status()).toBe(400);
  await page.context().request.get(new URL("/api/gpt-sessions", page.url()).href);
  await runCurrent(page, [{ type: "text", text: "HIS04-RUN-LOG" }], "HIS04-RUN-LOG");
  await postClientLog(page, "diagnostic_alpha", "HIS04-FILTER-ALPHA");
  await postClientLog(page, "diagnostic_beta", "HIS04-FILTER-BETA");

  await openDebugPanel(page, "诊断日志");
  const view = page.getByRole("region", { name: "诊断日志" });
  const category = view.getByLabel("类别");
  await category.selectOption("server");
  await expect(view.getByText("request_error", { exact: true })).toBeVisible();
  await category.selectOption("run");
  await expect(view.getByText("run_done", { exact: true })).toBeVisible();
  await category.selectOption("gpt");
  await expect(view.locator(".diagnostic-entry strong").filter({ hasText: "gpt_sessions_list" }).first()).toBeVisible();
  await category.selectOption("client");
  await expect(view.locator(".diagnostic-entry strong").filter({ hasText: "diagnostic_alpha" })).toBeVisible();
  await expect(view.locator(".diagnostic-entry strong").filter({ hasText: "diagnostic_beta" })).toBeVisible();

  await view.getByLabel("搜索诊断日志").fill("HIS04-FILTER-ALPHA");
  const alpha = view.locator(".diagnostic-entry");
  await expect(alpha).toHaveCount(1);
  await alpha.locator("summary").click();
  await expect(alpha.locator("pre")).toContainText("HIS04-FILTER-ALPHA");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await view.getByRole("button", { name: "复制结果" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("HIS04-FILTER-ALPHA");
  expect(copied).not.toContain("HIS04-FILTER-BETA");

  await view.getByLabel("搜索诊断日志").fill("HIS04-REFRESH-MARKER");
  await postClientLog(page, "diagnostic_refresh", "HIS04-REFRESH-MARKER");
  await view.getByRole("button", { name: "刷新" }).click();
  await expect(view.locator(".diagnostic-entry strong").filter({ hasText: "diagnostic_refresh" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.dismiss());
  await view.getByRole("button", { name: "清空日志" }).click();
  await expect(view.locator(".diagnostic-entry strong").filter({ hasText: "diagnostic_refresh" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await view.getByRole("button", { name: "清空日志" }).click();
  await expect(view.getByText("没有符合条件的日志")).toBeVisible();
  await expect(view.getByRole("status")).toContainText("诊断日志已清空");
});
