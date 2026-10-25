import { expect, test, type Locator, type Page } from "@playwright/test";
import { openRequestInspector, openWorkspace, resetWorkspace, setMockScript, toolSummary, ui } from "./fixtures/index";

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
  const summary = toolSummary(tool);
  const body = tool.locator(".tool-step-body");
  if (!(await body.count())) await summary.click();
  await expect(body).toBeVisible();
}
async function openRaw(tool: Locator) {
  await openToolBody(tool);
  await tool.getByRole("button", { name: "查看/编辑原始参数" }).click();
}

test.beforeEach(async ({ page }) => ready(page));

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
  await expect(steps.nth(1).locator(".tool-state")).toHaveText("失败");
  await openToolBody(steps.nth(1));
  await expect(page.getByText("TOOL01-RESULT-SECOND", { exact: true })).toBeVisible();
  await openToolBody(steps.nth(0));
  const renderedTrajectory = await page.locator(".message-stream").innerText();
  expect(renderedTrajectory.indexOf("TOOL01-RESULT-FIRST")).toBeLessThan(renderedTrajectory.indexOf("TOOL01-RESULT-SECOND"));
});

test("TOOL-01 运行中的工具显示待返回状态，完成后状态更新", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "TOOL01-PENDING", delayMs: 900, output: "TOOL01-PENDING-RESULT" }]);
  await ui(page).composer.fill("wait for mock tool");
  await ui(page).send.click();
  const tool = ui(page).tool();
  await expect(tool.locator(".tool-state")).toHaveText("待返回");
  await expect(page.getByText("正在执行 e2e_mock_tool", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0, { timeout: 8_000 });
  await openToolGroups(page);
  await expect(tool.locator(".tool-state")).toHaveText("完成");
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
  await group.locator(":scope > details > summary").click();
  await openToolBody(ui(page).tool().first());
  await expect(page.getByText(/未收到该工具的完整结果/)).toBeVisible();
  await expect(page.getByText(/操作可能已经部分完成/)).toBeVisible();
  await expect(page.locator(".tool-step.failed .tool-state")).toContainText("失败");
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
