import { test, expect } from "@playwright/test";
import type { Message } from "../shared/schema";
import { e2eSession, openWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";

const msg = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id, role, content, enabled: true, ...extra });
const sidebar = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "会话列表" });
const sessionRows = (page: import("@playwright/test").Page) => sidebar(page).locator(".session-row");

 test("LAY-01 打开本机工作区并在读取失败时重试", async ({ page }) => {
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "工作区读取失败" }) });
    } else await route.continue();
  });
  const navigation = page.goto("/");
  await expect(page.getByRole("status")).toContainText("正在打开本地工作区…");
  await navigation;
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
  await expect(side).toHaveCSS("width", "68px");
  await expect(side.locator(".session-row-actions")).toHaveCount(0);
  await expect(side.locator(".session-initial")).toHaveCount(2);
  await side.locator('[data-session-id="lay-02-b"] .session-main').click();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("Beta");
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
  await expect(side.locator('[data-session-id="lay-03-c"] .session-main')).toBeVisible();
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
  const createButton = sidebar(page).getByRole("button", { name: "新建对话" });
  await expect(createButton).toHaveText("新建对话");
  await expect(createButton.locator("kbd")).toHaveCount(0);
  await expect(createButton).toHaveAttribute("title", "新建对话 (⌘N)");
  await createButton.click();
  await expect(sessionRows(page)).toHaveCount(2);
  await expect(page.locator(".system-banner")).toContainText("你是 Gemini");
  await page.keyboard.press("Meta+n");
  await expect(sessionRows(page)).toHaveCount(3);
  await expect(page.locator(".system-banner")).toContainText("你是 Gemini");

  await sidebar(page).locator('[data-session-id="lay-04-source"] .session-main').click();
  await page.getByRole("textbox", { name: "会话标题" }).fill("Alpha Renamed");
  await expect(sidebar(page).locator('[data-session-id="lay-04-source"] .session-main')).toBeVisible();
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
  const duplicateRow = sessionRows(page).filter({ hasText: "Alpha Renamed · 副本" });
  await duplicateRow.hover();
  await duplicateRow.getByRole("button", { name: "删除 Alpha Renamed · 副本" }).click();
  await expect(sessionRows(page)).toHaveCount(4);
  page.once("dialog", (dialog) => dialog.accept());
  await duplicateRow.hover();
  await duplicateRow.getByRole("button", { name: "删除 Alpha Renamed · 副本" }).click();
  await expect(sessionRows(page)).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("Alpha Renamed");
  page.once("dialog", (dialog) => dialog.dismiss());
  const otherRow = sessionRows(page).nth(1);
  await otherRow.hover();
  await otherRow.locator("button[aria-label^='删除']").click();
  await expect(sessionRows(page)).toHaveCount(3);
  while (await sessionRows(page).count() > 1) {
    const count = await sessionRows(page).count();
    const firstRow = sessionRows(page).first();
    page.once("dialog", (dialog) => dialog.accept());
    await firstRow.hover();
    await firstRow.locator("button[aria-label^='删除']").click();
    await expect(sessionRows(page)).toHaveCount(count - 1);
  }
  page.once("dialog", (dialog) => dialog.accept());
  const lastRow = sessionRows(page).first();
  await lastRow.hover();
  await lastRow.locator("button[aria-label^='删除']").click();
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(sessionRows(page)).toContainText("新建对话");
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("新建对话");
  await expect(ui(page).composer).toBeVisible();
});

