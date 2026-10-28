import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, seedWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

type Worker = {
  id: string; name: string; role: string; status: string; model: string; updatedAt: number; replySequence?: number;
  hasUnreadReply: boolean; hasActiveWaiter?: boolean; pendingQuestionCount: number;
  recentTools: { name: string; status: "running" | "completed" | "error"; at: number }[];
  lastReplyPreview: string;
};

const worker = (name: string, status: string, overrides: Partial<Worker> = {}): Worker => ({
  id: name, name, role: "implementer", status, model: "codex-mock", updatedAt: Date.now(),
  hasUnreadReply: false, hasActiveWaiter: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: `${name} preview`, ...overrides,
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

  await page.route("**/api/run", async (route) => {
    current = { ...current, status: "idle", updatedAt: Date.now() };
    const call = { id: "resume-call", name: "gpt_session_send", arguments: JSON.stringify({ name: "resume-me", message: "continue prior task" }) };
    const events = [
      { type: "assistant_start", id: "resume-tool-message" },
      { type: "assistant", message: { id: "resume-tool-message", role: "assistant", content: "", enabled: true, toolCalls: [call] } },
      { type: "message", message: { id: "resume-tool-result", role: "tool", content: "Existing GPT session resumed", enabled: true, toolCallId: call.id, toolName: call.name } },
      { type: "assistant", message: { id: "resume-final", role: "assistant", content: "GPT-03 resumed existing worker", enabled: true } },
      { type: "done", reason: "stop", turns: 1, usage: { input: 1, output: 1 } },
    ];
    await route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
  });
  await sendMessage(page, "continue the existing worker resume-me");
  await expect(page.getByText("GPT-03 resumed existing worker", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
    const messages = saved.workspace.sessions.find((session: { id: string }) => session.id === saved.workspace.active).messages;
    return messages.some((message: { toolCalls?: { name: string; arguments: string }[] }) => message.toolCalls?.some((item) => item.name === "gpt_session_send" && item.arguments.includes("resume-me")));
  }).toBe(true);
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-history-item")).toContainText("空闲");
});

