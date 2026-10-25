import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { addMessage, openAdvanced, openRequestInspector, openWorkspace, resetWorkspace, setMockScript, ui } from "./fixtures/index";

const ready = async (page: import("@playwright/test").Page) => {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
};
const openDebugMenu = async (page: import("@playwright/test").Page, item: string) => {
  await page.getByRole("button", { name: "打开调试工具" }).click();
  await page.getByRole("button", { name: item }).click();
};

const mockedPiCatalog = {
  connected: true,
  provider: "mock-provider",
  defaultModel: "mock-provider/model-a",
  models: [
    { id: "mock-provider/model-a", name: "Mock A", reasoningEfforts: ["low", "high"] },
    { id: "mock-provider/model-b", name: "Mock B", reasoningEfforts: ["low"] },
  ],
};

test.beforeEach(async ({ page }) => ready(page));

test("MOD-01 协议、模型和历史按会话分别保存，Pi 模型目录可选", async ({ page }) => {
  await page.route("**/api/pi-status", (route) => route.fulfill({ json: mockedPiCatalog }));
  await page.reload();
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("anthropic-messages");
  await page.locator("#main-model").fill("alpha-model");
  await page.getByLabel("会话标题").fill("Alpha 会话");
  await addMessage(page, "user", "ALPHA-HISTORY-UNCHANGED");

  await page.locator(".new-conversation").click();
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("openai-responses");
  await page.locator("#main-model").fill("beta-model");
  await expect(page.locator("#main-model")).toHaveValue("beta-model");
  await page.locator(".session-row").filter({ hasText: "Alpha 会话" }).getByRole("button").first().click();
  await openAdvanced(page);
  await expect(page.locator("#protocol")).toHaveValue("anthropic-messages");
  await expect(page.locator("#main-model")).toHaveValue("alpha-model");
  await expect(page.locator(".message-row").filter({ hasText: "ALPHA-HISTORY-UNCHANGED" })).toBeVisible();

  await setMockScript(page, [{ type: "text", text: "ALPHA-REPLY" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("ALPHA-REPLY", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openRequestInspector(page);
  const inspector = await page.getByRole("dialog", { name: "请求检查" }).innerText();
  expect(inspector).toContain("alpha-model");
  expect(inspector).toContain("anthropic-messages");
  expect(inspector).toContain("ALPHA-HISTORY-UNCHANGED");

  await page.getByRole("button", { name: "关闭调试面板" }).click();
  await page.locator(".new-conversation").click();
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("pi-subscription");
  await expect(page.locator("#main-model")).toHaveValue("mock-provider/model-a");
  await expect(page.locator("#main-model")).toContainText("Mock A");
  await page.locator("#main-model").selectOption("mock-provider/model-b");
  await expect(page.locator("#main-model")).toHaveValue("mock-provider/model-b");
});

test("MOD-02 已开启推理时请求不携带 Temperature，档位受 mock 模型目录限制", async ({ page }) => {
  await page.route("**/api/pi-status", (route) => route.fulfill({ json: mockedPiCatalog }));
  await page.reload();
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("pi-subscription");
  await page.locator("#main-model").selectOption("mock-provider/model-a");
  await page.getByRole("button", { name: "High" }).click();
  await addMessage(page, "user", "MOD02-REASONING-CONTEXT");
  await expect(page.locator("#temperature")).toBeDisabled();
  await setMockScript(page, [{ type: "text", text: "REASONING-PARAMETERS-CHECK" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("REASONING-PARAMETERS-CHECK", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openRequestInspector(page);
  const requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("mock-provider/model-a");
  expect(requestText).not.toMatch(/\"temperature\"\s*:/);
});

test.fixme("MOD-02 关闭 reasoning 后可设置 Temperature，并在切换不支持档位的模型时自动调整并提示", async ({ page }) => {
  // ISSUE-200: 模型工作台没有 reasoning=off 入口，也没有在切换到低能力模型时修正已选档位。
  await openAdvanced(page);
  await page.getByRole("button", { name: "Off" }).click();
  await expect(page.locator("#temperature")).toBeEnabled();
  await page.locator("#temperature").fill("1.25");
  await addMessage(page, "user", "TEMPERATURE-CHECK");
  await setMockScript(page, [{ type: "text", text: "OFF-REASONING" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("OFF-REASONING", { exact: true })).toBeVisible();
  await openRequestInspector(page);
  expect(await page.locator(".request-turn pre").innerText()).toContain("1.25");
});

test("MOD-03 页面 API Key 不进入检查面板、持久化工作区或导出文件，刷新后清空", async ({ page }) => {
  const secret = "e2e-page-key-do-not-persist";
  const savedBodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/workspace/changes") && request.postData()) savedBodies.push(request.postData()!);
  });
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("openai-completions");
  await page.locator("#api-key").fill(secret);
  await addMessage(page, "user", "KEY-PRIORITY-MOCK-CHECK");
  await setMockScript(page, [{ type: "text", text: "KEY-TEST-REPLY" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("KEY-TEST-REPLY", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openRequestInspector(page);
  const inspectorText = await page.getByRole("dialog", { name: "请求检查" }).innerText();
  expect(inspectorText).not.toContain(secret);
  expect(inspectorText).not.toContain("Authorization");
  expect(await page.evaluate(() => Object.values(localStorage).join("\n"))).not.toContain(secret);
  expect(savedBodies.join("\n")).not.toContain(secret);

  await page.getByRole("button", { name: "关闭调试面板" }).click();
  await openAdvanced(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出会话 JSON" }).click(),
  ]);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const exported = await readFile(filePath!, "utf8");
  expect(exported).not.toContain(secret);
  await page.reload();
  await openAdvanced(page);
  await expect(page.locator("#api-key")).toHaveValue("");
});

test("MOD-04 Anthropic 对 Developer 和非开头 System 明确拒绝，不改写历史", async ({ page }) => {
  await addMessage(page, "user", "MOD04-VALID-USER");
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("anthropic-messages");
  await page.getByRole("button", { name: "展开 / 编辑" }).click();
  await page.getByRole("button", { name: "添加 Developer" }).click();
  await setMockScript(page, [{ type: "text", text: "SHOULD-RUN-AFTER-FIX" }]);
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("Anthropic 不支持独立的 developer 角色");
  await expect(page.locator(".system-message-edit").nth(1).locator(".system-message-meta")).toContainText("developer");
  await page.locator("#protocol").selectOption("openai-completions");
  await page.locator("button.run-current").click();
  await expect(page.getByText("SHOULD-RUN-AFTER-FIX", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await page.locator(".system-message-edit").nth(1).getByRole("button", { name: "删除人设消息" }).click();

  await page.getByRole("combobox", { name: "新消息角色" }).selectOption("system");
  await ui(page).composer.fill("LATE-SYSTEM-INSTRUCTION");
  await page.getByRole("button", { name: "仅添加" }).click();
  await page.locator("#protocol").selectOption("anthropic-messages");
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("Anthropic 的 system 指令必须位于对话开头");
  await expect(page.getByText("LATE-SYSTEM-INSTRUCTION", { exact: true })).toBeVisible();
});

test("MOD-04 Pi subscription 也拒绝被放在对话之后的 System", async ({ page }) => {
  await addMessage(page, "user", "MOD04-PI-USER");
  await addMessage(page, "system", "LATE-PI-SYSTEM");
  await openAdvanced(page);
  await page.locator("#protocol").selectOption("pi-subscription");
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("Pi 订阅要求 system 指令位于开头");
  await expect(page.getByText("LATE-PI-SYSTEM", { exact: true })).toBeVisible();
});

test("MOD-05 输出上限和 Agent 轮数接受边界值并拒绝越界配置", async ({ page }) => {
  await openAdvanced(page);
  const maxTokens = page.locator("#max-tokens");
  const maxTurns = page.locator("#max-turns");
  await maxTokens.fill("1");
  await expect(maxTokens).toHaveValue("1");
  await maxTokens.fill("128000");
  await expect(maxTokens).toHaveValue("128000");
  await maxTurns.fill("1");
  await expect(maxTurns).toHaveValue("1");
  await maxTurns.fill("50");
  await expect(maxTurns).toHaveValue("50");
  await maxTokens.fill("0");
  await expect(maxTokens).toHaveValue("0");
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("配置无效");
  await maxTokens.fill("1");
  await maxTurns.fill("51");
  await expect(maxTurns).toHaveValue("51");
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("配置无效");
});

test("MOD-06 关闭工具模式仍回放已存在的完整工具历史，但不声明或执行新工具", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "historical-call" }, { type: "text", text: "INITIAL-TOOL-CYCLE" }]);
  await ui(page).composer.fill("Create a mock tool history");
  await ui(page).send.click();
  await expect(page.getByText("INITIAL-TOOL-CYCLE", { exact: true })).toBeVisible();
  await openAdvanced(page);
  await page.getByRole("button", { name: "关闭" }).click();
  await setMockScript(page, [{ type: "text", text: "TOOLS-OFF-REPLAY" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("TOOLS-OFF-REPLAY", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  await openRequestInspector(page);
  const requestText = await page.locator(".request-turn pre").innerText();
  expect(requestText).toContain("e2e_mock_tool");
  expect(requestText).toContain("Mock tool result: historical-call");
  expect(requestText).not.toContain("toolsAdded");
});

test("MOD-07 有效绝对目录可用于 Agent；关闭工具模式不校验无效本机路径", async ({ page }) => {
  await addMessage(page, "user", "MOD07-VALID-CONTEXT");
  await openAdvanced(page);
  const directory = await page.evaluate(async () => (await (await fetch("/api/health")).json()).workingDirectory as string);
  await page.locator("#working-directory").fill(directory);
  await setMockScript(page, [{ type: "text", text: "VALID-CWD-RUN" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("VALID-CWD-RUN", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);

  await page.locator("#working-directory").fill("");
  await setMockScript(page, [{ type: "text", text: "DEFAULT-CWD-RUN" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("DEFAULT-CWD-RUN", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);

  await page.locator("#working-directory").fill("relative/missing-directory");
  await setMockScript(page, [{ type: "text", text: "INVALID-CWD-MUST-NOT-RUN" }]);
  await page.locator("button.run-current").click();
  await expect(ui(page).alerts).toContainText("工具工作目录必须是存在的绝对路径目录");
  await expect(page.getByText("INVALID-CWD-MUST-NOT-RUN", { exact: true })).toHaveCount(0);

  await page.locator(".mode-segment").getByRole("button", { name: "关闭", exact: true }).click();
  await setMockScript(page, [{ type: "text", text: "TOOLS-OFF-INVALID-CWD-OK" }]);
  await page.locator("button.run-current").click();
  await expect(page.getByText("TOOLS-OFF-INVALID-CWD-OK", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
});

test("MOD-08 上下文 token 估算随消息排除及工具参数精简变化", async ({ page }) => {
  await addMessage(page, "user", "token-check-" + "long-context ".repeat(160));
  const count = page.locator(".context-count");
  await expect(count).toContainText(/tokens/);
  const before = await count.innerText();
  const row = page.locator(".message-row").filter({ hasText: "token-check-" });
  await row.locator("article").hover();
  await row.getByRole("button", { name: "排除上下文" }).click();
  await expect(row.locator("article")).toHaveClass(/excluded/);
  await expect.poll(async () => count.innerText()).not.toBe(before);

  await setMockScript(page, [{ type: "tool", input: "parameter-" + "value ".repeat(90) }, { type: "text", text: "TOKEN-TOOL-READY" }]);
  await page.locator(".context-count").waitFor();
  await page.getByRole("button", { name: "包含上下文" }).click().catch(async () => {
    const excluded = page.locator(".message-row").filter({ hasText: "token-check-" });
    await excluded.locator("article").hover();
    await excluded.getByRole("button", { name: "包含上下文" }).click();
  });
  await ui(page).composer.fill("Run a tool context estimate");
  await ui(page).send.click();
  await expect(page.getByText("TOKEN-TOOL-READY", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  const withTool = await count.innerText();
  expect(withTool).toMatch(/tokens/);
  expect(withTool).not.toBe(before);

  const toolGroup = page.locator(".tool-group").first();
  await toolGroup.hover();
  await toolGroup.getByRole("button", { name: /精简/ }).click();
  await expect(toolGroup).toContainText("已精简上下文");
  await expect.poll(() => count.innerText()).not.toBe(withTool);
  await expect(count).toContainText(/已省 \d+%/);
});
