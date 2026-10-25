import { test, expect } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
  await openWorkspace(page);
});

test("SMOKE-01 页面加载并显示新对话输入框", async ({ page }) => {
  await expect(page.getByRole("complementary", { name: "会话列表" })).toBeVisible();
  await expect(ui(page).composer).toBeVisible();
});

test("SMOKE-02 发送消息后收到 mock 流式回复", async ({ page }) => {
  await setMockScript(page, [{ type: "text", text: "MOCK-STREAM-OK", chunkSize: 2, delayMs: 15 }]);
  await sendMessage(page, "请回复测试消息");
  await expect(page.getByText("MOCK-STREAM-OK")).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
});

test("SMOKE-03 运行中可以停止并保留已收到的内容", async ({ page }) => {
  await setMockScript(page, [{ type: "slow", text: "STOP-CHECK-" + "still streaming ".repeat(300), chunkSize: 3, delayMs: 120 }]);
  await sendMessage(page, "开始慢速响应");
  await expect(page.getByText(/STOP-CHECK/)).toBeVisible();
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
  await expect(page.getByText(/STOP-CHECK/)).toBeVisible();
});

test("SMOKE-04 刷新后对话和 mock 回复仍保留", async ({ page }) => {
  await setMockScript(page, [{ type: "text", text: "PERSIST-AFTER-REFRESH" }]);
  await sendMessage(page, "保存这段对话");
  await expect(page.getByText("PERSIST-AFTER-REFRESH")).toBeVisible();
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(page.locator(".message-row--user-bubble").getByText("保存这段对话")).toBeVisible();
  await expect(page.getByText("PERSIST-AFTER-REFRESH")).toBeVisible();
});

test("SMOKE-05 脚本化工具调用仅执行安全 mock 工具", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "smoke-tool" }, { type: "text", text: "TOOL-CALL-COMPLETE" }]);
  await sendMessage(page, "运行模拟工具");
  const group = page.locator(".tool-group > details");
  await expect(group).toBeVisible();
  await group.locator(":scope > summary").click();
  const tool = ui(page).tool();
  await expect(tool).toBeVisible();
  await tool.locator("summary").click();
  await expect(page.getByText("TOOL-CALL-COMPLETE")).toBeVisible();
  await expect(page.getByText("Mock tool result: smoke-tool")).toBeVisible();
});
