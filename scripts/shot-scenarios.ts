import { expect, type Page } from "@playwright/test";
import { openWorkspace, sendMessage, setMockScript, ui, type MockScriptStep } from "../e2e/fixtures/index";

export type ShotScenario = { name: string; run: (page: Page) => Promise<void> };
const showConversation = async (page: Page, script: MockScriptStep[], prompt: string, reply: string) => {
  await openWorkspace(page);
  await setMockScript(page, script);
  await sendMessage(page, prompt);
  await expect(page.getByText(reply)).toBeVisible();
};

export const shotScenarios: ShotScenario[] = [
  { name: "empty-workspace", run: openWorkspace },
  {
    name: "conversation",
    run: (page) => showConversation(page, [{ type: "text", text: "一个稳定的模拟回答，用于评审正文排版和消息间距。" }], "展示一段对话", "一个稳定的模拟回答，用于评审正文排版和消息间距。"),
  },
  {
    name: "streaming-output",
    run: async (page) => {
      await openWorkspace(page);
      await setMockScript(page, [{ type: "slow", text: "STREAMING-PREVIEW: 这段文字仍在流式生成中。" + "继续输出。".repeat(120), chunkSize: 22, delayMs: 450 }]);
      await sendMessage(page, "显示流式状态");
      await expect(page.getByText(/STREAMING-PREVIEW/)).toBeVisible();
    },
  },
  {
    name: "tool-call-expanded",
    run: async (page) => {
      await openWorkspace(page);
      await setMockScript(page, [{ type: "tool", input: "shot-review" }, { type: "text", text: "工具调用后续回复" }]);
      await sendMessage(page, "显示工具步骤");
      const group = page.locator(".tool-group > details");
      await expect(group).toBeVisible();
      await group.locator(":scope > summary").click();
      const step = ui(page).tool();
      await expect(step).toBeVisible();
      await step.locator("summary").click();
      await expect(page.getByText("Mock tool result: shot-review")).toBeVisible();
    },
  },
  {
    name: "error-state",
    run: async (page) => {
      await openWorkspace(page);
      await setMockScript(page, [{ type: "error", message: "SHOT-SCRIPTED-ERROR" }]);
      await sendMessage(page, "触发模拟错误");
      await expect(page.getByRole("alert")).toContainText("SHOT-SCRIPTED-ERROR");
    },
  },
  {
    name: "narrow-window",
    run: async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openWorkspace(page);
    },
  },
];
