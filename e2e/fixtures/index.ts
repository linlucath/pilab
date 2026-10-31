import { expect, type Locator, type Page } from "@playwright/test";
import { defaults, type Message, type Settings } from "../../shared/schema";
import type { SavedSession } from "../../shared/workspace";

export type MockToolInvocation = { input?: string; output?: string; delayMs?: number; outputChunkDelayMs?: number; outputError?: boolean };
export type MockScriptStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; delayBeforeMs?: number; chunkSize?: number; thinking?: string; reason?: "stop" | "length" }
  | { type: "tool"; input?: string; assistantText?: string; thinking?: string; output?: string; delayMs?: number; outputChunkDelayMs?: number; outputError?: boolean; calls?: MockToolInvocation[] }
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

export type SeedSession = Omit<Partial<SavedSession>, "id" | "title" | "messages" | "settings"> &
  Pick<SavedSession, "id" | "title" | "messages"> & { settings?: Partial<Settings> };

export async function seedWorkspace(page: Page, sessions: SeedSession[], active = sessions[0]?.id) {
  if (!sessions.length) throw new Error("seedWorkspace requires at least one session");
  if (page.url() !== "about:blank") {
    await page.goto("about:blank");
    const drained = await page.context().request.get(endpoint(page, "/api/workspace"));
    expect(drained.ok(), `workspace drain returned ${drained.status()}`).toBeTruthy();
  }
  await resetWorkspace(page);
  const response = await page.context().request.post(endpoint(page, "/api/workspace"), {
    data: {
      sessions: sessions.map((session) => ({
        ...session,
        settings: { ...defaults, ...session.settings, apiKey: "" },
      })),
      active,
      hiddenPiSessions: [],
      followPi: false,
    },
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

export async function prepareE2eWorkspace(page: Page, sessions: SeedSession[] = []) {
  if (page.url() !== "about:blank") await page.goto("about:blank");
  if (sessions.length) await seedWorkspace(page, sessions);
  else await resetWorkspace(page);
  await openWorkspace(page);
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

export type TestInspectableRun = {
  sessionId: string;
  id: string;
  at: number;
  status: string;
  output: string;
  thinking: string;
  request?: unknown;
  requests?: unknown[];
  trace?: Message[];
  turns?: number;
  usage?: { input: number; output: number };
  elapsed: number;
  error?: string;
  snapshot: { settings: Settings; messages: Message[] };
};
export type TestInspectorSnapshot = {
  activeSessionId: string;
  theme: string;
  compactTools: boolean;
  runs: TestInspectableRun[];
};

export async function inspectTestState(page: Page): Promise<TestInspectorSnapshot> {
  const snapshot = await page.evaluate(() =>
    (window as Window & { __PI_LAB_TEST_INSPECT__?: TestInspectorSnapshot }).__PI_LAB_TEST_INSPECT__);
  if (!snapshot) throw new Error("开发环境未提供 Pi Lab 测试检查契约。");
  return snapshot;
}

export async function latestInspectedRun(page: Page, sessionId?: string) {
  const snapshot = await inspectTestState(page);
  return snapshot.runs
    .filter((run) => !sessionId || run.sessionId === sessionId)
    .sort((left, right) => right.at - left.at)[0];
}

export async function openRequestInspector(page: Page) {
  await expect.poll(async () => {
    const snapshot = await inspectTestState(page);
    const latest = snapshot.runs.filter((run) => run.sessionId === snapshot.activeSessionId).sort((left, right) => right.at - left.at)[0];
    return latest?.requests?.length || (latest?.request ? 1 : 0);
  }).toBeGreaterThan(0);
  const latest = await latestInspectedRun(page, (await inspectTestState(page)).activeSessionId);
  const requests = latest?.requests || (latest?.request ? [latest.request] : []);
  return JSON.stringify(requests, null, 2);
}

export function toolSummary(tool: Locator) { return tool.locator(":scope > summary"); }
