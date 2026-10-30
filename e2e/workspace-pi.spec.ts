import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

type PersistedSession = { id: string; title: string; messages: { id: string; role: string; content: string; enabled: boolean; toolCalls?: { id: string }[]; toolCallId?: string }[]; settings: Record<string, unknown>; runs?: unknown[] };
type PersistedWorkspace = { sessions: PersistedSession[]; active: string; hiddenPiSessions: string[]; followPi: boolean; revision: number };

async function prepare(page: Page) {
  await resetWorkspace(page);
  await openWorkspace(page);
  await expect(ui(page).composer).toBeVisible();
}
async function savedWorkspace(page: Page) {
  const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).workspace as PersistedWorkspace;
}
async function waitForWorkspace(page: Page, predicate: (workspace: PersistedWorkspace) => boolean) {
  await expect.poll(async () => predicate(await savedWorkspace(page))).toBe(true);
}
async function setSetting(page: Page, id: string, value: string) {
  if (id !== "main-model") throw new Error(`设置 ${id} 已不在 Composer 控件范围内。`);
  await page.getByRole("button", { name: /选择模型/ }).click();
  await page.getByLabel("自定义模型 ID").fill(value);
}
async function editMessage(page: Page, content: string, replacement: string) {
  const saved = await savedWorkspace(page);
  const message = saved.sessions.find((session) => session.id === saved.active)?.messages.find((item) => item.content === content);
  expect(message, `message ${content} exists`).toBeTruthy();
  const row = page.locator(`.message-row[data-message-id="${message!.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "编辑消息" }).click();
  await row.getByRole("textbox", { name: /编辑/ }).fill(replacement);
  await row.getByRole("button", { name: "保存消息" }).click();
  return message!.id;
}
async function runWithReply(page: Page, prompt: string, reply: string) {
  await setMockScript(page, [{ type: "text", text: reply, chunkSize: 3, delayMs: 2 }]);
  await sendMessage(page, prompt);
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => prepare(page));

test("WSP-01 刷新后恢复工作区会话、消息和配置", async ({ page }) => {
  await page.getByRole("textbox", { name: "会话标题" }).fill("refresh-persist-title");
  await setSetting(page, "main-model", "e2e-model-persisted");
  await runWithReply(page, "prompt-persisted", "reply-persisted");
  await waitForWorkspace(page, (workspace) => {
    const active = workspace.sessions.find((session) => session.id === workspace.active);
    return active?.title === "refresh-persist-title" && active.settings.model === "e2e-model-persisted" && typeof active.settings.workingDirectory === "string" && active.settings.workingDirectory.length > 0 && active.messages.some((message) => message.content === "reply-persisted");
  });
  const source = (await savedWorkspace(page)).sessions.find((session) => session.title === "refresh-persist-title")!;

  await page.getByRole("button", { name: "新建对话" }).click();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === 2 && workspace.active !== source.id);
  await page.getByRole("textbox", { name: "会话标题" }).fill("secondary-session");
  await waitForWorkspace(page, (workspace) => workspace.sessions.some((session) => session.title === "secondary-session"));

  const beforeReload = await savedWorkspace(page);
  const persistedSource = beforeReload.sessions.find((session) => session.id === source.id)!;
  const secondary = beforeReload.sessions.find((session) => session.title === "secondary-session")!;
  expect(persistedSource.title).toBe("refresh-persist-title");
  expect(persistedSource.settings.model).toBe("e2e-model-persisted");
  expect(persistedSource.messages.map((message) => message.content)).toEqual(expect.arrayContaining(["prompt-persisted", "reply-persisted"]));
  expect(persistedSource.settings.workingDirectory).toBeTruthy();
  expect(secondary.settings.workingDirectory).toBeTruthy();
  expect(new Set([persistedSource.settings.workingDirectory, secondary.settings.workingDirectory]).size).toBe(2);

  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  const reloaded = await savedWorkspace(page);
  expect(reloaded.sessions).toHaveLength(2);
  const reloadedSource = reloaded.sessions.find((session) => session.id === source.id)!;
  expect(reloadedSource.title).toBe("refresh-persist-title");
  expect(reloadedSource.settings.model).toBe("e2e-model-persisted");
  expect(reloadedSource.messages.map((message) => message.content)).toEqual(expect.arrayContaining(["prompt-persisted", "reply-persisted"]));
  await page.locator(`.session-row[data-session-id="${source.id}"] .session-main`).click();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("refresh-persist-title");
  await expect(page.getByRole("button", { name: /选择模型，当前 e2e-model-persisted/ })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "prompt-persisted" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "reply-persisted" })).toBeVisible();
  await expect(page.locator(".right-panel")).toHaveCount(0);
});

test("WSP-01 保存失败提示且草稿保留并自动重试", async ({ page }) => {
  let rejected = false;
  await page.route("**/api/workspace/changes", async (route) => {
    const delta = route.request().postDataJSON();
    const hasTarget = delta.sessions?.some((session: { title?: string }) => session.title === "retry-after-save-error");
    if (!rejected && route.request().method() === "PATCH" && hasTarget) {
      rejected = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock disk failure" }) });
    } else await route.continue();
  });
  await page.getByRole("textbox", { name: "会话标题" }).fill("retry-after-save-error");
  await expect(page.locator(".save-state")).toHaveText("保存失败");
  await expect(page.locator(".toast")).toContainText("mock disk failure");
  await waitForWorkspace(page, (workspace) => workspace.sessions.find((session) => session.id === workspace.active)?.title === "retry-after-save-error");
  expect(rejected).toBe(true);
});

test("WSP-02 两个标签页并发时合并消息重排与另一字段修改", async ({ page, context }) => {
  await runWithReply(page, "PROMPT-A", "REPLY-A");
  await setMockScript(page, [{ type: "text", text: "REPLY-B", chunkSize: 4, delayMs: 2 }]);
  await sendMessage(page, "PROMPT-B");
  await expect(page.getByText("REPLY-B", { exact: true })).toBeVisible();
  await waitForWorkspace(page, (workspace) => workspace.sessions[0]?.messages.some((message) => message.content === "PROMPT-B"));

  await expect(page.locator(".save-state")).toHaveText("已保存");
  const secondPage = await context.newPage();
  await openWorkspace(secondPage);
  await expect(ui(secondPage).composer).toBeVisible();
  await expect(secondPage.locator(".save-state")).toHaveText("已保存");
  const original = await savedWorkspace(page);
  const active = original.sessions.find((session) => session.id === original.active)!;
  const promptB = active.messages.find((message) => message.content === "PROMPT-B")!;
  const promptBRow = page.locator(`.message-row[data-message-id="${promptB.id}"]`);
  const expectedOrder = active.messages.map((message) => message.id);
  const promptBIndex = expectedOrder.indexOf(promptB.id);
  [expectedOrder[promptBIndex - 1], expectedOrder[promptBIndex]] = [expectedOrder[promptBIndex], expectedOrder[promptBIndex - 1]];

  let release!: () => void;
  let intercept!: () => void;
  const held = new Promise<void>((resolve) => { intercept = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let heldOnce = false;
  let heldDelta: { sessions?: { id: string; messages?: { id: string }[] }[] } | undefined;
  await page.route("**/api/workspace/changes", async (route) => {
    if (!heldOnce && route.request().method() === "PATCH") {
      heldDelta = route.request().postDataJSON();
      heldOnce = true;
      intercept();
      await gate;
    }
    await route.continue();
  });
  await promptBRow.hover();
  const moveUp = promptBRow.getByRole("button", { name: "上移消息" });
  await expect(moveUp).toBeEnabled();
  await moveUp.focus();
  await moveUp.press("Enter");
  await expect.poll(() => page.locator(".message-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id")))).toEqual(expectedOrder.filter((id) => !active.messages[0] || id !== active.messages[0].id));
  await held;
  expect(heldDelta?.sessions?.some((patch) => patch.id === active.id && patch.messages?.some((message) => message.id === promptB.id))).toBe(true);

  await editMessage(secondPage, "REPLY-A", "REMOTE-FIELD-EDIT");
  await waitForWorkspace(secondPage, (workspace) => workspace.sessions[0]?.messages.some((message) => message.content === "REMOTE-FIELD-EDIT"));
  // The first tab's stale reorder is delivered only after the second tab's text edit is on disk.
  release();
  await expect.poll(async () => heldOnce && (await savedWorkspace(page)).sessions.find((session) => session.id === active.id)?.messages.some((message) => message.content === "REMOTE-FIELD-EDIT")).toBe(true);
  await waitForWorkspace(page, (workspace) => {
    const merged = workspace.sessions.find((session) => session.id === active.id)!;
    return merged.messages.map((message) => message.id).join(",") === expectedOrder.join(",") && merged.messages.some((message) => message.content === "REMOTE-FIELD-EDIT");
  });
  const merged = (await savedWorkspace(page)).sessions.find((session) => session.id === active.id)!;
  expect(merged.messages.map((message) => message.id)).toEqual(expectedOrder);
  expect(merged.messages.find((message) => message.id === promptB.id)?.content).toBe("PROMPT-B");
  await secondPage.reload();
  await expect(secondPage.getByText("REMOTE-FIELD-EDIT", { exact: true })).toBeVisible();
  await secondPage.close();
});

test("WSP-02 同字段冲突采用后写入，新增与删除保留另一标签页的无关修改", async ({ page, context }) => {
  const secondPage = await context.newPage();
  await openWorkspace(secondPage);
  await expect(ui(secondPage).composer).toBeVisible();
  await expect(page.locator(".save-state")).toHaveText("已保存");
  await expect(secondPage.locator(".save-state")).toHaveText("已保存");

  let release!: () => void;
  let intercepted!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let held = new Promise<void>((resolve) => { intercepted = resolve; });
  let shouldHold: (delta: { sessions?: { title?: string }[]; removed?: string[] }) => boolean = (delta) => delta.sessions?.some((patch) => patch.title === "local-title") || false;
  let didHold = false;
  await page.route("**/api/workspace/changes", async (route) => {
    const delta = route.request().postDataJSON();
    if (!didHold && route.request().method() === "PATCH" && shouldHold(delta)) {
      didHold = true;
      intercepted();
      await gate;
    }
    await route.continue();
  });
  await page.getByRole("textbox", { name: "会话标题" }).fill("local-title");
  await held;
  await secondPage.getByRole("textbox", { name: "会话标题" }).fill("remote-title");
  await waitForWorkspace(secondPage, (workspace) => workspace.sessions.find((session) => session.id === workspace.active)?.title === "remote-title");
  release();
  await waitForWorkspace(page, (workspace) => workspace.sessions.find((session) => session.id === workspace.active)?.title === "remote-title");

  const workspaceBeforeCreate = await savedWorkspace(secondPage);
  await secondPage.getByRole("button", { name: "新建对话" }).click();
  await waitForWorkspace(secondPage, (workspace) => workspace.sessions.length === 2 && workspace.active !== workspaceBeforeCreate.active);
  await secondPage.getByRole("textbox", { name: "会话标题" }).fill("new-session-to-delete");
  await waitForWorkspace(secondPage, (workspace) => workspace.sessions.length === 2 && workspace.sessions.some((session) => session.title === "new-session-to-delete"));
  const createdId = (await savedWorkspace(secondPage)).sessions.find((session) => session.title === "new-session-to-delete")!.id;
  await page.reload();
  await secondPage.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(ui(secondPage).composer).toBeVisible();

  let releaseDelete!: () => void;
  let deletionHeld!: () => void;
  gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  held = new Promise<void>((resolve) => { deletionHeld = resolve; });
  shouldHold = (delta: { removed?: string[] }) => delta.removed?.includes(createdId) || false;
  didHold = false;
  page.once("dialog", (dialog) => dialog.accept());
  const deleteRow = page.locator(".session-row").filter({ hasText: "new-session-to-delete" });
  await deleteRow.hover();
  await deleteRow.getByRole("button", { name: /删除/ }).click();
  await deletionHeld;
  const originalId = (await savedWorkspace(secondPage)).sessions.find((session) => session.id !== createdId)!.id;
  await secondPage.locator(`.session-row[data-session-id="${originalId}"] .session-main`).click();
  await setSetting(secondPage, "main-model", "parallel-model-update");
  await waitForWorkspace(secondPage, (workspace) => workspace.sessions.find((session) => session.id === originalId)?.settings.model === "parallel-model-update");
  releaseDelete();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === 1 && workspace.sessions[0].id === originalId && workspace.sessions[0].settings.model === "parallel-model-update");
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await page.locator(`.session-row[data-session-id="${originalId}"] .session-main`).click();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("remote-title");
  await expect(page.getByRole("button", { name: /选择模型，当前 parallel-model-update/ })).toBeVisible();
  await secondPage.close();
});

test("WSP-03 刷新清空页面运行记录但保留会话上下文", async ({ page }) => {
  await runWithReply(page, "lifecycle-prompt", "lifecycle-reply");
  await page.locator(".debug-menu summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByText("运行 1")).toBeVisible();
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await page.locator(".debug-menu summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
  await expect(page.getByText("还没有运行记录")).toBeVisible();
  await page.getByRole("button", { name: "关闭调试面板" }).click();
  await expect(page.locator(".message-row").filter({ hasText: "lifecycle-prompt" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "lifecycle-reply" })).toBeVisible();
});

test("WSP-04 导出再导入会话生成独立副本并分配新消息 ID", async ({ page }) => {
  await page.getByRole("textbox", { name: "会话标题" }).fill("export-import-source");
  await runWithReply(page, "exported-prompt", "exported-reply");
  await page.locator(".session-data-menu > summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前会话" }).click();
  const download = await downloadPromise;
  const sourcePath = await download.path();
  expect(sourcePath).toBeTruthy();
  const sourceJson = JSON.parse(await readFile(sourcePath!, "utf8")) as { title: string; settings: { workingDirectory?: string }; messages: { id: string; content: string }[] };
  const sourceIds = sourceJson.messages.map((message) => message.id);
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles(sourcePath!);
  await expect(page.getByText("会话已导入。", { exact: false })).toBeVisible();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === 2);
  const workspace = await savedWorkspace(page);
  const imported = workspace.sessions.find((session) => session.id === workspace.active)!;
  expect(imported.title).toBe("export-import-source");
  expect(imported.messages.map((message) => message.content)).toEqual(expect.arrayContaining(["exported-prompt", "exported-reply"]));
  expect(imported.messages.map((message) => message.id)).not.toEqual(sourceIds);
  expect(imported.settings.workingDirectory).toBeTruthy();
  expect(imported.settings.workingDirectory).not.toBe(sourceJson.settings.workingDirectory);
  expect(imported.runs || []).toHaveLength(0);
});

test("WSP-05 拒绝过大、损坏和结构错误导入且恢复后可再次选择合法文件", async ({ page }) => {
  const file = page.locator('input[type="file"][accept=".json,application/json"]');
  const before = (await savedWorkspace(page)).sessions.length;
  for (const [name, buffer] of [
    ["too-large.json", Buffer.alloc(5_000_001, 32)],
    ["broken.json", Buffer.from("{broken")],
    ["wrong-shape.json", Buffer.from(JSON.stringify({ title: "bad", messages: [] }))],
  ] as const) {
    await file.setInputFiles({ name, mimeType: "application/json", buffer });
    await expect(page.getByText(/导入失败：/)).toBeVisible();
    expect((await savedWorkspace(page)).sessions).toHaveLength(before);
  }
  const valid = Buffer.from(JSON.stringify({ version: 1, title: "valid-import", settings: (await savedWorkspace(page)).sessions[0].settings, messages: [{ id: "old-id", role: "user", content: "valid-content", enabled: true }] }));
  await file.setInputFiles({ name: "valid.json", mimeType: "application/json", buffer: valid });
  await expect(page.getByText("会话已导入。", { exact: false })).toBeVisible();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === before + 1);
  await file.setInputFiles({ name: "valid.json", mimeType: "application/json", buffer: valid });
  await expect(page.getByText("会话已导入。", { exact: false })).toBeVisible();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === before + 2);
});

test("WSP-06 Composer 模型与浏览器偏好刷新后恢复，设置面板与工具开关不可见", async ({ page }) => {
  const bodies: string[] = [];
  await page.route("**/api/workspace/changes", async (route) => {
    const body = route.request().postData() || "";
    bodies.push(body);
    await route.continue();
  });
  await setSetting(page, "main-model", "composer-persisted-model");
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.getByRole("button", { name: "展开工具" }).click();
  await waitForWorkspace(page, (workspace) => workspace.sessions[0]?.settings.model === "composer-persisted-model");
  expect(bodies.join("\n")).not.toContain("toolMode");
  const locals = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(locals).not.toContain("API Key");
  await expect.poll(() => page.evaluate(() => ({ theme: localStorage.getItem("pilab-theme-v2"), compact: localStorage.getItem("pilab-tools-compact-v1") }))).toEqual({ theme: "dark", compact: "false" });

  await page.locator(".session-data-menu > summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前会话" }).click();
  const download = await downloadPromise;
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).not.toContain("toolMode");
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(page.getByRole("button", { name: /选择模型，当前 composer-persisted-model/ })).toBeVisible();
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /显示工作台|隐藏工作台/ })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "收起工具" })).toBeVisible();
});

test("PI-01 模型选择器显示 Pi 连接状态且不会暴露凭据", async ({ page }) => {
  let state: "connected" | "disconnected" | "error" = "connected";
  await page.route("**/api/pi-status", async (route) => {
    if (state === "error") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock status unavailable", connected: false, token: "e2e-secret-token" }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ connected: state === "connected", provider: "mock", defaultModel: "mock/model", models: state === "connected" ? [{ id: "mock/model", name: "Mock Model", reasoningEfforts: ["low"] }] : [], token: "e2e-secret-token" }) });
  });
  await page.reload();
  await page.getByRole("button", { name: /选择模型/ }).click();
  const picker = page.getByRole("dialog", { name: "选择模型" });
  await expect(picker).toContainText("1 个可用模型");
  state = "disconnected";
  await picker.getByRole("button", { name: "刷新模型目录" }).click();
  await expect(picker).toContainText("Pi 未连接");
  state = "error";
  await picker.getByRole("button", { name: "刷新模型目录" }).click();
  await expect(page.locator(".toast")).toContainText("暂时无法读取 Pi 登录状态");
  await expect(page.locator("body")).not.toContainText("e2e-secret-token");
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain("e2e-secret-token");
});
