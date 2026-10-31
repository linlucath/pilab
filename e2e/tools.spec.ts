import { mkdir } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eSession, latestInspectedRun, openRequestInspector, openWorkspace, resetWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";
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
async function latestRun(page: Page) {
  await expect.poll(async () => (await latestInspectedRun(page))?.status).not.toBe("running");
  return latestInspectedRun(page);
}
async function openToolGroups(page: Page) {
  for (const group of await page.locator(".tool-group").all()) {
    const details = group.locator(":scope > details");
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
  }
}
async function openToolBody(tool: Locator) {
  const body = tool.locator(":scope > .tool-step-body");
  const group = tool.locator("xpath=ancestor::section[contains(concat(' ', normalize-space(@class), ' '), ' tool-group ')][1]");
  const groupDetails = group.locator(":scope > details");
  if (await groupDetails.count() && !(await groupDetails.evaluate((element) => (element as HTMLDetailsElement).open)))
    await groupDetails.locator(":scope > summary").click();
  const isDetails = await tool.evaluate((element) => element instanceof HTMLDetailsElement);
  if (isDetails && !(await tool.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await tool.locator(":scope > summary").click();
    await expect.poll(() => tool.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  }
  await expect(body).toBeVisible();
}
async function openRaw(tool: Locator) {
  await openToolBody(tool);
  await tool.locator(".tool-raw-details > summary").click();
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
  await expect(sameTitleDetails.locator(":scope > summary")).toContainText("src/one.ts");
  await expect(sameTitleDetails.locator(":scope > summary")).toContainText("src/two.ts");
  await sameTitleDetails.locator(":scope > summary").click();
  const sameTitleSteps = sameTitleGroup.locator(".tool-step");
  await expect(sameTitleSteps).toHaveCount(2);
  for (const [index, step] of (await sameTitleSteps.all()).entries()) {
    await expect(step.locator(":scope > summary")).toContainText(`步骤 ${index + 1}`);
    await expect(step.locator(":scope > .tool-step-body")).toHaveCount(index === 1 ? 1 : 0);
    await expect(step.locator(".tool-readable-block a")).toHaveCount(0);
  }
});

test("TOOL-01 交付结果优先呈现，展开区保留可滚动的工兵任务指令", async ({ page }) => {
  const sessionId = "subagent-result-first-session";
  const promptLead = "请查阅并更新工具展示组件，隐藏原始 RPC 参数并改善 Markdown 排版。";
  const prompt = `${promptLead}\n\n${Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 项：核对相关组件的调用方式、验证边界行为，并在交付中简洁记录实现结果。`).join("\n\n")}`;
  const delivered = "# 工具展示组件已更新\n\n交付正文完整显示，段落间距舒适。\n\n- 工具标题保持克制\n- 交付结果优先呈现，任务指令仍可展开查看";
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
  const instruction = tool.locator(".tool-task-instruction");
  await expect(instruction).toBeVisible();
  await expect(instruction.locator(".tool-task-instruction-heading > strong")).toHaveText("任务指令");
  await expect(instruction.locator(".tool-task-instruction-heading > small")).toHaveText("quiet-wait-worker");
  await expect(instruction).toContainText(promptLead);
  await expect(instruction.locator(".tool-task-instruction-content")).toHaveCSS("max-height", "190px");
  await expect.poll(() => instruction.locator(".tool-task-instruction-content").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const resultBeforeInstruction = await result.evaluate((element) => element.compareDocumentPosition(element.parentElement!.querySelector(".tool-task-instruction")!) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(resultBeforeInstruction).toBeTruthy();
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
  await expect(page.getByText("TOOL01-RESULT-FIRST", { exact: true })).toHaveCount(0);
  await openToolGroups(page);
  const steps = page.locator(".tool-step[data-tool-name='e2e_mock_tool']");
  await expect(steps).toHaveCount(1);
  await expect(page.locator(".tool-group .tool-group-state").first()).toHaveText("· 完成");
  await openToolBody(steps.nth(0));
  await expect(page.locator(".tool-readable-block").filter({ hasText: "TOOL01-RESULT-FIRST" })).toBeVisible();
  await page.locator(".tool-group > details > summary").first().click();
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
  await expect(page.locator(".tool-readable-block").filter({ hasText: "TOOL01-RESULT-SECOND" })).toBeVisible();
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
  await expect(tools.nth(0).getByRole("button", { name: "添加结果" })).toHaveCount(0);
  const firstRawDetails = tools.nth(0).locator(".tool-raw-details");
  await firstRawDetails.locator(":scope > summary").click();
  await firstRawDetails.getByRole("button", { name: "补录工具结果" }).click();
  const firstEditor = tools.nth(0).getByRole("textbox", { name: "工具结果内容" });
  await firstEditor.fill("discard draft");
  await firstEditor.press("Escape");
  await expect(firstEditor).toHaveCount(0);
  await firstRawDetails.getByRole("button", { name: "补录工具结果" }).click();
  await firstEditor.fill("MANUAL-RESULT-ONE");
  await firstEditor.press("Control+Enter");
  await expect(tools.nth(0)).toContainText("MANUAL-RESULT-ONE");
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 待返回");
  await expect(ui(page).alerts).toContainText("添加工具结果");

  await openToolBody(tools.nth(1));
  const secondRawDetails = tools.nth(1).locator(".tool-raw-details");
  await secondRawDetails.locator(":scope > summary").click();
  await secondRawDetails.getByRole("button", { name: "补录工具结果" }).click();
  await tools.nth(1).getByRole("textbox", { name: "工具结果内容" }).fill('{"ok":true}');
  await tools.nth(1).getByRole("checkbox", { name: /标记为错误/ }).check();
  await tools.nth(1).getByRole("button", { name: /保存/ }).click();
  await openToolGroups(page);
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 失败");
  await expect(ui(page).alerts).toHaveCount(0);

  await openToolBody(tools.nth(0));
  await firstRawDetails.locator(":scope > summary").click();
  await firstRawDetails.locator(".tool-raw-fields label").filter({ hasText: "工具结果" }).locator("textarea").fill("MANUAL-RESULT-EDITED");
  await firstRawDetails.locator(":scope > summary").click();
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
  await tools.nth(0).locator(".tool-raw-details > summary").click();
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
  await expect(page.locator(".tool-live-call .tool-live-pulse")).toBeVisible();
  await expect(page.locator(".tool-live-call .tool-live-arguments")).not.toHaveAttribute("open", "");
  await expect(page.locator(".tool-live-call .tool-live-arguments pre")).not.toBeVisible();
  await expect(ui(page).stop).toHaveCount(0, { timeout: 8_000 });
  await openToolGroups(page);
  await expect(page.locator(".tool-group .tool-group-state")).toHaveText("· 完成");
});

test("TOOL-07 多步骤工具统一成卡片，运行中参数收在可展开详情并保存验证截图", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setMockScript(page, [
    { type: "tool", input: "LIFECYCLE-STEP-ONE", output: "第一步已完成：读取项目结构。" },
    { type: "tool", input: "LIFECYCLE-STEP-TWO", delayMs: 5000, output: "第二步处理中。" },
  ]);
  await ui(page).composer.fill("检查多步骤工具生命周期呈现");
  await ui(page).send.click();

  const group = page.locator('.tool-group[data-step-count="2"]');
  await expect(group).toBeVisible();
  await expect(group).toHaveClass(/is-live/);
  const steps = group.locator(".tool-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0).locator(":scope > summary")).toContainText("步骤 1");
  await expect(steps.nth(0).locator(".tool-state.complete")).toHaveText("完成");
  await expect(steps.nth(1).locator(":scope > summary")).toContainText("步骤 2");
  await expect(steps.nth(1).locator(".tool-state.running")).toHaveText("执行中");
  await expect(steps.nth(0).locator(":scope > .tool-step-body")).toHaveCount(0);
  await expect(steps.nth(1).locator(":scope > .tool-step-body")).toBeVisible();

  const live = page.locator(".tool-live-call");
  await expect(live).toBeVisible();
  await expect(live).toContainText("正在执行 e2e_mock_tool");
  await expect(live.locator(".tool-live-pulse")).toBeVisible();
  const rawArguments = live.locator(".tool-live-arguments");
  await expect(rawArguments).not.toHaveAttribute("open", "");
  await expect(rawArguments.locator("pre")).not.toBeVisible();
  await rawArguments.locator(":scope > summary").click();
  await expect(rawArguments.locator("pre")).toContainText("LIFECYCLE-STEP-TWO");
  await rawArguments.locator(":scope > summary").click();
  await expect(rawArguments).not.toHaveAttribute("open", "");
  await expect(group.locator(".tool-raw-details")).toHaveCount(1);
  await expect(steps.nth(0).locator(".tool-raw-details")).toHaveCount(0);
  await expect(steps.nth(1).locator(".tool-raw-details")).toHaveCount(1);
  await expect(group.getByRole("button", { name: "添加结果" })).toHaveCount(0);

  await mkdir("artifacts/ui-verification", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-verification/tool-lifecycle-fixed.png", fullPage: true });
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
});

test("TOOL-08 空思考和空派遣指令不渲染标签", async ({ page }) => {
  const emptyThinking = { api: "openai-completions", provider: "e2e", model: "e2e-mock", thinking: [{ type: "thinking" as const, thinking: "  \n\t" }] };
  await seedWorkspace(page, [e2eSession("empty-thought-session", "Empty thought", [
    { id: "empty-thought-system", role: "system", content: "test system", enabled: true },
    { id: "empty-thought-user", role: "user", content: "检查空思考", enabled: true },
    { id: "empty-thought-assistant", role: "assistant", content: "正文仍然可见。", enabled: true, providerState: emptyThinking },
    { id: "empty-instruction-assistant", role: "assistant", content: "", enabled: true, providerState: emptyThinking, toolCalls: [
      { id: "empty-instruction-call", name: "subagent_dispatch", arguments: JSON.stringify({ task: { message: "  \n " } }) },
    ] },
  ])]);
  await openWorkspace(page);

  await expect(page.locator('.message-row[data-message-id="empty-thought-assistant"]')).toContainText("正文仍然可见。");
  const group = page.locator('.tool-group[data-message-id="empty-instruction-assistant"]');
  await expect(group).toBeVisible();
  await expect(group.locator(".tool-step-thinking, .tool-original-instruction")).toHaveCount(0);
  await expect(page.locator(".thinking-accordion")).toHaveCount(0);
  await expect(page.getByText(/思考过程/)).toHaveCount(0);
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
  const requestText = await openRequestInspector(page);
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
  await expect(group).toHaveClass(/is-compacted/);
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
  let requestText = await openRequestInspector(page);
  expect(requestText).toContain("TOOL03-CUSTOM-SUMMARY");
  expect(requestText).not.toContain("TOOL03-ORIGINAL-RESULT");

  await group.hover();
  await group.getByRole("button", { name: "还原" }).click();
  await setMockScript(page, [{ type: "text", text: "TOOL03-RESTORED-RUN" }]);
  await runCurrent(page);
  await expect(page.getByText("TOOL03-RESTORED-RUN", { exact: true })).toBeVisible();
  requestText = await openRequestInspector(page);
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
  await expect(page.locator(".tool-readable-block.error")).toContainText("Mock tool execution interrupted.");
  await expect(page.locator(".tool-group-state.error")).toHaveText("· 失败");
  const run = await latestRun(page);
  expect(run?.status).toBe("stopped");
  expect(JSON.stringify(run?.trace)).toContain("TOOL04-WORK-IN-PROGRESS");
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
  const liveTool = page.locator(".tool-live-call");
  await expect(liveTool).toBeVisible();
  await expect(ui(page).stop).toBeVisible();
  await expect(liveTool).toContainText("TOOL05-LONG-RESULT-START");
  await expect(page.getByText("TOOL05-TRAJECTORY-DONE", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await expect(page.locator(".tool-group")).toHaveCount(2);
  const firstGroup = page.locator(".tool-group").nth(0);
  const recentGroup = page.locator(".tool-group").nth(1);
  await firstGroup.hover();
  const compactOldGroup = firstGroup.getByRole("button", { name: "精简" });
  await expect(compactOldGroup).toBeEnabled();
  await compactOldGroup.click();
  await expect(firstGroup).toHaveClass(/is-compacted/);
  await expect(recentGroup).not.toHaveClass(/is-compacted/);
  await expect(recentGroup.getByRole("button", { name: /精简/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /精简 \d+ 个较旧的工具组/ })).toHaveCount(0);
  await openToolBody(ui(page).tool().last());
  const resultBlock = ui(page).tool().last().locator(".tool-readable-block");
  await expect(resultBlock).toContainText("TOOL05-LONG-RESULT-END");
  await expect(resultBlock).toContainText("TOOL05-LONG-RESULT-START");
  const resultScroll = resultBlock.locator(".markdown-body");
  await expect.poll(() => resultScroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await resultScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => resultScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
