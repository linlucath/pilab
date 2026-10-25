import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

type Worker = {
  id: string; name: string; role: string; status: string; model: string; updatedAt: number;
  hasUnreadReply: boolean; pendingQuestionCount: number;
  recentTools: { name: string; status: "running" | "completed" | "error"; at: number }[];
  lastReplyPreview: string;
};

const worker = (name: string, status: string, overrides: Partial<Worker> = {}): Worker => ({
  id: name, name, role: "implementer", status, model: "codex-mock", updatedAt: Date.now(),
  hasUnreadReply: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: `${name} preview`, ...overrides,
});
async function prepare(page: Page) {
  await resetWorkspace(page);
  await openWorkspace(page);
  await expect(ui(page).composer).toBeVisible();
}
async function mockWorkerList(page: Page, getWorkers: () => Worker[]) {
  await page.route(/\/api\/gpt-sessions\?/, async (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ sessions: getWorkers() }),
  }));
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
}
async function advancedSettings(page: Page) {
  if (await page.locator("#protocol").count() === 0) await page.getByRole("button", { name: /高级设置与调试/ }).click();
}

test.beforeEach(async ({ page }) => prepare(page));

test("GPT-01 活动与历史工兵可查看，清理需确认且排除运行中会话", async ({ page }) => {
  let workers = [worker("running-worker", "running"), ...Array.from({ length: 6 }, (_, index) => worker(`idle-${index}`, "idle", { hasUnreadReply: index === 0, recentTools: index === 0 ? [{ name: "read_file", status: "completed", at: Date.now() }] : [] }))];
  let cleanupCalls = 0;
  await mockWorkerList(page, () => workers);
  await expect(page.locator(".active-worker-card")).toContainText("running-worker");
  await expect(page.locator(".worker-history-item")).toHaveCount(5);
  await page.getByRole("button", { name: "查看全部 (6)" }).click();
  await expect(page.locator(".worker-history-item")).toHaveCount(6);
  const firstHistory = page.locator(".worker-history-row").filter({ hasText: "idle-0" });
  await firstHistory.click();
  await expect(page.locator(".worker-history-item").filter({ hasText: "idle-0" }).locator(".worker-reply-preview")).toContainText("idle-0 preview");

  await page.route("**/api/gpt-sessions/cleanup", async (route) => {
    cleanupCalls++;
    const closed = workers.filter((item) => item.status !== "running").map((item) => item.name);
    workers = workers.filter((item) => item.status === "running");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ closed, failures: [], sessions: workers }) });
  });
  const cleanup = page.getByRole("button", { name: /清理空闲/ });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("idle-0");
    expect(dialog.message()).not.toContain("running-worker");
    await dialog.dismiss();
  });
  await cleanup.click();
  expect(cleanupCalls).toBe(0);
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await cleanup.click();
  await expect(page.getByText(/已清理 6 个非运行态工兵会话/)).toBeVisible();
  expect(cleanupCalls).toBe(1);
  await expect(page.locator(".active-worker-card")).toContainText("running-worker");
  await expect(page.locator(".worker-history-item")).toHaveCount(0);
});

test("GPT-02 工兵状态轮询自动更新，活动工具可见且原始参数不泄露", async ({ page }) => {
  let current = worker("live-worker", "starting");
  await mockWorkerList(page, () => [current]);
  await expect(page.locator(".active-worker-card")).toContainText("启动中");
  current = worker("live-worker", "waiting_input", {
    pendingQuestionCount: 1,
    recentTools: [{ name: "read_file", status: "running", at: Date.now() }],
    lastReplyPreview: "safe reply preview",
  });
  await expect(page.locator(".active-worker-card")).toContainText("等待输入", { timeout: 7_000 });
  await expect(page.locator(".active-worker-card")).toContainText("read_file");
  await expect(page.locator(".active-worker-card")).toContainText("等待你回答 1 个问题");
  await expect(page.locator(".worker-reply-preview")).toHaveText("safe reply preview");
  await expect(page.locator(".active-worker-card")).not.toContainText("SECRET_RAW_ARGUMENT");
  await expect(page.locator(".background-task-bar")).toContainText("等待输入");
});

test("GPT-03 中断与关闭保留工兵历史且操作反馈对应状态", async ({ page }) => {
  let current = worker("resume-me", "running", { hasUnreadReply: true });
  await mockWorkerList(page, () => [current]);
  await page.route("**/api/gpt-sessions/interrupt", async (route) => {
    current = { ...current, status: "interrupted", updatedAt: Date.now() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: current }) });
  });
  await page.route("**/api/gpt-sessions/close", async (route) => {
    current = { ...current, status: "closed", updatedAt: Date.now() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: current }) });
  });
  await page.locator(".active-worker-card").getByRole("button", { name: "中断工兵" }).click();
  await page.locator(".worker-history-row").click();
  await expect(page.locator(".worker-history-item")).toContainText("已中断");
  await page.locator(".worker-history-item").getByRole("button", { name: "关闭会话" }).click();
  await expect(page.locator(".worker-history-item")).toContainText("已关闭");
  await expect(page.locator(".worker-history-item")).toContainText("resume-me");
});

