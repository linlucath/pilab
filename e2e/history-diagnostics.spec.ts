import { test, expect, type Page } from "@playwright/test";
import { inspectTestState, openRequestInspector, prepareE2eWorkspace, setMockScript, type SeedSession } from "./fixtures/index";

const settings = {
  model: "history-fixture-model",
  reasoning: false,
  reasoningEffort: "off" as const,
};
const session = (id = "history-session", model = settings.model): SeedSession => ({
  id,
  title: id,
  settings: { ...settings, model },
  messages: [{ id: `${id}-user`, role: "user", content: "HISTORY-FIXTURE-PROMPT", enabled: true }],
});

async function runCurrent(page: Page, script: Parameters<typeof setMockScript>[1], marker: string) {
  await setMockScript(page, script);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText(marker, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
}

async function postClientLog(page: Page, event: string, message: string) {
  const response = await page.context().request.post(new URL("/api/logs/client", page.url()).href, {
    data: { level: "info", event, message, data: { fixture: true } },
  });
  expect(response.ok(), `client log rejected: ${response.status()}`).toBeTruthy();
}

test("HIS-01 当前页运行快照按时间倒序保留最近 30 条状态与轨迹", async ({ page }) => {
  test.setTimeout(90_000);
  await prepareE2eWorkspace(page, [session()]);

  await runCurrent(page, [{ type: "text", text: "HIS01-OLDEST-RUN" }], "HIS01-OLDEST-RUN");
  await runCurrent(page, [
    { type: "tool", input: "history-trace" },
    { type: "text", text: "HIS01-TOOL-OUTPUT" },
  ], "HIS01-TOOL-OUTPUT");

  await setMockScript(page, [{ type: "slow", text: `HIS01-STOP-PARTIAL-${"streaming ".repeat(120)}`, chunkSize: 3, delayMs: 40 }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText(/HIS01-STOP-PARTIAL/)).toBeVisible();
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  await setMockScript(page, [{ type: "error", message: "HIS01-SCRIPTED-FAILURE" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByRole("alert")).toContainText("HIS01-SCRIPTED-FAILURE");
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  for (let index = 4; index <= 30; index++) {
    const marker = `HIS01-OUTPUT-${index}`;
    await runCurrent(page, [{ type: "text", text: marker }], marker);
  }

  const snapshot = await inspectTestState(page);
  const runs = snapshot.runs.filter((run) => run.sessionId === "history-session").sort((left, right) => right.at - left.at);
  expect(runs).toHaveLength(30);
  expect(runs[0].output).toContain("HIS01-OUTPUT-30");
  expect(runs.some((run) => run.output.includes("HIS01-OLDEST-RUN"))).toBe(false);
  expect(runs[0].snapshot.settings.model).toBe("history-fixture-model");
  expect(runs.some((run) => run.output.includes("HIS01-TOOL-OUTPUT") && JSON.stringify(run.trace).includes("e2e_mock_tool"))).toBe(true);
  expect(runs.some((run) => run.status === "stopped" && run.output.includes("HIS01-STOP-PARTIAL"))).toBe(true);
  expect(runs.some((run) => run.status === "error" && run.error?.includes("HIS01-SCRIPTED-FAILURE"))).toBe(true);
});

test("HIS-02 连续运行保留各自的输入与模型快照，不覆盖当前工作区", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-restore", "history-model-before")]);
  await runCurrent(page, [{ type: "text", text: "HIS02-FIRST-RUN" }], "HIS02-FIRST-RUN");

  await page.getByRole("button", { name: /选择模型/ }).click();
  await page.getByLabel("自定义模型 ID").fill("history-model-after");
  const message = page.locator('.message-row[data-message-id="history-restore-user"]');
  await message.locator("article.chat-message").hover();
  await message.getByRole("button", { name: "编辑消息" }).click();
  await page.getByLabel("编辑 You 消息").fill("HIS02-EDITED-CURRENT-PROMPT");
  await page.getByRole("button", { name: "保存消息" }).click();
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    const workspace = (await response.json()).workspace;
    return workspace.sessions.find((item: { id: string }) => item.id === "history-restore")?.messages.map((item: { content: string }) => item.content);
  }).toContain("HIS02-EDITED-CURRENT-PROMPT");
  await runCurrent(page, [{ type: "text", text: "HIS02-SECOND-RUN" }], "HIS02-SECOND-RUN");

  const runs = (await inspectTestState(page)).runs.filter((run) => run.sessionId === "history-restore").sort((left, right) => right.at - left.at);
  expect(runs).toHaveLength(2);
  expect(runs[0].snapshot.settings.model).toBe("history-model-after");
  expect(runs[0].snapshot.messages.map((message) => message.content)).toContain("HIS02-EDITED-CURRENT-PROMPT");
  expect(runs[1].snapshot.settings.model).toBe("history-model-before");
  expect(runs[1].snapshot.messages.map((message) => message.content)).toContain("HISTORY-FIXTURE-PROMPT");
  await expect(page.getByLabel("会话标题")).toHaveValue("history-restore");
  await expect(page.getByRole("button", { name: /选择模型，当前 history-model-after/ })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p")).toContainText("HIS02-EDITED-CURRENT-PROMPT");
  await expect(page.locator(".message-row").getByText("HIS02-FIRST-RUN")).toBeVisible();

  const response = await page.context().request.get(new URL("/api/logs?category=run", page.url()).href);
  const { logs } = await response.json() as { logs: { event: string }[] };
  expect(logs.filter((entry) => entry.event === "run_started")).toHaveLength(2);
  const workspaceResponse = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  const workspace = (await workspaceResponse.json()).workspace;
  const persisted = workspace.sessions.find((item: { id: string }) => item.id === "history-restore");
  expect(persisted.messages.map((message: { content: string }) => message.content)).toContain("HIS02-EDITED-CURRENT-PROMPT");
  expect(persisted).not.toHaveProperty("runs");
});

test("HIS-03 测试检查契约读取逐轮实际请求且不暴露鉴权信息", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-inspector")]);
  await setMockScript(page, [
    { type: "tool", input: "inspector-tool" },
    { type: "text", text: "HIS03-MULTI-TURN-COMPLETE" },
  ]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("HIS03-MULTI-TURN-COMPLETE")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);

  const inspected = JSON.parse(await openRequestInspector(page)) as Record<string, unknown>[];
  expect(inspected).toHaveLength(2);
  expect(JSON.stringify(inspected[0])).toContain("HISTORY-FIXTURE-PROMPT");
  expect(JSON.stringify(inspected[1])).toContain("e2e_mock_tool");
  expect(JSON.stringify(inspected)).not.toMatch(/authorization|apiKey/i);
});

test("HIS-04 诊断日志 API 支持分类、搜索与清空", async ({ page }) => {
  await prepareE2eWorkspace(page, [session("history-diagnostics")]);

  await page.context().request.get(new URL("/api/gpt-sessions", page.url()).href);
  await runCurrent(page, [{ type: "text", text: "HIS04-RUN-LOG" }], "HIS04-RUN-LOG");
  await postClientLog(page, "diagnostic_alpha", "HIS04-FILTER-ALPHA");
  await postClientLog(page, "diagnostic_beta", "HIS04-FILTER-BETA");

  const queryLogs = async (category: string, q?: string) => {
    const url = new URL("/api/logs", page.url());
    url.searchParams.set("category", category);
    if (q) url.searchParams.set("q", q);
    const response = await page.context().request.get(url.href);
    expect(response.ok()).toBeTruthy();
    return (await response.json()).logs as { category: string; event: string; message: string }[];
  };
  const serverLogs = await queryLogs("server");
  expect(serverLogs.every((entry) => entry.category === "server")).toBe(true);
  expect((await queryLogs("run")).some((entry) => entry.event === "run_done")).toBe(true);
  expect((await queryLogs("gpt")).some((entry) => entry.event === "gpt_sessions_list")).toBe(true);
  expect((await queryLogs("client")).map((entry) => entry.event)).toEqual(expect.arrayContaining(["diagnostic_alpha", "diagnostic_beta"]));
  const alpha = await queryLogs("client", "HIS04-FILTER-ALPHA");
  expect(alpha).toHaveLength(1);
  expect(alpha[0].message).toContain("HIS04-FILTER-ALPHA");
  expect(alpha.some((entry) => entry.event === "diagnostic_beta")).toBe(false);

  await postClientLog(page, "diagnostic_refresh", "HIS04-REFRESH-MARKER");
  expect((await queryLogs("client", "HIS04-REFRESH-MARKER")).map((entry) => entry.event)).toEqual(["diagnostic_refresh"]);
  const cleared = await page.context().request.delete(new URL("/api/logs", page.url()).href);
  expect(cleared.ok()).toBeTruthy();
  expect(await queryLogs("all")).toHaveLength(0);
});
