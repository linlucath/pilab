import { expect, type Locator, type Page } from "@playwright/test";

export type MockScriptStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; delayBeforeMs?: number; chunkSize?: number; thinking?: string; reason?: "stop" | "length" }
  | { type: "tool"; input?: string; assistantText?: string; thinking?: string; output?: string; delayMs?: number; outputChunkDelayMs?: number; outputError?: boolean }
  | { type: "error"; message?: string };

const serverOrigin = () => `http://127.0.0.1:${process.env.PI_LAB_E2E_PORT || "3100"}`;
const endpoint = (page: Page, pathname: string) => new URL(pathname, page.url() === "about:blank" ? serverOrigin() : page.url()).href;

export async function resetWorkspace(page: Page) {
  const response = await page.context().request.post(endpoint(page, "/api/e2e/reset"));
  expect(response.ok(), `reset endpoint returned ${response.status()}`).toBeTruthy();
}

export async function setMockScript(page: Page, script: MockScriptStep[]) {
  const response = await page.context().request.put(endpoint(page, "/api/e2e/mock"), { data: { script } });
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
  await page.goto(`${serverOrigin()}/`);
  await expect(ui(page).composer).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const controls = ui(page);
  await controls.composer.fill(text);
  await controls.send.click();
}

export async function addMessage(page: Page, role: "user" | "assistant" | "system", text: string) {
  await page.getByRole("combobox", { name: "新消息角色" }).selectOption(role);
  await ui(page).composer.fill(text);
  await page.getByRole("button", { name: "仅添加" }).click();
  await expect(page.locator(".message-row").filter({ hasText: text })).toBeVisible();
}

export async function openRightPanel(page: Page) {
  const show = page.getByRole("button", { name: "显示工作台" });
  if (await show.count()) await show.click();
  await expect(page.getByRole("complementary", { name: "工作台配置" })).toBeVisible();
}

export async function openAdvanced(page: Page) {
  await openRightPanel(page);
  const toggle = page.getByRole("button", { name: /高级设置与调试/ });
  if (!(await page.locator("#protocol").count())) await toggle.click();
  await expect(page.locator("#protocol")).toBeVisible();
}

export async function openRequestInspector(page: Page) {
  await page.locator(".debug-menu > summary").click();
  await page.getByRole("button", { name: "请求检查" }).click();
  await expect(page.getByRole("dialog", { name: "请求检查" })).toBeVisible();
}

export function toolSummary(tool: Locator) { return tool.locator("summary"); }
