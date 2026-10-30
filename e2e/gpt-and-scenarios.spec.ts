import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, seedWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

type Worker = {
  id: string; name: string; role: string; status: string; model: string; updatedAt: number; replySequence?: number; ownerSessionId?: string;
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
  const data = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
  const ownerSessionId = data.workspace.active as string;
  let listed = false;
  await page.route(/\/api\/gpt-sessions\?/, async (route) => {
    const sessions = getWorkers();
    for (const item of sessions) item.ownerSessionId ||= ownerSessionId;
    listed = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) });
  });
  await page.route("**/api/gpt-sessions/*/messages?*", async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) || "");
    const current = getWorkers().find((item) => item.name === name);
    const messages = [
      { id: `system-${name}`, role: "system", content: `System instructions for ${name}`, enabled: true },
      ...(current?.lastReplyPreview ? [{ id: `reply-${name}`, role: "assistant", content: current.lastReplyPreview, enabled: true }] : []),
    ];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: current, messages }) });
  });
  await page.route("**/api/gpt-sessions/*/transcript?*", async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) || "");
    const current = getWorkers().find((item) => item.name === name);
    const events = [
      ...(current?.lastReplyPreview ? [{ sequence: 1, at: Date.now(), type: "assistant", text: current.lastReplyPreview }] : []),
      ...(current?.recentTools || []).map((tool, index) => ({ sequence: index + 2, at: tool.at, type: tool.status === "running" ? "tool_start" : "tool_end", text: "{\\\"private\\\":\\\"SECRET_RAW_ARGUMENT\\\"}", toolName: tool.name })),
    ];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ events, hasMore: false }) });
  });
  await expect.poll(() => listed).toBe(true);
}
async function waitForWorkerListUpdate(page: Page) {
  const isListResponse = (response: import("@playwright/test").Response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/gpt-sessions";
  await page.waitForResponse(isListResponse, { timeout: 6_000 });
  // A poll may already be in flight when a test changes its mock snapshot. The next response is guaranteed to observe it.
  await page.waitForResponse(isListResponse, { timeout: 6_000 });
}

test.beforeEach(async ({ page }) => prepare(page));

test("GPT-01 worker names are tabs, worker replies use the shared stream, and closing only hides a tab", async ({ page }) => {
  const workers = [worker("running-worker", "running"), ...Array.from({ length: 6 }, (_, index) => worker(`idle-${index}`, "idle", { hasUnreadReply: index === 0 }))];
  let interruptCalls = 0;
  let closeCalls = 0;
  await mockWorkerList(page, () => workers);
  await page.route("**/api/gpt-sessions/interrupt", async (route) => { interruptCalls++; await route.fulfill({ json: { session: workers[0] } }); });
  await page.route("**/api/gpt-sessions/close", async (route) => { closeCalls++; await route.fulfill({ json: { session: workers[0] } }); });
  await expect(page.locator(".thread-worker-tab")).toHaveCount(7);
  const runningTab = page.locator(".thread-worker-tab").filter({ hasText: "running-worker" });
  await expect(runningTab.locator(".thread-running-dot")).toHaveCount(1);
  await page.locator(".thread-worker-tab").filter({ hasText: "idle-0" }).click();
  await expect(page.locator(".message-stream")).toContainText("idle-0 preview");
  await page.getByRole("button", { name: "关闭工兵标签 idle-0" }).click();
  await expect(page.locator(".thread-worker-tab")).toHaveCount(6);
  await expect(page.getByRole("tab", { name: "💬 主会话 (Gemini)" })).toHaveAttribute("aria-selected", "true");
  expect(interruptCalls).toBe(0);
  expect(closeCalls).toBe(0);
});

test("GPT-02 worker snapshots update the running dot and shared activity summary without exposing raw tool data", async ({ page }) => {
  let current = worker("live-worker", "starting");
  await mockWorkerList(page, () => [current]);
  const liveTab = page.locator(".thread-worker-tab").filter({ hasText: "live-worker" });
  await expect(liveTab.locator(".thread-running-dot")).toHaveCount(1);
  current = worker("live-worker", "waiting_input", {
    pendingQuestionCount: 1,
    recentTools: [{ name: "read_file", status: "running", at: Date.now() }],
    lastReplyPreview: "safe reply preview",
  });
  await expect(page.locator(".background-task-bar")).toContainText("等待输入", { timeout: 7_000 });
  await expect(page.locator(".thread-tabs-bar")).not.toContainText("SECRET_RAW_ARGUMENT");
  await expect(page.locator(".background-task-bar")).not.toContainText("SECRET_RAW_ARGUMENT");
  await liveTab.click();
  await expect(page.locator(".message-stream")).toContainText("safe reply preview");
});

test("GPT-03 closing a worker tab does not stop its retained session and the main agent can resume it", async ({ page }) => {
  let current = worker("resume-me", "running", { hasUnreadReply: true });
  await mockWorkerList(page, () => [current]);
  let interruptCalls = 0;
  let closeCalls = 0;
  await page.route("**/api/gpt-sessions/interrupt", async (route) => {
    interruptCalls++;
    current = { ...current, status: "interrupted", updatedAt: Date.now() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: current }) });
  });
  await page.route("**/api/gpt-sessions/close", async (route) => {
    closeCalls++;
    current = { ...current, status: "closed", updatedAt: Date.now() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: current }) });
  });
  await page.locator(".thread-worker-tab").filter({ hasText: "resume-me" }).click();
  await expect(page.locator(".message-stream")).toContainText("resume-me preview");
  await page.getByRole("button", { name: "关闭工兵标签 resume-me" }).click();
  expect(interruptCalls).toBe(0);
  expect(closeCalls).toBe(0);
  await page.getByRole("tab", { name: "💬 主会话 (Gemini)" }).click();

  const call = { id: "resume-call", name: "gpt_session_send", arguments: JSON.stringify({ name: "resume-me", message: "continue prior task" }) };
  let resumeSessionId = "";
  let submittedMessages: { role: string; content: string }[] = [];
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const submitted = route.request().postDataJSON() as { sessionId: string; messages: { role: string; content: string }[] };
    resumeSessionId = submitted.sessionId;
    submittedMessages = submitted.messages;
    current = { ...current, status: "idle", updatedAt: Date.now() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runId: "resume-run", sessionId: resumeSessionId }) });
  });
  await page.route("**/api/runs/resume-run/stream**", async (route) => {
    const events = [
      { type: "assistant_start", id: "resume-tool-message" },
      { type: "assistant", message: { id: "resume-tool-message", role: "assistant", content: "", enabled: true, toolCalls: [call] } },
      { type: "message", message: { id: "resume-tool-result", role: "tool", content: "Existing GPT session resumed", enabled: true, toolCallId: call.id, toolName: call.name } },
      { type: "assistant", message: { id: "resume-final", role: "assistant", content: "GPT-03 resumed existing worker", enabled: true } },
      { type: "run_status", runId: "resume-run", sessionId: resumeSessionId, status: "completed" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${events.map((event, index) => JSON.stringify({ seq: index + 1, event })).join("\n")}\n`,
    });
  });
  await sendMessage(page, "continue the existing worker resume-me");
  await expect(page.getByText("GPT-03 resumed existing worker", { exact: true })).toBeVisible();
  expect(submittedMessages.some((message) => message.role === "user" && message.content.includes("continue the existing worker"))).toBe(true);
  await expect.poll(async () => {
    const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href).then((response) => response.json());
    const messages = saved.workspace.sessions.find((session: { id: string }) => session.id === saved.workspace.active).messages;
    return messages.some((message: { toolCalls?: { name: string; arguments: string }[] }) => message.toolCalls?.some((item) => item.name === "gpt_session_send" && item.arguments.includes("resume-me")));
  }).toBe(true);
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
  await page.route("**/api/runs", async (route) => {
    runPayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await ui(page).composer.fill("keep-this-user-draft");
  workers = [worker("manual-review", "idle", { hasUnreadReply: true, lastReplyPreview: "delivered report" })];
  await waitForWorkerListUpdate(page);
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
  const runPayloads: { messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") runPayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await setMockScript(page, [{ type: "slow", text: "main-run-finished", delayBeforeMs: 2_500 }]);

  await sendMessage(page, "keep the main model busy");
  await expect(page.locator(".composer-running")).toBeVisible();
  workers = [worker("busy-review", "idle", { hasUnreadReply: true })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toContainText("主模型运行中");
  await expect(page.getByRole("button", { name: /让 Gemini 审阅汇报/ })).toBeDisabled();
  await page.waitForTimeout(1_700);
  expect(runPayloads).toHaveLength(1);
  expect(runPayloads[0].messages.some((message) => message.content.includes("后台 GPT 工兵已交卷"))).toBe(false);
  await expect(page.getByText("main-run-finished", { exact: true })).toBeVisible();
  await expect(page.locator(".composer-running")).toHaveCount(0);
  expect(runPayloads, "finishing the main run must not drain a queued worker review").toHaveLength(1);

  await setMockScript(page, [{ type: "text", text: "manual-review-finished" }]);
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
  const claimedWorker = (status: string, overrides: Partial<Worker> = {}) =>
    worker("claimed-worker", status, { replySequence: 7, ...overrides });
  let workers = [claimedWorker("running")];
  await mockWorkerList(page, () => workers);
  workers = [claimedWorker("idle", { hasUnreadReply: true, hasActiveWaiter: true })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [claimedWorker("idle", { hasUnreadReply: true })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toContainText("claimed-worker");
  workers = [claimedWorker("idle", { hasUnreadReply: true, hasActiveWaiter: true })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [claimedWorker("idle", { hasUnreadReply: false })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [claimedWorker("idle", { hasUnreadReply: true })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toContainText("claimed-worker");
  await page.getByRole("button", { name: "忽略工兵交卷提醒" }).click();
  workers = [claimedWorker("idle", { hasUnreadReply: false })];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [claimedWorker("idle", { hasUnreadReply: true })];
  await waitForWorkerListUpdate(page);
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
    worker("owned-worker", "running", { ownerSessionId: "owning-session", replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "running", { ownerSessionId: "unrelated-session", replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await mockWorkerList(page, () => workers);
  workers = [
    worker("owned-worker", "running", { ownerSessionId: "owning-session", hasUnreadReply: true, replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "running", { ownerSessionId: "unrelated-session", hasUnreadReply: true, replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await waitForWorkerListUpdate(page);
  await expect(page.locator(".worker-wake-banner")).toHaveCount(0);
  workers = [
    worker("owned-worker", "idle", { ownerSessionId: "owning-session", hasUnreadReply: true, replySequence, updatedAt: replyAt }),
    worker("unowned-worker", "idle", { ownerSessionId: "unrelated-session", hasUnreadReply: true, replySequence: replySequence + 1, updatedAt: replyAt + 1 }),
  ];
  await waitForWorkerListUpdate(page);
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
  await waitForWorkerListUpdate(page);
  workers = [worker("owned-worker", "idle", { hasUnreadReply: true, replySequence, updatedAt: replyAt })];
  await waitForWorkerListUpdate(page);
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
  await page.locator(`.session-row[data-session-id="${source.id}"] .session-main`).click();
  await expect(page.locator(".message-row").filter({ hasText: "SOURCE-PROMPT" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "SOURCE-REPLY" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "BRANCH-PROMPT" })).toHaveCount(0);
});

test("E2E-02 默认 Agent 拒绝位于对话之后的 System 指令且保留历史", async ({ page }) => {
  await page.getByRole("combobox", { name: "新消息角色" }).selectOption("user");
  await ui(page).composer.fill("E2E-02-user");
  await page.getByRole("button", { name: "仅添加" }).click();
  await page.getByRole("combobox", { name: "新消息角色" }).selectOption("system");
  await ui(page).composer.fill("E2E-02-late-system");
  await page.getByRole("button", { name: "仅添加" }).click();
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByRole("alert")).toContainText(/Pi 订阅要求 system 指令位于开头/);
  await expect(page.locator(".message-row").filter({ hasText: "E2E-02-user" })).toBeVisible();
  await expect(page.locator(".message-row").filter({ hasText: "E2E-02-late-system" })).toBeVisible();
});