test("LAY-07 新建文件夹、拖拽归类排序、折叠改名删除并保持最新会话置顶", async ({ page }) => {
  await seedWorkspace(page, [
    e2eSession("lay-07-a", "Alpha", [msg("lay-07-a-system", "system", "system")]),
    e2eSession("lay-07-b", "Beta", [msg("lay-07-b-system", "system", "system")]),
  ]);
  await openWorkspace(page);
  const side = sidebar(page);
  const rowOrder = () => sessionRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")));
  await expect.poll(rowOrder).toEqual(["lay-07-b", "lay-07-a"]);

  await side.getByRole("button", { name: "新建对话" }).click();
  await expect.poll(rowOrder).toHaveLength(3);
  const newestId = (await rowOrder())[0];
  expect(newestId).not.toBe("lay-07-b");
  await expect(side.locator(".session-row").first()).toHaveAttribute("data-session-id", newestId!);

  await side.getByRole("button", { name: "新建文件夹" }).click();
  const folder = side.locator(".sidebar-folder");
  await expect(folder).toHaveCount(1);
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "新建文件夹");
  await expect(folder.locator(".folder-name-input")).toHaveCount(0);
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    return (await response.json()).workspace.folders.map((item: { name: string }) => item.name);
  }).toEqual(["新建文件夹"]);
  await folder.getByRole("button", { name: "重命名文件夹 新建文件夹" }).click();
  const newFolderInput = folder.locator(".folder-name-input");
  await expect(newFolderInput).toBeFocused();
  await expect(newFolderInput).toHaveValue("新建文件夹");
  expect(await newFolderInput.evaluate((element) => { const input = element as HTMLInputElement; return [input.selectionStart, input.selectionEnd]; })).toEqual([0, 5]);
  await newFolderInput.fill("Research");
  await newFolderInput.press("Enter");
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "Research");
  await folder.getByRole("button", { name: "重命名文件夹 Research" }).click();
  const renameFolderInput = folder.locator(".folder-name-input");
  await expect(renameFolderInput).toBeFocused();
  await renameFolderInput.fill("Research Notes");
  await renameFolderInput.press("Enter");
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "Research Notes");

  await side.locator('.session-row[data-session-id="lay-07-b"]').dragTo(folder.locator(".folder-heading"));
  await expect(folder.locator('.session-row[data-session-id="lay-07-b"]')).toBeVisible();
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    const data = (await response.json()).workspace;
    return { roots: data.rootSessionIds, folderIds: data.folders[0]?.sessionIds };
  }).toEqual({ roots: [newestId, "lay-07-a"], folderIds: ["lay-07-b"] });
  await side.locator('.session-row[data-session-id="lay-07-a"]').dragTo(folder.locator(".folder-heading"));
  await side.locator('.session-row[data-session-id="lay-07-a"]').dragTo(folder.locator('.session-row[data-session-id="lay-07-b"]'), { targetPosition: { x: 10, y: 1 } });
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    const data = (await response.json()).workspace;
    return { roots: data.rootSessionIds, folderIds: data.folders[0]?.sessionIds };
  }).toEqual({ roots: [newestId], folderIds: ["lay-07-a", "lay-07-b"] });
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect.poll(rowOrder).toEqual([newestId, "lay-07-a", "lay-07-b"]);
  await expect(side.locator('.sidebar-folder .session-row[data-session-id="lay-07-a"]')).toBeVisible();

  await folder.locator(".folder-toggle").click();
  await expect(folder.locator(".session-row")).toHaveCount(0);
  await folder.locator(".folder-toggle").click();
  await expect(folder.locator('.session-row[data-session-id="lay-07-b"]')).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await folder.getByRole("button", { name: "删除文件夹 Research Notes" }).click();
  await expect(folder).toHaveCount(0);
  await expect.poll(rowOrder).toEqual([newestId, "lay-07-a", "lay-07-b"]);

  await side.locator('.session-row[data-session-id="lay-07-b"]').dragTo(side.locator(`.session-row[data-session-id="${newestId}"]`), { targetPosition: { x: 10, y: 1 } });
  await expect.poll(rowOrder).toEqual(["lay-07-b", newestId, "lay-07-a"]);
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    return (await response.json()).workspace.rootSessionIds;
  }).toEqual(["lay-07-b", newestId, "lay-07-a"]);
});

test("LAY-08 侧栏只显示标题、动作轻量对齐且收起态不泄漏文本", async ({ page }, testInfo) => {
  await seedWorkspace(page, [
    e2eSession("lay-08-session", "A Long Conversation Title That Should Stay on One Line", [msg("lay-08-system", "system", "system")], { workingDirectory: "/tmp" }),
  ]);
  await page.setViewportSize({ width: 1920, height: 1200 });
  await openWorkspace(page);
  const side = sidebar(page);
  const newConversation = side.locator(".new-conversation");
  const newFolder = side.locator(".new-folder-button");
  await expect(newFolder).toHaveAccessibleName("新建文件夹");
  const conversationBox = await newConversation.boundingBox();
  const folderBox = await newFolder.boundingBox();
  expect(conversationBox!.height).toBe(34);
  expect(folderBox!.height).toBe(34);
  expect(folderBox!.width).toBe(34);
  const row = side.locator('.session-row[data-session-id="lay-08-session"]');
  const title = row.locator(".session-copy > strong");
  await expect(title).toBeVisible();
  await expect(row.locator(".session-copy small")).toHaveCount(0);
  expect(await row.locator(".session-main").getAttribute("title")).toContain("/tmp");
  expect(await title.evaluate((element) => ({ whiteSpace: getComputedStyle(element).whiteSpace, overflow: getComputedStyle(element).textOverflow }))).toEqual({ whiteSpace: "nowrap", overflow: "ellipsis" });
  const actions = row.locator(".session-row-actions");
  await expect(actions).toHaveCSS("position", "absolute");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await side.screenshot({ path: testInfo.outputPath("sidebar-actions-hover.png") });

  await side.getByRole("button", { name: "新建文件夹" }).click();
  const folder = side.locator(".sidebar-folder");
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "新建文件夹");
  await row.dragTo(folder.locator(".folder-heading"));
  const childRow = folder.locator('[data-session-id="lay-08-session"]');
  await expect(childRow).toBeVisible();
  const childLeft = await childRow.boundingBox().then((box) => box!.x);
  const folderLeft = await folder.locator(".folder-heading").boundingBox().then((box) => box!.x);
  expect(childLeft - folderLeft).toBeGreaterThanOrEqual(20);
  await expect(folder.locator(".folder-children")).toHaveCSS("border-left-width", "1px");
  await side.screenshot({ path: testInfo.outputPath("sidebar-expanded.png") });
  await side.getByRole("button", { name: "收起侧栏" }).click();
  await expect(side).toHaveClass(/is-collapsed/);
  await expect(side).toHaveCSS("width", "68px");
  await expect(side.locator(".folder-children")).toHaveCount(0);
  await expect(side.locator(".sidebar-folder .session-row")).toHaveCount(0);
  const brandRight = await side.locator(".brand-mark").boundingBox().then((box) => box!.x + box!.width);
  const collapseLeft = await side.getByRole("button", { name: "展开侧栏" }).boundingBox().then((box) => box!.x);
  expect(brandRight).toBeLessThanOrEqual(collapseLeft);
  const leakedLabels = await side.evaluate((element) => [
    ".session-copy", ".folder-name", ".folder-toggle small", ".session-group-heading", ".new-conversation span", ".new-conversation kbd", ".new-folder-button span",
  ].flatMap((selector) => [...element.querySelectorAll<HTMLElement>(selector)]).filter((node) => node.textContent?.trim() && getComputedStyle(node).display !== "none").map((node) => node.textContent!.trim()));
  expect(leakedLabels).toEqual([]);
  await expect(side.locator(".session-initial")).toHaveCount(0);
  await expect(folder.locator(".folder-toggle")).toBeVisible();
  await side.screenshot({ path: testInfo.outputPath("sidebar-collapsed.png") });
});

