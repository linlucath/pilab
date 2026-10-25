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

test("ISSUE-06 窄屏工作台抽屉可关闭，390/768/1024 布局保持单行且侧栏不留空白", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadFresh(page);

  const sidebar = page.locator(".sidebar");
  const panel = page.getByRole("complementary", { name: "工作台配置" });
  await expect(panel).toBeHidden();
  expect(await sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
  await expectOneLineTopbar(page);
  await page.getByRole("button", { name: "展开会话栏" }).click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(58);
  await page.getByRole("button", { name: "收起会话栏" }).click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);

  await page.getByRole("button", { name: "显示工作台" }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭工作台", exact: true })).toBeVisible();
  const backdrop = page.locator(".right-panel-backdrop");
  await expect(backdrop).toBeVisible();
  await backdrop.click({ position: { x: 20, y: 50 } });
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "显示工作台" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(panel).toBeHidden();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(68);
  await expectOneLineTopbar(page);
  await page.getByRole("button", { name: "显示工作台" }).click();
  await expect(backdrop).toBeVisible();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "关闭工作台", exact: true }).click();
  await expect(panel).toBeHidden();

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(panel).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await expectOneLineTopbar(page);
  await expect(backdrop).toBeHidden();
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

test("ISSUE-09 运行中分段控件禁用但文字对比度仍可读", async ({ page }) => {
  await loadFresh(page);
  await setMockScript(page, [{ type: "slow", text: "CONTRAST-CHECK " + "生成中。".repeat(60), chunkSize: 2, delayMs: 70 }]);
  await sendMessage(page, "检查禁用控件");
  await expect(page.locator(".composer-running")).toBeVisible();

  const segments = [page.locator(".effort-segment"), page.locator(".mode-segment")];
  const getContrast = async (button: import("@playwright/test").Locator) => button.evaluate((element) => {
    const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [0, 0, 0];
    const luminance = (color: number[]) => color.map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const style = getComputedStyle(element);
    const ownBackground = style.backgroundColor;
    const background = ownBackground === "rgba(0, 0, 0, 0)" ? getComputedStyle(element.parentElement!).backgroundColor : ownBackground;
    const values = [luminance(parse(style.color)), luminance(parse(background))].sort((a, b) => b - a);
    return { ratio: (values[0] + 0.05) / (values[1] + 0.05), opacity: style.opacity };
  });

  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "切换深色模式" }).click();
    for (const segment of segments) {
      const buttons = segment.locator("button");
      await expect(buttons.first()).toBeDisabled();
      for (let index = 0; index < await buttons.count(); index++) {
        const result = await getContrast(buttons.nth(index));
        expect(result.opacity).toBe("1");
        expect(result.ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  await ui(page).stop.click();
});
