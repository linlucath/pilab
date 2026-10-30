import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eSession, openRequestInspector, openWorkspace, resetWorkspace, seedWorkspace, setMockScript, toolSummary, ui } from "./fixtures/index";
import type { Message } from "../shared/schema";

async function ready(page: Page) {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
}
async function runCurrent(page: Page) {
  await page.locator("button.run-current").click();
}
async function openHistory(page: Page) {
  await page.locator(".debug-menu > summary").click();
  await page.getByRole("button", { name: "运行记录" }).click();
}
async function openToolGroups(page: Page) {
  for (const group of await page.locator(".tool-group").all()) {
    const details = group.locator(":scope > details");
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
  }
}
async function openToolBody(tool: Locator) {
  const summary = tool.locator(":scope > summary");
  const body = tool.locator(".tool-step-body");
  const groupDetails = tool.locator("xpath=ancestor::details[1]");
  if (await groupDetails.count() && !(await groupDetails.evaluate((element) => (element as HTMLDetailsElement).open)))
    await groupDetails.locator(":scope > summary").click();
  if (await summary.count() && !(await body.isVisible())) await summary.click();
  await expect(body).toBeVisible();
}
async function openRaw(tool: Locator) {
  await openToolBody(tool);
  await tool.getByRole("button", { name: "查看/编辑原始参数" }).click();
}

test.beforeEach(async ({ page }) => ready(page));

test("TOOL-06 单步骤工具组使用单层折叠并显示克制文案", async ({ page }) => {
  const defaultPersona = page.locator(".system-banner");
  await expect(defaultPersona.locator("strong")).toHaveText("系统人设 · 智能协作模式");
  await expect(defaultPersona).not.toContainText("最佳伙伴");
  await expect(defaultPersona).not.toContainText("指挥");
  await expect(defaultPersona).not.toContainText("相当差劲");

  const sessionId = "single-tool-group-session";
  const callId = "single-tool-group-call";
  const resultText = "# 检查结果\n\n工具结果正文直接呈现，不插入测试链接。";
  await seedWorkspace(page, [e2eSession(sessionId, "单步骤工具组", [
    { id: "single-tool-system", role: "system", content: "You are a test assistant.", enabled: true },
    { id: "single-tool-user", role: "user", content: "检查工具结果卡片的层级与留白", enabled: true },
    { id: "single-tool-assistant", role: "assistant", content: "", enabled: true, toolCalls: [
      { id: callId, name: "subagent_dispatch", arguments: JSON.stringify({ task: { message: "检查工具结果卡片的层级与留白" } }) },
    ] },
    { id: "single-tool-result", role: "tool", content: resultText, toolCallId: callId, toolName: "subagent_dispatch", enabled: true },
    { id: "same-title-user", role: "user", content: "查阅两个文件", enabled: true },
    { id: "same-title-assistant", role: "assistant", content: "", enabled: true, toolCalls: [
      { id: "same-title-call-one", name: "read", arguments: "{\"path\":\"src/one.ts\"}" },
      { id: "same-title-call-two", name: "read", arguments: "{\"path\":\"src/two.ts\"}" },
    ] },
    { id: "same-title-result-one", role: "tool", content: "第一份文件内容。", toolCallId: "same-title-call-one", toolName: "read", enabled: true },
    { id: "same-title-result-two", role: "tool", content: "第二份文件内容。", toolCallId: "same-title-call-two", toolName: "read", enabled: true },
  ])]);
  await openWorkspace(page);

  await expect(ui(page).composer).toHaveAttribute("placeholder", "输入消息或任务要求...");
  await expect(page.locator(".system-banner strong")).toHaveText("系统人设 · 智能协作模式");
  const group = page.locator('.tool-group[data-message-id="single-tool-assistant"]');
  const groupDetails = group.locator(":scope > details");
  await expect(groupDetails).not.toHaveAttribute("open", "");
  const groupSummary = groupDetails.locator(":scope > summary");
  await expect(groupSummary).toContainText("检查工具结果卡片的层级与留白");
  await expect(groupSummary).toContainText("完成");
  await groupSummary.click();

  const tool = group.locator('.tool-step[data-tool-name="subagent_dispatch"]');
  await expect(tool.locator(":scope > summary")).toHaveCount(0);
  await expect(tool.locator(":scope > .tool-step-body")).toBeVisible();
  const result = tool.locator(".tool-dispatch-result");
  await expect(result.getByRole("heading", { name: "检查结果" })).toBeVisible();
  await expect(result).toContainText("不插入测试链接");
  await expect(result.locator("a")).toHaveCount(0);
  await expect(groupDetails.locator(":scope > summary > svg")).toHaveCount(1);

  const sameTitleGroup = page.locator('.tool-group[data-message-id="same-title-assistant"]');
  const sameTitleDetails = sameTitleGroup.locator(":scope > details");
  await expect(sameTitleDetails.locator(":scope > summary")).toContainText("查阅文件");
  await sameTitleDetails.locator(":scope > summary").click();
  const sameTitleSteps = sameTitleGroup.locator(".tool-step");
  await expect(sameTitleSteps).toHaveCount(2);
  for (const step of await sameTitleSteps.all()) {
    await expect(step.locator(":scope > summary")).toHaveCount(0);
    await expect(step.locator(":scope > .tool-step-body")).toBeVisible();
    await expect(step.locator(".tool-readable-block a")).toHaveCount(0);
  }
});

