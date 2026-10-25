import { test, expect } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

test.beforeEach(async ({ page }) => {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
});

test("RUN-05 上游流停滞时说明等待超时并保留原始错误和日志", async ({ page }) => {
  const reason = "stream stalled: no data for 120000ms";
  await setMockScript(page, [{ type: "error", message: reason }]);
  await sendMessage(page, "超时诊断测试");
  await expect(ui(page).alerts).toContainText("连续 120 秒未收到数据");
  await expect(ui(page).alerts).toContainText(reason);
  await expect(ui(page).stop).toHaveCount(0);
  await expect(page.locator(".message-row--user-bubble")).toContainText("超时诊断测试");
  await page.getByLabel("打开调试工具", { exact: true }).click();
  await page.getByRole("button", { name: "运行记录", exact: true }).click();
  await expect(page.locator(".run-history")).toContainText(reason);
  const response = await page.request.get("/api/logs?category=run&q=stream%20stalled");
  const { logs } = await response.json();
  expect(logs.some((entry: any) => entry.event === "run_error" && entry.data.reason.includes(reason))).toBe(true);
});

test("RUN-05 本地连接失败与上游模型错误分开显示", async ({ page }) => {
  await page.route("**/api/run", (route) => route.abort("connectionrefused"));
  await sendMessage(page, "连接失败测试");
  await expect(ui(page).alerts).toContainText("网页连接本地服务失败");
  await expect(ui(page).stop).toHaveCount(0);
  const response = await page.request.get("/api/logs?category=client&q=run_request_error");
  expect((await response.json()).logs.length).toBeGreaterThan(0);
});

test("RUN-05 缺少完成事件时保留部分正文并记录断流", async ({ page }) => {
  await page.route("**/api/run", (route) => route.fulfill({
    contentType: "application/x-ndjson",
    body: [
      { type: "assistant_start", id: "partial-reply" },
      { type: "text", id: "partial-reply", delta: "仍应保留的部分回复" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  }));
  await sendMessage(page, "断流测试");
  await expect(ui(page).alerts).toContainText("回复流意外中断");
  await expect(ui(page).assistantMessages).toContainText("仍应保留的部分回复");
  await expect(ui(page).stop).toHaveCount(0);
  const response = await page.request.get("/api/logs?category=client&q=stream_unexpected_eof");
  expect((await response.json()).logs.length).toBeGreaterThan(0);
});