test("GPT-04 交卷提醒只是 UI 状态，草稿保留且只有手动点击才运行", async ({ page }) => {
  const dispatch = { id: "wake-call", name: "gpt_session_create", arguments: JSON.stringify({ name: "manual-review", message: "background task" }) };
  await seedWorkspace(page, [{ id: "wake-owner", title: "工兵唤醒会话", messages: [
    { id: "wake-system", role: "system", content: "system", enabled: true },
    { id: "wake-dispatch", role: "assistant", content: "", enabled: true, toolCalls: [dispatch] },
    { id: "wake-result", role: "tool", content: "started", enabled: true, toolCallId: dispatch.id, toolName: dispatch.name },
  ] }], "wake-owner");
  await openWorkspace(page);
  let workers = [worker("manual-review", "running")];
  await mockWorkerList(page, () => workers);
  const runPayloads: { messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/run", async (route) => {
    runPayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await ui(page).composer.fill("keep-this-user-draft");
  workers = [worker("manual-review", "idle", { hasUnreadReply: true, lastReplyPreview: "delivered report" })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("审阅不会清除输入草稿");
  await expect(ui(page).composer).toHaveValue("keep-this-user-draft");
  await page.waitForTimeout(1_700);
  expect(runPayloads).toHaveLength(0);
  await expect(page.getByRole("button", { name: /工兵交卷自动唤醒/ })).toHaveCount(0);
});

test("GPT-04 主模型运行时不排队唤醒；运行结束后再次手动点击才审阅", async ({ page }) => {
  const dispatch = { id: "busy-wake-call", name: "gpt_session_create", arguments: JSON.stringify({ name: "busy-review", message: "background task" }) };
  await seedWorkspace(page, [{ id: "busy-owner", title: "忙碌中的工兵", messages: [
    { id: "busy-system", role: "system", content: "system", enabled: true },
    { id: "busy-dispatch", role: "assistant", content: "", enabled: true, toolCalls: [dispatch] },
    { id: "busy-result", role: "tool", content: "started", enabled: true, toolCallId: dispatch.id, toolName: dispatch.name },
  ] }], "busy-owner");
  await openWorkspace(page);
  let workers = [worker("busy-review", "running")];
  await mockWorkerList(page, () => workers);
  let releaseFirstRun!: () => void;
  const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  const runPayloads: { messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/run", async (route) => {
    runPayloads.push(route.request().postDataJSON());
    if (runPayloads.length === 1) await firstRunGate;
    const text = runPayloads.length === 1 ? "main-run-finished" : "manual-review-finished";
    const events = [
      { type: "assistant_start", id: `busy-run-${runPayloads.length}` },
      { type: "assistant", message: { id: `busy-run-${runPayloads.length}`, role: "assistant", content: text, enabled: true } },
      { type: "done", reason: "stop", turns: 1, usage: { input: 1, output: 1 } },
    ];
    await route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
  });

  await sendMessage(page, "keep the main model busy");
  await expect(page.locator(".composer-running")).toBeVisible();
  workers = [worker("busy-review", "idle", { hasUnreadReply: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("主模型运行中");
  await expect(page.getByRole("button", { name: /让 Gemini 审阅汇报/ })).toBeDisabled();
  await page.waitForTimeout(1_700);
  expect(runPayloads).toHaveLength(1);
  expect(runPayloads[0].messages.some((message) => message.content.includes("后台 GPT 工兵已交卷"))).toBe(false);
  releaseFirstRun();
  await expect(page.getByText("main-run-finished", { exact: true })).toBeVisible();
  await expect(page.locator(".composer-running")).toHaveCount(0);
  expect(runPayloads, "finishing the main run must not drain a queued worker review").toHaveLength(1);

  await page.getByRole("button", { name: /让 Gemini 审阅汇报/ }).click();
  await expect(page.getByText("manual-review-finished", { exact: true })).toBeVisible();
  expect(runPayloads).toHaveLength(2);
  expect(runPayloads[1].messages.some((message) => message.role === "user" && message.content.includes("后台 GPT 工兵已交卷"))).toBe(true);
});

test("GPT-04 已读回复或 waitAndReport 接管时不提醒，忽略提醒不停止工兵", async ({ page }) => {
  const dispatch = { id: "claimed-call", name: "gpt_session_create", arguments: JSON.stringify({ name: "claimed-worker", message: "background task" }) };
  await seedWorkspace(page, [{ id: "claimed-owner", title: "被等待的工兵", messages: [
    { id: "claimed-system", role: "system", content: "system", enabled: true },
    { id: "claimed-dispatch", role: "assistant", content: "", enabled: true, toolCalls: [dispatch] },
    { id: "claimed-result", role: "tool", content: "started", enabled: true, toolCallId: dispatch.id, toolName: dispatch.name },
  ] }], "claimed-owner");
  await openWorkspace(page);
  let workers = [worker("claimed-worker", "running")];
  await mockWorkerList(page, () => workers);
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: true, hasActiveWaiter: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("claimed-worker");
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: true, hasActiveWaiter: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: false })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toContainText("claimed-worker");
  await page.getByRole("button", { name: "忽略工兵交卷提醒" }).click();
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: false })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  workers = [worker("claimed-worker", "idle", { hasUnreadReply: true })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  expect(workers[0].status).toBe("idle");
});

test("GPT-04 工兵交卷系统消息可从消息流直接删除", async ({ page }) => {
  const notice = "后台 GPT 工兵已交卷：「dismiss-worker」。请使用 gpt_session_read 读取这些工兵的新回复，核对完成情况；如有失败、问题或待决策事项，请明确指出。";
  await seedWorkspace(page, [{ id: "dismiss-session", title: "可删除通知", messages: [
    { id: "dismiss-system", role: "system", content: "system", enabled: true },
    { id: "dismiss-notice", role: "user", content: notice, enabled: true },
  ] }], "dismiss-session");
  await openWorkspace(page);
  const card = page.locator(".system-worker-wake-notice");
  await expect(card).toContainText("dismiss-worker");
  await card.getByRole("button", { name: "删除工兵交卷通知" }).click();
  await expect(card).toHaveCount(0);
});

test("GPT-04 工兵交卷只唤醒派出会话，删除后同一回复签名不再复活", async ({ page }) => {
  const dispatch = { id: "owned-call", name: "gpt_session_create", arguments: JSON.stringify({ name: "owned-worker", message: "do owned work" }) };
  await seedWorkspace(page, [
    { id: "unrelated-session", title: "当前会话", messages: [{ id: "unrelated-system", role: "system", content: "system", enabled: true }] },
    { id: "owning-session", title: "派出会话", messages: [
      { id: "owner-system", role: "system", content: "system", enabled: true },
      { id: "owner-dispatch", role: "assistant", content: "", enabled: true, toolCalls: [dispatch] },
      { id: "owner-result", role: "tool", content: "started", enabled: true, toolCallId: dispatch.id, toolName: dispatch.name },
    ] },
  ], "unrelated-session");
  await openWorkspace(page);

  const replySequence = 7;
  const replyAt = Date.now();
  let workers = [
    worker("owned-worker", "running", { replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "running", { replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await mockWorkerList(page, () => workers);
  workers = [
    worker("owned-worker", "running", { hasUnreadReply: true, replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "running", { hasUnreadReply: true, replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [
    worker("owned-worker", "idle", { hasUnreadReply: true, replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "idle", { hasUnreadReply: true, replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);

  await page.locator('[data-session-id="owning-session"] .session-main').click();
  await expect(page.locator(".worker-wake-banner")).toContainText("owned-worker");
  await expect(page.locator(".worker-wake-banner")).not.toContainText("unowned-worker");
  await setMockScript(page, [{ type: "text", text: "OWNED-WORKER-REVIEWED" }]);
  await page.getByRole("button", { name: /让 Gemini 审阅汇报/ }).click();
  await expect(page.getByText("OWNED-WORKER-REVIEWED", { exact: true })).toBeVisible();
  await expect(page.locator(".composer-running")).toHaveCount(0);
  const wakeCard = page.locator(".system-worker-wake-notice");
  await expect(wakeCard).toContainText("owned-worker");
  await wakeCard.getByRole("button", { name: "删除工兵交卷通知" }).click();
  await expect(wakeCard).toHaveCount(0);

  // The same unread reply can reappear in polling data (for example after a cwd/session refresh).
  // Its stable worker/reply signature must not create another wake after processing/dismissal.
  workers = [worker("owned-worker", "idle", { hasUnreadReply: false, replySequence, updatedAt: replyAt })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  workers = [worker("owned-worker", "idle", { hasUnreadReply: true, replySequence, updatedAt: replyAt })];
  await page.getByRole("button", { name: "刷新 GPT 会话" }).click();
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  await expect(page.locator(".system-worker-wake-notice")).toHaveCount(0);

  const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
  const unrelated = saved.workspace.sessions.find((item: { id: string }) => item.id === "unrelated-session");
  const owner = saved.workspace.sessions.find((item: { id: string }) => item.id === "owning-session");
  expect(unrelated.messages.some((message: { content: string }) => message.content.includes("后台 GPT 工兵已交卷"))).toBe(false);
  expect(owner.messages.some((message: { content: string }) => message.content.includes("后台 GPT 工兵已交卷"))).toBe(false);
  await expect.poll(async () => {
    const latest = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
    return latest.workspace.sessions.find((item: { id: string }) => item.id === "owning-session")?.reviewedWorkerSignatures?.length || 0;
  }).toBe(1);
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