test("TOOL-01 工兵交付正文优先呈现，原始指令默认收起且展开状态稳定", async ({ page }) => {
  const sessionId = "subagent-result-first-session";
  const prompt = "请查阅并更新工具展示组件，隐藏原始 RPC 参数并改善 Markdown 排版。";
  const delivered = "# 工具展示组件已更新\n\n交付正文完整显示，段落间距舒适。\n\n- 工具标题保持克制\n- 原始指令默认收起";
  const callId = "subagent-result-first-call";
  const messages: Message[] = [
    { id: "subagent-result-system", role: "system", content: "You are a test assistant.", enabled: true },
    { id: "subagent-result-user", role: "user", content: "请完成工具展示改进。", enabled: true },
    { id: "subagent-result-assistant", role: "assistant", content: "", enabled: true, toolCalls: [
      { id: callId, name: "subagent_dispatch", arguments: JSON.stringify({ mode: "sync", task: { name: "quiet-wait-worker", message: prompt } }) },
    ] },
    { id: "subagent-result-output", role: "tool", content: delivered, toolCallId: callId, toolName: "subagent_dispatch", enabled: true },
  ];
  await seedWorkspace(page, [e2eSession(sessionId, "工兵交付结果", messages)]);
  await openWorkspace(page);

  const group = page.locator('.tool-group[data-message-id="subagent-result-assistant"]');
  const groupDetails = group.locator(":scope > details");
  if (!(await groupDetails.evaluate((element) => (element as HTMLDetailsElement).open))) await groupDetails.locator(":scope > summary").click();
  const tool = group.locator('.tool-step[data-tool-name="subagent_dispatch"]');
  await expect(tool.locator(":scope > summary")).toHaveCount(0);
  await expect(tool.locator(":scope > .tool-step-body")).toBeVisible();
  const result = tool.locator(".tool-dispatch-result");
  await expect(result.getByRole("heading", { name: "工具展示组件已更新" })).toBeVisible();
  await expect(result).toContainText("段落间距舒适");
  await expect(page.getByText("quiet-wait-worker", { exact: true })).toHaveCount(0);

  const original = tool.locator(".tool-original-instruction");
  await expect(original.locator(":scope > summary")).toHaveText(/原始指令/);
  await expect(original).not.toHaveAttribute("open", "");
  await expect(original.getByText(prompt, { exact: true })).not.toBeVisible();
  await original.locator(":scope > summary").click();
  await expect(original.getByText(prompt, { exact: true })).toBeVisible();
  await expect(tool.locator(".tool-step-body")).toBeVisible();
});

