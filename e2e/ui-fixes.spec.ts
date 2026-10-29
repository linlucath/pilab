import { expect, test } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

async function loadFresh(page: import("@playwright/test").Page) {
  await resetWorkspace(page);
  await openWorkspace(page);
}

async function expectOneLineTopbar(page: import("@playwright/test").Page) {
  const topbar = page.locator(".topbar");
  const [bar, leading, trailing] = await Promise.all([
    topbar.boundingBox(),
    page.locator(".topbar-leading").boundingBox(),
    page.locator(".topbar-trailing").boundingBox(),
  ]);
  expect(bar).not.toBeNull();
  expect(leading).not.toBeNull();
  expect(trailing).not.toBeNull();
  expect(Math.abs(leading!.y - trailing!.y)).toBeLessThanOrEqual(1);
  expect(trailing!.x + trailing!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

test("ISSUE-06 设置面板在所有断点均已移除，390/768/1024 布局保持单行且侧栏不留空白", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadFresh(page);

  const sidebar = page.locator(".sidebar");
  const removedPanel = page.locator(".right-panel, .right-panel-backdrop");
  await expect(removedPanel).toHaveCount(0);
  expect(await sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
  await expectOneLineTopbar(page);
  await page.getByRole("button", { name: "展开会话栏" }).click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(58);
  await page.getByRole("button", { name: "收起会话栏" }).click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(removedPanel).toHaveCount(0);
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(68);
  await expectOneLineTopbar(page);

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(removedPanel).toHaveCount(0);
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await expectOneLineTopbar(page);
});

test("ISSUE-07 流式状态只在底部运行栏显示", async ({ page }) => {
  await loadFresh(page);
  await setMockScript(page, [{ type: "slow", text: "STATUS-ONCE " + "持续生成中。".repeat(25), chunkSize: 3, delayMs: 60 }]);
  await sendMessage(page, "检查状态提示重复");
  await expect(page.getByText(/STATUS-ONCE/)).toBeVisible();
  await expect(page.locator(".composer-running")).toContainText("Gemini 正在思考");
  await expect(page.getByText(/Gemini 正在思考 \/ 调度 GPT/)).toHaveCount(0);
  await ui(page).stop.click();
});

test("ISSUE-08 流式助手正文末尾显示光标，生成完成后移除", async ({ page }) => {
  await loadFresh(page);
  await setMockScript(page, [{ type: "slow", text: "CARET-PREVIEW " + "继续输出。".repeat(14), chunkSize: 2, delayMs: 55 }]);
  await sendMessage(page, "检查生成光标");
  await expect(page.getByText(/CARET-PREVIEW/)).toBeVisible();
  const cursor = page.locator(".chat-message.assistant .streaming-cursor");
  await expect(cursor).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0, { timeout: 8_000 });
  await expect(cursor).toHaveCount(0);
});

test("ISSUE-09 运行中模型控件收起且工具模式开关不可见", async ({ page }) => {
  await loadFresh(page);
  await setMockScript(page, [{ type: "slow", text: "RUNNING-CONTROLS " + "生成中。".repeat(60), chunkSize: 2, delayMs: 70 }]);
  await sendMessage(page, "检查运行中设置入口");
  await expect(page.locator(".composer-running")).toBeVisible();
  await expect(page.locator(".composer-model-controls")).toHaveCount(0);
  await expect(page.getByLabel("工具模式")).toHaveCount(0);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await ui(page).stop.click();
});