test("LAY-09 新建文件夹无需弹窗且失焦时持久化", async ({ page }) => {
  await seedWorkspace(page, [e2eSession("lay-09-session", "Folder creation", [msg("lay-09-system", "system", "system")])]);
  await openWorkspace(page);
  const side = sidebar(page);
  const search = side.getByRole("textbox", { name: "搜索会话" });
  await search.fill("no-such-folder");
  await expect(side.getByText("没有匹配的会话")).toBeVisible();
  await side.getByRole("button", { name: "新建文件夹" }).click();
  await expect(search).toHaveValue("");
  const folder = side.locator(".sidebar-folder");
  await expect(folder).toHaveCount(1);
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "新建文件夹");
  await expect(folder.locator(".folder-name-input")).toHaveCount(0);
  await search.fill("新建");
  await folder.getByRole("button", { name: "重命名文件夹 新建文件夹" }).click();
  await expect(search).toHaveValue("");
  const input = folder.locator(".folder-name-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("新建文件夹");
  await input.fill("Inbox");
  await side.getByRole("textbox", { name: "搜索会话" }).click();
  await expect(folder.locator(".folder-toggle")).toHaveAttribute("title", "Inbox");
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    return (await response.json()).workspace.folders.map((item: { name: string }) => item.name);
  }).toEqual(["Inbox"]);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(side.locator(".sidebar-folder .folder-toggle")).toHaveAttribute("title", "Inbox");

  await side.getByRole("button", { name: "新建文件夹" }).click();
  const defaultFolder = side.locator(".sidebar-folder").nth(1);
  await expect(defaultFolder.locator(".folder-toggle")).toHaveAttribute("title", "新建文件夹");
  await expect(defaultFolder.locator(".folder-name-input")).toHaveCount(0);
  await page.waitForTimeout(2_100);
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    return (await response.json()).workspace.folders.map((item: { name: string }) => item.name);
  }).toEqual(["Inbox", "新建文件夹"]);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(side.locator(".sidebar-folder")).toHaveCount(2);
});

test("LAY-10 窄栏下无需原生弹窗即可创建并保存文件夹", async ({ page }) => {
  await seedWorkspace(page, [e2eSession("lay-10-session", "Mobile folder creation", [msg("lay-10-system", "system", "system")])]);
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  const side = sidebar(page);
  await expect(side).toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: /展开会话栏/ }).click();
  await expect(side).not.toHaveClass(/is-collapsed/);
  await side.getByRole("button", { name: "新建文件夹" }).click();
  const folder = side.locator(".sidebar-folder");
  await expect(folder).toHaveCount(1);
  await expect(folder.locator(".folder-toggle")).toBeVisible();
  await expect(folder.locator(".folder-name-input")).toHaveCount(0);
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    return (await response.json()).workspace.folders.map((item: { name: string }) => item.name);
  }).toEqual(["新建文件夹"]);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(side.locator(".sidebar-folder")).toHaveCount(1);
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
