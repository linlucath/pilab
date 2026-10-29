import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

type PersistedSession = { id: string; title: string; messages: { id: string; role: string; content: string; enabled: boolean; toolCalls?: { id: string }[]; toolCallId?: string }[]; settings: Record<string, unknown>; runs?: unknown[]; parentSessionId?: string; parentSessionTitle?: string };
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
  const input = page.locator(`#${id}`);
  if (await input.getAttribute("type") === "number") await input.fill(value);
  else await input.fill(value);
}
async function advancedSettings(page: Page) {
  const toggle = page.getByRole("button", { name: /高级设置与调试/ });
  if (await page.locator("#protocol").count() === 0) await toggle.click();
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
  await advancedSettings(page);
  await setSetting(page, "max-tokens", "777");
  await runWithReply(page, "prompt-persisted", "reply-persisted");
  await waitForWorkspace(page, (workspace) => {
    const active = workspace.sessions.find((session) => session.id === workspace.active);
    return active?.title === "refresh-persist-title" && active.settings.model === "e2e-model-persisted" && active.settings.maxTokens === 777 && active.messages.some((message) => message.content === "reply-persisted");
  });
  const source = (await savedWorkspace(page)).sessions.find((session) => session.title === "refresh-persist-title")!;

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "提纯分身" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".session-fork-modal textarea").fill("persisted branch memory");
  await page.getByLabel("新分身名称").fill("persisted-child");
  await page.getByRole("button", { name: "即刻创建并切换" }).click();
  await waitForWorkspace(page, (workspace) => workspace.sessions.some((session) => session.title === "persisted-child"));
  await page.locator(`.session-row[data-session-id="${source.id}"] .session-main`).click();
  await page.getByRole("button", { name: "Agent" }).click();
  await waitForWorkspace(page, (workspace) => workspace.sessions.find((session) => session.id === source.id)?.settings.toolMode === "agent");
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.getByRole("textbox", { name: "会话标题" }).fill("secondary-session");
  await waitForWorkspace(page, (workspace) => workspace.sessions.some((session) => session.title === "secondary-session"));

  const piSummary = {
    id: "e2e-pi-session", sessionId: "e2e-native-session", name: "pi-refresh-fixture", cwd: "/tmp/pi-fixture",
    model: null, thinking: "medium", revision: "revision-1", busy: false, online: true, heartbeat: Date.now(),
    activityAt: Date.now(), applied: false, requestCount: 0, lastAppliedRequest: 0,
  };
  const piDetail = { ...piSummary, messages: [
    { id: "pi-system-message", role: "system", content: "native-system", enabled: true },
    { id: "pi-user-message", role: "user", content: "native-user", enabled: true },
  ] };
  await page.route("**/api/pi-sync", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ installed: true, sessions: [piSummary] }) }));
  await page.route("**/api/pi-sync/e2e-pi-session", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(piDetail) }));
  await page.route("**/api/pi-sync/e2e-pi-session/events", (route) => route.fulfill({
    status: 200, headers: { "Content-Type": "text/event-stream" }, body: `event: snapshot\ndata: ${JSON.stringify(piDetail)}\n\n`,
  }));
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await page.locator(".pi-sync-menu summary").click();
  await page.getByLabel("选择 Pi CLI 会话").selectOption("e2e-pi-session");
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("pi-refresh-fixture");
  page.once("dialog", (dialog) => dialog.accept());
  const piSessionRow = page.locator(".session-row").filter({ hasText: "pi-refresh-fixture" });
  await piSessionRow.hover();
  await piSessionRow.getByRole("button", { name: "删除 pi-refresh-fixture" }).click();
  await waitForWorkspace(page, (workspace) => workspace.hiddenPiSessions.includes("e2e-native-session") && workspace.sessions.length === 3);

  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("refresh-persist-title");
  await expect(page.locator("#main-model")).toHaveValue("e2e-model-persisted");
  await advancedSettings(page);
  await expect(page.locator("#max-tokens")).toHaveValue("777");
  await expect(page.locator(".message-row").filter({ hasText: "prompt-persisted" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "reply-persisted" })).toBeVisible();
  const reloaded = await savedWorkspace(page);
  const branch = reloaded.sessions.find((session) => session.title === "persisted-child");
  expect(reloaded.sessions).toHaveLength(3);
  expect(branch?.parentSessionId).toBe(source.id);
  expect(branch?.parentSessionTitle).toBe("refresh-persist-title");
  expect(reloaded.hiddenPiSessions).toContain("e2e-native-session");
  expect(reloaded.sessions.some((session) => session.title === "secondary-session")).toBe(true);
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
  expect((await savedWorkspace(page)).sessions[0].title).not.toBe("retry-after-save-error");
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

  await secondPage.getByRole("button", { name: "新建对话" }).click();
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
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue("remote-title");
  await expect(page.locator("#main-model")).toHaveValue("parallel-model-update");
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
  await advancedSettings(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出会话 JSON" }).click();
  const download = await downloadPromise;
  const sourcePath = await download.path();
  expect(sourcePath).toBeTruthy();
  const sourceJson = JSON.parse(await readFile(sourcePath!, "utf8")) as { title: string; messages: { id: string; content: string }[] };
  const sourceIds = sourceJson.messages.map((message) => message.id);
  await page.locator('input[type="file"]').setInputFiles(sourcePath!);
  await expect(page.getByText("会话已导入。", { exact: false })).toBeVisible();
  await waitForWorkspace(page, (workspace) => workspace.sessions.length === 2);
  const workspace = await savedWorkspace(page);
  const imported = workspace.sessions.find((session) => session.id === workspace.active)!;
  expect(imported.title).toBe("export-import-source");
  expect(imported.messages.map((message) => message.content)).toEqual(expect.arrayContaining(["exported-prompt", "exported-reply"]));
  expect(imported.messages.map((message) => message.id)).not.toEqual(sourceIds);
  expect(imported.settings.apiKey ?? "").toBe("");
  expect(imported.runs || []).toHaveLength(0);
});

