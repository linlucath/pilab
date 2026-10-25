import { test, expect } from "@playwright/test";
import type { Message } from "../shared/schema";
import { e2eSession, openWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";

const msg = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id, role, content, enabled: true, ...extra });
const sidebar = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "会话列表" });
const sessionRows = (page: import("@playwright/test").Page) => sidebar(page).locator(".session-row");

 test("LAY-01 打开本机工作区并在读取失败时重试", async ({ page }) => {
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "工作区读取失败" }) });
    else await route.continue();
  });
  await page.goto("/");
  const loading = page.getByRole("status");
  await expect(loading).toContainText("工作区读取失败");
  await expect(loading.getByRole("button", { name: "重试" })).toBeVisible();
  await page.unroute("**/api/workspace");
  await loading.getByRole("button", { name: "重试" }).click();
  await expect(ui(page).composer).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeVisible();
  await expect(page.locator(".message-stream")).toBeVisible();
});

test("LAY-02 收起与展开侧栏并在窄屏保持会话可切换且无横向溢出", async ({ page }) => {
  await seedWorkspace(page, [
    e2eSession("lay-02-a", "Alpha", [msg("lay-02-a-system", "system", "system")]),
    e2eSession("lay-02-b", "Beta", [msg("lay-02-b-system", "system", "system")]),
  ]);
  await openWorkspace(page);
  const side = sidebar(page);
  await side.getByRole("button", { name: "收起侧栏" }).click();
  await expect(side).toHaveClass(/is-collapsed/);
  await expect(side.locator(".session-row-actions")).toHaveCount(0);
  await expect(side.locator(".session-initial")).toHaveCount(2);
  await side.getByRole("button", { name: "展开侧栏" }).click();
  await expect(side).not.toHaveClass(/is-collapsed/);
  await expect(side.getByText("Alpha")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(side.locator(".session-initial")).toHaveCount(2);
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(side).toHaveClass(/is-collapsed/);
  await expect(side.locator(".session-initial")).toHaveCount(2);
  await page.getByRole("button", { name: "展开会话栏" }).click();
  await expect(side).not.toHaveClass(/is-collapsed/);
  await side.locator('[data-session-id="lay-02-b"] .session-main').click();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("Beta");
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
  await expect(ui(page).composer).toBeVisible();
});

test("LAY-03 搜索标题、来源标题与工作目录，清空或无匹配不改变会话", async ({ page }) => {
  await seedWorkspace(page, [
    e2eSession("lay-03-a", "Alpha", [msg("lay-03-a-system", "system", "system")], { workingDirectory: "/tmp/lab-alpha" }),
    { ...e2eSession("lay-03-b", "Derived", [msg("lay-03-b-system", "system", "system")], { workingDirectory: "/tmp/lab-beta" }), parentSessionTitle: "Alpha Parent" },
    e2eSession("lay-03-c", "Gamma", [msg("lay-03-c-system", "system", "system")], { workingDirectory: "/tmp/lab-gamma" }),
  ]);
  await openWorkspace(page);
  const side = sidebar(page);
  const search = side.getByRole("textbox", { name: "搜索会话" });
  await search.fill("derived");
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(side.getByText("Derived")).toBeVisible();
  await search.fill("alpha parent");
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(side.getByText("Derived")).toBeVisible();
  await search.fill("lab-gamma");
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(side.getByRole("button", { name: /^Gamma / })).toBeVisible();
  await search.fill("no-such-session");
  await expect(side.getByText("没有匹配的会话")).toBeVisible();
  await search.fill("");
  await expect(sessionRows(page)).toHaveCount(3);
  const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  const workspace = (await saved.json()).workspace;
  expect(workspace.sessions.map((session: { title: string }) => session.title)).toEqual(["Alpha", "Derived", "Gamma"]);
});

test("LAY-04 新建、快捷键新建、改名复制及确认删除会话", async ({ page }) => {
  await seedWorkspace(page, [e2eSession("lay-04-source", "Alpha", [
    msg("lay-04-system", "system", "system prompt"),
    msg("lay-04-user", "user", "seeded conversation"),
  ], { model: "layout-test-model", temperature: 0.31 })]);
  await openWorkspace(page);
  await sidebar(page).getByRole("button", { name: "新建对话" }).click();
  await expect(sessionRows(page)).toHaveCount(2);
  await expect(page.locator(".system-banner")).toContainText("你是 Gemini");
  await page.keyboard.press("Meta+n");
  await expect(sessionRows(page)).toHaveCount(3);
  await expect(page.locator(".system-banner")).toContainText("你是 Gemini");

  await sidebar(page).locator('[data-session-id="lay-04-source"] .session-main').click();
  await page.getByRole("textbox", { name: "会话标题" }).fill("Alpha Renamed");
  await expect(sidebar(page).getByRole("button", { name: /^Alpha Renamed / })).toBeVisible();
  await setMockScript(page, [{ type: "text", text: "SOURCE-RUN-RECORD" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("SOURCE-RUN-RECORD")).toBeVisible();
  await page.locator(".debug-menu > summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.locator(".history-card")).toContainText("SOURCE-RUN-RECORD");
  await page.getByRole("button", { name: "关闭调试面板" }).click();
  const sourceRow = sidebar(page).locator('.session-row[data-session-id="lay-04-source"]');
  await sourceRow.hover();
  await sourceRow.getByRole("button", { name: "复制 Alpha Renamed" }).click();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("Alpha Renamed · 副本");
  await expect(page.locator('[data-message-id="lay-04-user"]')).toContainText("seeded conversation");
  await expect(page.locator("#main-model")).toHaveValue("layout-test-model");
  await page.locator(".debug-menu > summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByRole("heading", { name: "还没有运行记录" })).toBeVisible();
  await page.getByRole("button", { name: "关闭调试面板" }).click();

  page.once("dialog", (dialog) => dialog.dismiss());
  await sessionRows(page).filter({ hasText: "Alpha Renamed · 副本" }).getByRole("button", { name: "删除 Alpha Renamed · 副本" }).click();
  await expect(sessionRows(page)).toHaveCount(4);
  page.once("dialog", (dialog) => dialog.accept());
  await sessionRows(page).filter({ hasText: "Alpha Renamed · 副本" }).getByRole("button", { name: "删除 Alpha Renamed · 副本" }).click();
  await expect(sessionRows(page)).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("Alpha Renamed");
  page.once("dialog", (dialog) => dialog.dismiss());
  await sessionRows(page).nth(1).locator("button[aria-label^='删除']").click();
  await expect(sessionRows(page)).toHaveCount(3);
  const removable = sessionRows(page).locator("button[aria-label^='删除']");
  while (await sessionRows(page).count() > 1) {
    const count = await sessionRows(page).count();
    page.once("dialog", (dialog) => dialog.accept());
    await removable.first().click();
    await expect(sessionRows(page)).toHaveCount(count - 1);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await sessionRows(page).locator("button[aria-label^='删除']").click();
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(sessionRows(page)).toContainText("新建对话");
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("新建对话");
  await expect(ui(page).composer).toBeVisible();
});

test("LAY-05 工作台、主题与工具折叠互不影响且主题和折叠选择刷新后保留", async ({ page }) => {
  const call = { id: "lay-05-call", name: "e2e_mock_tool", arguments: "{}" };
  await seedWorkspace(page, [e2eSession("lay-05-session", "Workspace toggles", [
    msg("lay-05-system", "system", "system"),
    msg("lay-05-assistant", "assistant", "", { toolCalls: [call] }),
    msg("lay-05-result", "tool", "tool result", { toolCallId: call.id, toolName: call.name }),
    msg("lay-05-user", "user", "last message"),
  ], { model: "toggle-test-model" })]);
  await openWorkspace(page);
  await expect(page.locator(".tool-group > details")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "隐藏工作台" }).click();
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeHidden();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "展开工具" })).toBeVisible();
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeHidden();
  await page.getByRole("button", { name: "展开工具" }).click();
  await expect(page.locator(".tool-group > details")).toHaveAttribute("open", "");
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeHidden();
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "收起工具" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeVisible();
  await expect(page.locator("#main-model")).toHaveValue("toggle-test-model");
});
