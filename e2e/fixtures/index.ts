import { expect, type Locator, type Page } from "@playwright/test";

export type MockScriptStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; chunkSize?: number }
  | { type: "tool"; input?: string }
  | { type: "error"; message?: string };

export async function resetWorkspace(page: Page) {
  const response = await page.context().request.post("http://127.0.0.1:3100/api/e2e/reset");
  expect(response.ok(), `reset endpoint returned ${response.status()}`).toBeTruthy();
}

export async function setMockScript(page: Page, script: MockScriptStep[]) {
  const response = await page.context().request.put("http://127.0.0.1:3100/api/e2e/mock", { data: { script } });
  expect(response.ok(), `mock script rejected: ${await response.text()}`).toBeTruthy();
}

export function ui(page: Page) {
  return {
    composer: page.getByRole("textbox", { name: "撰写新消息" }),
    send: page.getByRole("button", { name: "发送" }),
    stop: page.getByRole("button", { name: "停止" }),
    messages: page.locator(".message-row"),
    assistantMessages: page.locator("article.chat-message.assistant"),
    alerts: page.getByRole("alert"),
    tool: (name = "e2e_mock_tool") => page.locator(`[data-tool-name="${name}"]`),
  };
}

export async function openWorkspace(page: Page) {
  await page.goto("http://127.0.0.1:3100/");
  await expect(ui(page).composer).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const controls = ui(page);
  await controls.composer.fill(text);
  await controls.send.click();
}

export function toolSummary(tool: Locator) { return tool.locator("summary"); }