test("GPT-04 有草稿时自动唤醒退让，人工审阅不覆盖草稿；取消唤醒不停止工兵", async ({ page }) => {
  let workers = [worker("manual-review", "running")];
  await mockWorkerList(page, () => workers);
  const autoWake = page.getByRole("checkbox", { name: /工兵交卷自动唤醒/ });
  await autoWake.check();
  await ui(page).composer.fill("keep-this-user-draft");
  const runPayloads: { messages: { content: string }[] }[] = [];
  await page.route("**/api/run", async (route) => {
    if (route.request().method() === "POST") runPayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await setMockScript(page, [{ type: "text", text: "manual-review-complete" }]);
  workers = [worker("manual-review", "idle", { hasUnreadReply: true, lastReplyPreview: "delivered report" })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("当前有运行/输入");
  await expect(ui(page).composer).toHaveValue("keep-this-user-draft");
  await page.waitForTimeout(1_700);
  expect(runPayloads).toHaveLength(0);
  await page.getByRole("button", { name: /让 Gemini 审阅汇报/ }).click();
  await expect(page.getByText("manual-review-complete", { exact: true })).toBeVisible();
  expect(runPayloads).toHaveLength(1);
  expect(runPayloads[0].messages.some((message) => message.content.includes("gpt_session_read"))).toBe(true);
  await expect(ui(page).composer).toHaveValue("keep-this-user-draft");

  // A second delivery with an empty composer can be cancelled before the 1.5s automatic wake.
  workers = [worker("manual-review", "idle", { hasUnreadReply: true })];
  await ui(page).composer.fill("");
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  workers = [...workers, worker("cancel-wake", "running")];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  workers = [...workers.filter((item) => item.name !== "cancel-wake"), worker("cancel-wake", "idle", { hasUnreadReply: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("自动唤醒 Gemini");
  await page.getByRole("button", { name: "取消自动唤醒" }).click();
  await page.waitForTimeout(1_700);
  expect(runPayloads).toHaveLength(1);
  expect(workers.some((item) => item.name === "cancel-wake")).toBe(true);
});

test("E2E-01 从提示消息分支并运行后，两个分支内容和回复互不覆盖", async ({ page }) => {
  await setMockScript(page, [{ type: "text", text: "SOURCE-REPLY" }]);
  await sendMessage(page, "SOURCE-PROMPT");
  await expect(page.getByText("SOURCE-REPLY", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const data = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
    return data.workspace.sessions.find((item: { id: string }) => item.id === data.workspace.active)?.messages.some((message: { content: string }) => message.content === "SOURCE-PROMPT");
  }).toBe(true);
  const sourceWorkspace = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
  const source = sourceWorkspace.workspace.sessions.find((item: { id: string }) => item.id === sourceWorkspace.workspace.active);
  const sourcePrompt = source.messages.find((message: { content: string }) => message.content === "SOURCE-PROMPT");
  const sourceRow = page.locator(`.message-row[data-message-id="${sourcePrompt.id}"]`);
  await sourceRow.getByRole("button", { name: "从此处分支" }).focus();
  await sourceRow.getByRole("button", { name: "从此处分支" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "会话标题" })).toHaveValue(/分支/);
  const branchPrompt = page.locator(`.message-row[data-message-id="${sourcePrompt.id}"]`);
  await branchPrompt.hover();
  await branchPrompt.getByRole("button", { name: "编辑消息" }).focus();
  await branchPrompt.getByRole("button", { name: "编辑消息" }).press("Enter");
  await branchPrompt.getByRole("textbox", { name: /编辑/ }).fill("BRANCH-PROMPT");
  await branchPrompt.getByRole("button", { name: "保存消息" }).click();
  await setMockScript(page, [{ type: "text", text: "BRANCH-REPLY" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("BRANCH-REPLY", { exact: true })).toBeVisible();
  await expect(page.locator(".session-row").filter({ hasText: "新建对话 · 分支" })).toBeVisible();
  await expect.poll(async () => {
    const data = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
    const branch = data.workspace.sessions.find((item: { title: string }) => item.title === "新建对话 · 分支");
    return data.workspace.sessions.length === 2 && branch?.messages.some((message: { content: string }) => message.content === "BRANCH-PROMPT") && branch.messages.some((message: { content: string }) => message.content === "BRANCH-REPLY");
  }).toBe(true);
  const sessions = (await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json())).workspace.sessions;
  expect(sessions).toHaveLength(2);
  const branched = sessions.find((item: { id: string }) => item.id !== source.id);
  expect(branched.messages.some((message: { content: string }) => message.content === "BRANCH-PROMPT")).toBe(true);
  expect(branched.messages.some((message: { content: string }) => message.content === "BRANCH-REPLY")).toBe(true);
  expect(branched.runs).toBeUndefined();
  await page.locator(`button.session-main[title="${source.title}"]`).click();
  await expect(page.locator(".message-row").filter({ hasText: "SOURCE-PROMPT" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "SOURCE-REPLY" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "BRANCH-PROMPT" })).toHaveCount(0);
});

test("E2E-02 协议角色错误先被拒绝，修正后原上下文可再次运行", async ({ page }) => {
  await advancedSettings(page);
  await page.locator("#protocol").selectOption("anthropic-messages");
  await page.getByRole("button", { name: "展开 / 编辑" }).click();
  await page.getByRole("button", { name: "添加 Developer" }).click();
  await ui(page).composer.fill("E2E-02-user");
  await page.getByRole("button", { name: "仅添加" }).click();
  const payloads: { messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/run", async (route) => {
    if (route.request().method() === "POST") payloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByRole("alert")).toContainText(/Anthropic|Developer/i);
  expect(payloads).toHaveLength(1);
  expect(payloads[0].messages.map((message) => message.role)).toEqual(["system", "developer", "user"]);
  await expect(page.locator(".message-row").filter({ hasText: "E2E-02-user" })).toBeVisible();

  await page.getByRole("button", { name: "删除人设消息" }).nth(1).click();  await setMockScript(page, [{ type: "text", text: "E2E-02-FIXED" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("E2E-02-FIXED", { exact: true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1].messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(payloads[1].messages.at(-1)?.content).toBe("E2E-02-user");
  await page.locator(".debug-menu summary").click();
  await page.getByRole("button", { name: "请求检查" }).click();
  await expect(page.getByRole("dialog")).toContainText("E2E-02-user");
});