test("TOOL-01 正文不随工具折叠消失，显示调用状态、配对结果和执行顺序", async ({ page }) => {
  await setMockScript(page, [
    { type: "tool", input: "TOOL01-FIRST", assistantText: "TOOL01-ASSISTANT-PROSE", output: "TOOL01-RESULT-FIRST" },
    { type: "text", text: "TOOL01-FIRST-RUN-DONE" },
  ]);
  await ui(page).composer.fill("TOOL01-CALL-TOOLS");
  await ui(page).send.click();
  await expect(page.getByText("TOOL01-FIRST-RUN-DONE", { exact: true })).toBeVisible();
  await expect(page.getByText("TOOL01-ASSISTANT-PROSE", { exact: true })).toBeVisible();
  const steps = page.locator(".tool-step[data-tool-name='e2e_mock_tool']");
  await expect(steps).toHaveCount(1);
  await expect(steps.nth(0).locator(".tool-state")).toHaveText("完成");
  await expect(page.getByText("TOOL01-RESULT-FIRST", { exact: true })).toHaveCount(0);
  await openToolBody(steps.nth(0));
  await expect(page.getByText("TOOL01-RESULT-FIRST", { exact: true })).toBeVisible();
  await toolSummary(steps.nth(0)).click();
  await expect(page.getByText("TOOL01-RESULT-FIRST", { exact: true })).toHaveCount(0);
  await expect(page.getByText("TOOL01-ASSISTANT-PROSE", { exact: true })).toBeVisible();

  await setMockScript(page, [
    { type: "tool", input: "TOOL01-SECOND", output: "TOOL01-RESULT-SECOND", outputError: true },
    { type: "text", text: "TOOL01-FINAL-ANSWER" },
  ]);
  await runCurrent(page);
  await expect(page.getByText("TOOL01-FINAL-ANSWER", { exact: true })).toBeVisible();
  await openToolGroups(page);
  await expect(steps).toHaveCount(2);
  await expect(page.locator(".tool-group").last().locator(".tool-group-state")).toHaveText("· 失败");
  await openToolBody(steps.nth(1));
  await expect(page.getByText("TOOL01-RESULT-SECOND", { exact: true })).toBeVisible();
  await openToolBody(steps.nth(0));
  const renderedTrajectory = await page.locator(".message-stream").innerText();
  expect(renderedTrajectory.indexOf("TOOL01-RESULT-FIRST")).toBeLessThan(renderedTrajectory.indexOf("TOOL01-RESULT-SECOND"));
});

