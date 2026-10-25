import { expect, type Locator, type Page } from "@playwright/test";
import { defaults, type Message, type Settings } from "../../shared/schema";
import type { SavedSession } from "../../shared/workspace";

export type MockScriptStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; chunkSize?: number }
  | { type: "tool"; input?: string }
  | { type: "error"; message?: string };

const serverOrigin = () => `http://127.0.0.1:${process.env.PI_LAB_E2E_PORT || "3100"}`;
const endpoint = (page: Page, pathname: string) => new URL(pathname, page.url() === "about:blank" ? serverOrigin() : page.url()).href;

export async function resetWorkspace(page: Page) {
  const response = await page.context().request.post(endpoint(page, "/api/e2e/reset"));
  expect(response.ok(), `reset endpoint returned ${response.status()}`).toBeTruthy();
}

export function e2eSession(id: string, title: string, messages: Message[], settings: Partial<Settings> = {}): SavedSession {
  return { id, title, settings: { ...defaults, ...settings }, messages };
}

export async function seedWorkspace(page: Page, sessions: SavedSession[], active = sessions[0]?.id) {
  if (page.url() !== "about:blank") {
    await page.goto("about:blank");
    const drained = await page.context().request.get(endpoint(page, "/api/workspace"));
    expect(drained.ok(), `workspace drain returned ${drained.status()}`).toBeTruthy();
  }
  await resetWorkspace(page);
  const response = await page.context().request.post(endpoint(page, "/api/workspace"), {
    data: { sessions, active, hiddenPiSessions: [], followPi: false },
  });
  expect(response.ok(), `workspace seed returned ${response.status()}: ${await response.text()}`).toBeTruthy();
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

export function toolSummary(tool: Locator) { return tool.locator("summary"); }