test("WSP-05 拒绝过大、损坏和结构错误导入且恢复后可再次选择合法文件", async ({ page }) => {
  await advancedSettings(page);
  const file = page.locator('input[type="file"]');
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

test("WSP-06 页面 API Key 不落盘，浏览器偏好刷新后恢复", async ({ page }) => {
  const bodies: string[] = [];
  await page.route("**/api/workspace/changes", async (route) => {
    const body = route.request().postData() || "";
    bodies.push(body);
    await route.continue();
  });
  await advancedSettings(page);
  await page.locator("#protocol").selectOption("openai-completions");
  const secret = "page-only-key-4f7d";
  await page.locator("#api-key").fill(secret);
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.getByRole("button", { name: "展开工具" }).click();
  await waitForWorkspace(page, (workspace) => workspace.sessions[0]?.settings.protocol === "openai-completions");
  expect(bodies.join("\n")).not.toContain(secret);
  const locals = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(locals).not.toContain(secret);
  await expect.poll(() => page.evaluate(() => ({ theme: localStorage.getItem("pilab-theme-v2"), compact: localStorage.getItem("pilab-tools-compact-v1") }))).toEqual({ theme: "dark", compact: "false" });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出会话 JSON" }).click();
  const download = await downloadPromise;
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).not.toContain(secret);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
  await advancedSettings(page);
  await expect(page.locator("#api-key")).toHaveValue("");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "收起工具" })).toBeVisible();
});

test("PI-01 登录状态区分已连接、未登录和状态读取失败且不显示 Token", async ({ page }) => {
  let state: "connected" | "disconnected" | "error" = "connected";
  await page.route("**/api/pi-status", async (route) => {
    if (state === "error") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock status unavailable", connected: false, token: "e2e-secret-token" }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ connected: state === "connected", provider: "mock", models: [], token: "e2e-secret-token" }) });
  });
  await page.reload();
  await expect(page.getByText("Pi 登录已连接", { exact: true })).toBeVisible();
  state = "disconnected";
  await page.getByRole("button", { name: "刷新 Pi 登录状态" }).click();
  await expect(page.getByText("Pi 尚未登录", { exact: true })).toBeVisible();
  state = "error";
  await page.getByRole("button", { name: "刷新 Pi 登录状态" }).click();
  await expect(page.getByText("暂时无法读取 Pi 登录状态。", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("e2e-secret-token");
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain("e2e-secret-token");
});

test("PI-03 标准接口运行保留消息角色和原始顺序，供应商错误可见", async ({ page }) => {
  const payloads: { messages: { role: string; content: string; toolCalls?: unknown[]; toolCallId?: string }[]; settings: { protocol: string } }[] = [];
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") payloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await advancedSettings(page);
  await page.locator("#protocol").selectOption("openai-completions");
  await page.getByRole("button", { name: "展开 / 编辑" }).click();
  await page.getByRole("button", { name: "添加 Developer" }).click();
  const developer = page.getByRole("textbox", { name: "撰写新消息" });
  await developer.fill("user-after-developer");
  await page.getByRole("button", { name: "仅添加" }).click();
  await setMockScript(page, [{ type: "text", text: "ROLE-PRESERVED" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("ROLE-PRESERVED", { exact: true })).toBeVisible();
  expect(payloads[0].messages.map((message) => message.role)).toEqual(["system", "developer", "user"]);
  expect(payloads[0].messages.at(-1)?.content).toBe("user-after-developer");

  await setMockScript(page, [{ type: "tool", input: "protocol-tool" }, { type: "text", text: "after-tool" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("after-tool", { exact: true })).toBeVisible();
  await waitForWorkspace(page, (workspace) => {
    const messages = workspace.sessions.find((session) => session.id === workspace.active)?.messages;
    return !!messages?.some((message) => message.role === "assistant" && message.toolCalls?.length) && messages.some((message) => message.role === "tool");
  });
  await setMockScript(page, [{ type: "text", text: "tool-history-replay" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("tool-history-replay", { exact: true })).toBeVisible();
  expect(payloads[2].messages.some((message) => message.role === "assistant" && message.toolCalls?.length)).toBe(true);
  expect(payloads[2].messages.some((message) => message.role === "tool" && message.toolCallId)).toBe(true);

  await page.locator("#protocol").selectOption("openai-responses");
  await setMockScript(page, [{ type: "text", text: "responses-protocol-ok" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("responses-protocol-ok", { exact: true })).toBeVisible();
  expect(payloads[3].settings.protocol).toBe("openai-responses");
  expect(payloads[3].messages[0].role).toBe("system");
  expect(payloads[3].messages.some((message) => message.role === "tool")).toBe(true);

  await page.locator("#protocol").selectOption("anthropic-messages");
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByRole("alert")).toContainText(/Developer|Anthropic/i);
  expect(payloads).toHaveLength(5);
  const finalRoles = payloads[4].messages.map((message) => message.role);
  expect(finalRoles[0]).toBe("system");
  expect(finalRoles).toContain("developer");
  expect(finalRoles).toContain("user");
  expect(finalRoles.indexOf("developer")).toBeLessThan(finalRoles.indexOf("user"));
});