test("TOOL-03 手动添加待返回结果可解除校验、编辑并继续运行", async ({ page }) => {
  const sessionId = "manual-tool-result-session";
  const messages: Message[] = [
    { id: "manual-system", role: "system", content: "You are a test assistant.", enabled: true },
    { id: "manual-user", role: "user", content: "Please finish the pending tool calls.", enabled: true },
    { id: "manual-assistant", role: "assistant", content: "", enabled: true, toolCalls: [
      { id: "manual-call-1", name: "e2e_mock_tool", arguments: "{\"input\":\"one\"}" },
      { id: "manual-call-2", name: "e2e_mock_tool", arguments: "{\"input\":\"two\"}" },
    ] },
  ];
  await seedWorkspace(page, [e2eSession(sessionId, "Manual tool result", messages)]);
  await openWorkspace(page);

  await runCurrent(page);
  await expect(ui(page).alerts).toContainText("添加工具结果");
  const tools = page.locator(".tool-step[data-tool-name='e2e_mock_tool']");
  await expect(tools).toHaveCount(2);
  await openToolBody(tools.nth(0));
  await tools.nth(0).getByRole("button", { name: "添加结果" }).click();
  const firstEditor = tools.nth(0).getByRole("textbox", { name: "工具结果内容" });
  await firstEditor.fill("discard draft");
  await firstEditor.press("Escape");
  await expect(firstEditor).toHaveCount(0);
  await tools.nth(0).getByRole("button", { name: "添加结果" }).click();
  await firstEditor.fill("MANUAL-RESULT-ONE");
  await firstEditor.press("Control+Enter");
  await expect(tools.nth(0)).toContainText("MANUAL-RESULT-ONE");
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 待返回");
  await expect(ui(page).alerts).toContainText("添加工具结果");

  await openToolBody(tools.nth(1));
  await tools.nth(1).getByRole("button", { name: "添加结果" }).click();
  await tools.nth(1).getByRole("textbox", { name: "工具结果内容" }).fill('{"ok":true}');
  await tools.nth(1).getByRole("checkbox", { name: /标记为错误/ }).check();
  await tools.nth(1).getByRole("button", { name: /保存/ }).click();
  await openToolGroups(page);
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 失败");
  await expect(ui(page).alerts).toHaveCount(0);

  await openRaw(tools.nth(0));
  await tools.nth(0).locator(".tool-raw-fields label").filter({ hasText: "工具结果" }).locator("textarea").fill("MANUAL-RESULT-EDITED");
  await tools.nth(0).getByRole("button", { name: "收起原始参数" }).click();
  await setMockScript(page, [{ type: "text", text: "TOOL03-MANUAL-RESULT-RUN" }]);
  await runCurrent(page);
  await expect(page.getByText("TOOL03-MANUAL-RESULT-RUN", { exact: true })).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get("/api/workspace");
    const data = await response.json();
    const session = data.workspace.sessions.find((item: { id: string }) => item.id === sessionId);
    return session?.messages.find((message: { role: string; toolCallId?: string }) => message.role === "tool" && message.toolCallId === "manual-call-1")?.content;
  }).toBe("MANUAL-RESULT-EDITED");

  await openToolBody(tools.nth(0));
  await tools.nth(0).getByRole("button", { name: "删除此步骤及配对结果" }).click();
  await expect(tools).toHaveCount(1);
});

test("TOOL-01 运行中的工具显示待返回状态，完成后状态更新", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "TOOL01-PENDING", delayMs: 900, output: "TOOL01-PENDING-RESULT" }]);
  await ui(page).composer.fill("wait for mock tool");
  await ui(page).send.click();
  const tool = ui(page).tool();
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 待返回");
  await expect(page.getByText("正在执行 e2e_mock_tool", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0, { timeout: 8_000 });
  await openToolGroups(page);
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 完成");
});

test("TOOL-02 原始工具名、Call ID、参数、结果及错误标记编辑后配对更新", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "original", assistantText: "TOOL02-HISTORY" }, { type: "text", text: "TOOL02-EDIT-SETUP" }]);
  await ui(page).composer.fill("create editable tool data");
  await ui(page).send.click();
  await expect(page.getByText("TOOL02-EDIT-SETUP", { exact: true })).toBeVisible();
  await openToolGroups(page);
  const tool = page.locator(".tool-step").first();
  await openRaw(tool);
  const fields = tool.locator(".tool-raw-fields");
  const callId = fields.locator("label").filter({ hasText: /^Call ID/ }).locator("input");
  const resultCallId = fields.locator("label").filter({ hasText: /^结果 Call ID/ }).locator("input");
  const name = fields.locator("label").filter({ hasText: "工具名称" }).locator("input");
  const args = fields.locator("label").filter({ hasText: "参数 JSON" }).locator("textarea");
  const result = fields.locator("label").filter({ hasText: "工具结果" }).locator("textarea");
  await name.fill("edited_tool");
  await args.fill('{"input":"edited-arguments"}');
  await result.fill("TOOL02-EDITED-RESULT");
  await fields.getByRole("checkbox", { name: "错误结果" }).check();
  await callId.fill("edited-call-id");
  await openRaw(tool);
  await expect(tool.locator(".tool-raw-fields label").filter({ hasText: /^结果 Call ID/ }).locator("input")).toHaveValue("edited-call-id");
  await expect(tool.locator(".tool-raw-fields").getByRole("checkbox", { name: "错误结果" })).toBeChecked();

  await setMockScript(page, [{ type: "text", text: "TOOL02-EDITED-CONTEXT-RUN" }]);
  await runCurrent(page);
  await expect(page.getByText("TOOL02-EDITED-CONTEXT-RUN", { exact: true })).toBeVisible();
  await openRequestInspector(page);
  const requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("edited_tool");
  expect(requestText).toContain("edited-call-id");
  expect(requestText).toContain("edited-arguments");
  expect(requestText).toContain("TOOL02-EDITED-RESULT");
});

