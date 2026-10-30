import { test, expect } from "@playwright/test";
import { prepareE2eWorkspace, setMockScript } from "./fixtures/index";

const sessionSettings = {
  model: "branch-fixture-model",
  temperature: 0.25,
  reasoning: false,
  reasoningEffort: "off" as const,
};

const userMessage = (id: string, content: string) => ({ id, role: "user" as const, content, enabled: true });
const assistantMessage = (id: string, content: string) => ({ id, role: "assistant" as const, content, enabled: true });

async function openDebugPanel(page: import("@playwright/test").Page, name: string) {
  await page.locator("details.debug-menu > summary").click();
  await page.getByRole("button", { name }).click();
}

test("BRN-01 从历史消息分支只保留前缀、继承配置且不继承运行记录", async ({ page }) => {
  await prepareE2eWorkspace(page, [{
    id: "branch-source",
    title: "branch-source",
    settings: sessionSettings,
    messages: [
      { id: "branch-system", role: "system", content: "branch system prompt", enabled: true },
      userMessage("branch-user-1", "BRN01-PREFIX-ONE"),
      assistantMessage("branch-assistant-1", "BRN01-ANSWER-ONE"),
      userMessage("branch-user-2", "BRN01-BRANCH-HERE"),
    ],
  }]);

  await setMockScript(page, [{ type: "text", text: "BRN01-RUN-ONLY-ON-SOURCE" }]);
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("BRN01-RUN-ONLY-ON-SOURCE")).toBeVisible();

  const branchPoint = page.locator('.message-row[data-message-id="branch-user-2"]');
  await branchPoint.locator("article.chat-message").hover();
  await branchPoint.getByRole("button", { name: "从此处分支" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("branch-source · 分支");
  await expect(page.locator(".message-row").getByText("BRN01-PREFIX-ONE")).toBeVisible();
  await expect(page.locator(".message-row").getByText("BRN01-BRANCH-HERE")).toBeVisible();
  await expect(page.getByText("BRN01-RUN-ONLY-ON-SOURCE")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /选择模型，当前 branch-fixture-model/ })).toBeVisible();

  await openDebugPanel(page, "运行记录");
  await expect(page.getByText("还没有运行记录")).toBeVisible();
  await page.getByRole("button", { name: "关闭调试面板" }).click();
  await page.locator('.session-row[data-session-id="branch-source"] .session-main').click();
  await expect(page.getByText("BRN01-RUN-ONLY-ON-SOURCE")).toBeVisible();
  await expect(page.locator(".message-row").getByText("BRN01-BRANCH-HERE")).toBeVisible();
});

test("BRN-02 工具分支纳入完整调用组，未完成调用会被拒绝", async ({ page }) => {
  await prepareE2eWorkspace(page, [
    {
      id: "completed-tools",
      title: "completed-tools",
      messages: [
        userMessage("complete-user", "BRN02-COMPLETE-PREFIX"),
        { id: "complete-assistant", role: "assistant", content: "检查后分支", enabled: true, toolCalls: [{ id: "complete-call", name: "e2e_mock_tool", arguments: "{\"input\":\"complete\"}" }] },
        { id: "complete-result", role: "tool", content: "BRN02-PAIRED-RESULT", enabled: true, toolCallId: "complete-call", toolName: "e2e_mock_tool" },
      ],
    },
    {
      id: "incomplete-tools",
      title: "incomplete-tools",
      messages: [
        userMessage("incomplete-user", "BRN02-INCOMPLETE-PREFIX"),
        { id: "incomplete-assistant", role: "assistant", content: "尚无工具结果", enabled: true, toolCalls: [{ id: "incomplete-call", name: "e2e_mock_tool", arguments: "{}" }] },
      ],
    },
  ]);

  const completeAssistant = page.locator('.message-row[data-message-id="complete-assistant"]');
  await completeAssistant.hover();
  const completeBranchButton = completeAssistant.getByRole("button", { name: "从此处分支" });
  await expect(completeBranchButton).toBeVisible();
  await completeBranchButton.click();
  await expect(page.getByLabel("会话标题")).toHaveValue("completed-tools · 分支");
  const toolStep = page.locator('[data-tool-name="e2e_mock_tool"]');
  await expect(toolStep).toBeVisible();
  await toolStep.locator("summary").click();
  await expect(page.getByText("BRN02-PAIRED-RESULT")).toBeVisible();
  await expect(page.locator(".message-row").getByText("BRN02-COMPLETE-PREFIX")).toBeVisible();

  await page.locator(".session-row").filter({ hasText: "incomplete-tools" }).locator(".session-main").click();
  const sessionCountBefore = await page.locator(".session-row").count();
  const incompleteAssistant = page.locator('.message-row[data-message-id="incomplete-assistant"]');
  await incompleteAssistant.locator("article.chat-message").hover();
  await incompleteAssistant.getByRole("button", { name: "从此处分支" }).click();
  await expect(page.getByRole("status")).toContainText("未完成的工具调用");
  await expect(page.locator(".session-row")).toHaveCount(sessionCountBefore);
  await expect(page.locator(".session-row").filter({ hasText: "incomplete-tools · 分支" })).toHaveCount(0);
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "BRN02-INCOMPLETE-PREFIX" })).toBeVisible();
});
