import { expect, type Locator, type Page } from "@playwright/test";
import { defaults, type Message, type Settings } from "../../shared/schema";

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

export type SeedSession = {
  id: string;
  title: string;
  messages: Message[];
  settings?: Partial<Settings>;
};

export async function seedWorkspace(page: Page, sessions: SeedSession[]) {
  if (!sessions.length) throw new Error("seedWorkspace requires at least one session");
  const response = await page.context().request.post(endpoint(page, "/api/workspace"), {
    data: {
      sessions: sessions.map((session) => ({
        ...session,
        settings: { ...defaults, ...session.settings, apiKey: "" },
      })),
      active: sessions[0].id,
      hiddenPiSessions: [],
      followPi: false,
    },
  });
  expect(response.ok(), `workspace seed rejected: ${await response.text()}`).toBeTruthy();
}

export async function prepareE2eWorkspace(page: Page, sessions: SeedSession[] = []) {
  await openWorkspace(page);
  await resetWorkspace(page);
  if (sessions.length) await seedWorkspace(page, sessions);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const controls = ui(page);
  await controls.composer.fill(text);
  await controls.send.click();
}

export function toolSummary(tool: Locator) { return tool.locator("summary"); }