test("TOOL-02 无效 JSON 与重复 Call ID 在模型请求前报错", async ({ page }) => {
  await setMockScript(page, [
    { type: "tool", input: "first" },
    { type: "tool", input: "second" },
    { type: "text", text: "TOOL02-VALIDATION-SETUP" },
  ]);
  await ui(page).composer.fill("create two paired calls");
  await ui(page).send.click();
  await expect(page.getByText("TOOL02-VALIDATION-SETUP", { exact: true })).toBeVisible();
  await openToolGroups(page);
  const tools = page.locator(".tool-step[data-tool-name='e2e_mock_tool']");
  await expect(tools).toHaveCount(2);
  await openRaw(tools.nth(0));
  await tools.nth(0).locator(".tool-raw-fields label").filter({ hasText: "参数 JSON" }).locator("textarea").fill("{invalid-json");
  await runCurrent(page);
  await expect(ui(page).alerts).toContainText("参数不是有效 JSON");
  await tools.nth(0).locator(".tool-raw-fields label").filter({ hasText: "参数 JSON" }).locator("textarea").fill('{"input":"repaired"}');
  const firstId = await tools.nth(0).locator(".tool-raw-fields label").filter({ hasText: /^Call ID/ }).locator("input").inputValue();
  await openRaw(tools.nth(1));
  await tools.nth(1).locator(".tool-raw-fields label").filter({ hasText: /^Call ID/ }).locator("input").fill(firstId);
  await runCurrent(page);
  await expect(ui(page).alerts).toContainText("Call ID 为空或重复");
});

test("TOOL-03 精简整组只保留可编辑摘要在上下文中，恢复后重新发送原文", async ({ page }) => {
  await setMockScript(page, [
    { type: "tool", input: "TOOL03-CALL-ARGUMENT", output: "TOOL03-ORIGINAL-RESULT" },
    { type: "text", text: "TOOL03-SETUP-DONE" },
  ]);
  await ui(page).composer.fill("create a completed tool group");
  await ui(page).send.click();
  await expect(page.getByText("TOOL03-SETUP-DONE", { exact: true })).toBeVisible();
  const group = page.locator(".tool-group");
  await group.hover();
  await group.getByRole("button", { name: /精简/ }).click();
  await expect(group).toContainText("已精简上下文");
  await group.getByRole("button", { name: "查看摘要" }).click();
  const summaryEditor = group.getByRole("button", { name: "编辑" });
  await summaryEditor.click();
  const summary = group.getByRole("textbox", { name: "编辑工具组摘要" });
  await summary.fill("TOOL03-CUSTOM-SUMMARY");
  await group.getByRole("button", { name: "保存" }).click();
  await expect(group).toContainText("TOOL03-CUSTOM-SUMMARY");

  await setMockScript(page, [{ type: "text", text: "TOOL03-COMPACTED-RUN" }]);
  await runCurrent(page);
  await expect(page.getByText("TOOL03-COMPACTED-RUN", { exact: true })).toBeVisible();
  await openRequestInspector(page);
  let requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("TOOL03-CUSTOM-SUMMARY");
  expect(requestText).not.toContain("TOOL03-ORIGINAL-RESULT");
  await page.getByRole("button", { name: "关闭调试面板" }).click();

  await group.hover();
  await group.getByRole("button", { name: "还原" }).click();
  await setMockScript(page, [{ type: "text", text: "TOOL03-RESTORED-RUN" }]);
  await runCurrent(page);
  await expect(page.getByText("TOOL03-RESTORED-RUN", { exact: true })).toBeVisible();
  await openRequestInspector(page);
  requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("TOOL03-CALL-ARGUMENT");
  expect(requestText).toContain("TOOL03-ORIGINAL-RESULT");
});

