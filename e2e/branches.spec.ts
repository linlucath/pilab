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
  await expect(page.getByLabel("主模型")).toHaveValue("branch-fixture-model");

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

test("BRN-03 手动提纯校验必填项、默认不带近期对话并按选择携带普通轮次", async ({ page }) => {
  await prepareE2eWorkspace(page, [{
    id: "manual-fork-source",
    title: "manual-fork-source",
    settings: { ...sessionSettings, toolMode: "none" },
    messages: [
      { id: "fork-system", role: "system", content: "BRN03-SYSTEM-PROMPT", enabled: true },
      { id: "fork-developer", role: "developer", content: "BRN03-DEVELOPER-PROMPT", enabled: true },
      userMessage("fork-user-1", "BRN03-OLD-USER"),
      assistantMessage("fork-assistant-1", "BRN03-OLD-ANSWER"),
      userMessage("fork-user-2", "BRN03-RECENT-USER"),
      assistantMessage("fork-assistant-2", "BRN03-RECENT-ANSWER"),
      { id: "fork-tool-assistant", role: "assistant", content: "工具步骤不作为普通近期对话", enabled: true, toolCalls: [{ id: "fork-tool-call", name: "e2e_mock_tool", arguments: "{}" }] },
      { id: "fork-tool-result", role: "tool", content: "BRN03-TOOL-RESULT", enabled: true, toolCallId: "fork-tool-call", toolName: "e2e_mock_tool" },
    ],
  }]);

  const openFork = async () => page.getByRole("button", { name: "提纯分身" }).click();
  await openFork();
  const modal = page.getByRole("dialog", { name: "提纯会话分身" });
  const title = modal.getByLabel("新分身名称");
  const memory = modal.locator("textarea");
  const create = modal.getByRole("button", { name: "即刻创建并切换" });
  const recentTurns = modal.locator(".fork-carry-row select");
  await expect(recentTurns).toHaveValue("0");
  await expect(create).toBeDisabled();
  await title.fill("   ");
  await memory.fill("   ");
  await expect(create).toBeDisabled();
  await modal.getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".session-row")).toHaveCount(1);

  await openFork();
  await modal.getByLabel("新分身名称").fill("manual-fork-clean");
  await modal.locator("textarea").fill("BRN03-MEMORY-CRYSTAL");
  await modal.getByRole("button", { name: "即刻创建并切换" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("manual-fork-clean");
  await expect(page.getByText("BRN03-MEMORY-CRYSTAL", { exact: true })).toBeVisible();
  await expect(page.locator(".system-banner")).toContainText("BRN03-SYSTEM-PROMPT");
  await expect(page.locator(".system-banner")).toContainText("BRN03-DEVELOPER-PROMPT");
  await expect(page.getByText("BRN03-OLD-USER")).toHaveCount(0);
  await expect(page.getByText("BRN03-RECENT-USER")).toHaveCount(0);
  await expect(page.getByText("BRN03-TOOL-RESULT")).toHaveCount(0);

  await page.getByRole("button", { name: "查看原会话" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("manual-fork-source");
  await page.getByRole("button", { name: "提纯分身" }).click();
  const recentModal = page.getByRole("dialog", { name: "提纯会话分身" });
  await recentModal.getByLabel("新分身名称").fill("manual-fork-recent");
  await recentModal.locator("textarea").fill("BRN03-RECENT-MEMORY");
  await recentModal.locator(".fork-carry-row select").selectOption("1");
  await recentModal.getByRole("button", { name: "即刻创建并切换" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("manual-fork-recent");
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "BRN03-RECENT-USER" })).toBeVisible();
  await expect(page.locator(".message-row--assistant-editorial p").filter({ hasText: "BRN03-RECENT-ANSWER" })).toBeVisible();
  await expect(page.getByText("BRN03-OLD-USER")).toHaveCount(0);
  await expect(page.getByText("BRN03-TOOL-RESULT")).toHaveCount(0);
});

test("BRN-05 分身与来源往返切换保留正确谱系和记忆且不触发运行", async ({ page }) => {
  await prepareE2eWorkspace(page, [{
    id: "roundtrip-source",
    title: "roundtrip-source",
    settings: { toolMode: "none" },
    messages: [userMessage("roundtrip-user", "BRN05-SOURCE-MESSAGE")],
  }]);

  await page.getByRole("button", { name: "提纯分身" }).click();
  const modal = page.getByRole("dialog", { name: "提纯会话分身" });
  await modal.getByLabel("新分身名称").fill("roundtrip-fork");
  await modal.locator("textarea").fill("BRN05-SOURCE-MEMORY");
  await modal.getByRole("button", { name: "即刻创建并切换" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("roundtrip-fork");
  await expect(page.getByText("BRN05-SOURCE-MEMORY", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "查看原会话" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("roundtrip-source");
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "BRN05-SOURCE-MESSAGE" })).toBeVisible();
  await page.getByRole("button", { name: "立即切换到新分身" }).click();
  await expect(page.getByLabel("会话标题")).toHaveValue("roundtrip-fork");
  await expect(page.getByText("BRN05-SOURCE-MEMORY", { exact: true })).toBeVisible();

  const logsResponse = await page.context().request.get(new URL("/api/logs?category=run", page.url()).href);
  const { logs } = await logsResponse.json() as { logs: { event: string }[] };
  expect(logs.filter((entry) => entry.event === "run_started")).toHaveLength(0);
});