test("TOOL-03 未完成工具组不允许精简", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "pending", delayMs: 1400 }]);
  await ui(page).composer.fill("start a long mock tool");
  await ui(page).send.click();
  const group = page.locator(".tool-group");
  await expect(group).toBeVisible();
  await group.hover();
  await expect(group.getByRole("button", { name: /精简/ })).toBeDisabled();
  await ui(page).stop.click();
});

test("TOOL-04 停止执行中的工具会记录执行状态未知的错误结果", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "TOOL04-WORK-IN-PROGRESS", delayMs: 3500 }]);
  await ui(page).composer.fill("interrupt a running mock tool");
  await ui(page).send.click();
  await expect(page.getByText("正在执行 e2e_mock_tool", { exact: true })).toBeVisible();
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
  const group = page.locator(".tool-group").first();
  const groupDetails = group.locator(":scope > details");
  if (!(await groupDetails.evaluate((element) => (element as HTMLDetailsElement).open)))
    await groupDetails.locator(":scope > summary").click();
  await openToolBody(ui(page).tool().first());
  await expect(page.getByText("Mock tool execution interrupted.", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-group-state.error")).toHaveText("· 失败");
  await openHistory(page);
  await expect(page.locator(".history-card").first()).toContainText("已停止");
  await expect(page.locator(".history-card").first()).toContainText("TOOL04-WORK-IN-PROGRESS");
});

test("TOOL-05 长工具轨迹保留完整输出、只精简较旧工具组并显示活动输出", async ({ page }) => {
  const longResult = "TOOL05-LONG-RESULT-START " + "long-output ".repeat(2500) + " TOOL05-LONG-RESULT-END";
  await setMockScript(page, [
    { type: "tool", input: "TOOL05-OLD", output: "TOOL05-OLD-RESULT" },
    { type: "text", text: "TOOL05-BREAK-GROUPS" },
  ]);
  await ui(page).composer.fill("create the older tool group");
  await ui(page).send.click();
  await expect(page.getByText("TOOL05-BREAK-GROUPS", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);

  await setMockScript(page, [
    { type: "tool", input: "TOOL05-RECENT", output: longResult, delayMs: 450, outputChunkDelayMs: 150 },
    { type: "text", text: "TOOL05-TRAJECTORY-DONE" },
  ]);
  await runCurrent(page);
  const liveTool = page.locator(".live-tool-card");
  await expect(liveTool).toBeVisible();
  await expect(ui(page).stop).toBeVisible();
  await expect(liveTool).toContainText("TOOL05-LONG-RESULT-START");
  await expect(page.getByText("TOOL05-TRAJECTORY-DONE", { exact: true })).toBeVisible();
  await expect(page.locator(".tool-group")).toHaveCount(2);
  const firstGroup = page.locator(".tool-group").nth(0);
  const recentGroup = page.locator(".tool-group").nth(1);
  const topCompact = page.getByRole("button", { name: "精简 1 个较旧的工具组" });
  await expect(topCompact).toBeEnabled();
  await topCompact.click();
  await expect(firstGroup).toContainText("已精简上下文");
  await expect(recentGroup).not.toContainText("已精简上下文");
  await expect(recentGroup.getByRole("button", { name: /精简/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /精简 \d+ 个较旧的工具组/ })).toHaveCount(0);
  await recentGroup.locator(":scope > details > summary").click();
  await openToolBody(ui(page).tool().last());
  const resultBlock = ui(page).tool().last().locator(".tool-readable-block");
  await expect(resultBlock).toContainText("TOOL05-LONG-RESULT-END");
  await expect(resultBlock).toContainText("TOOL05-LONG-RESULT-START");
  const resultScroll = resultBlock.locator(".markdown-body");
  await expect.poll(() => resultScroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await resultScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => resultScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
