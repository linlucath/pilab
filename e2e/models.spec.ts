import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, resetWorkspace, setMockScript, ui } from "./fixtures/index";

const mockedPiCatalog = {
  connected: true,
  provider: "mock-provider",
  defaultModel: "mock-provider/model-a",
  models: [
    { id: "mock-provider/model-a", name: "Mock A", reasoningEfforts: ["off", "low", "high"] },
    { id: "mock-provider/model-b", name: "Mock B", reasoningEfforts: ["low"] },
  ],
};

async function ready(page: Page) {
  await resetWorkspace(page);
  await openWorkspace(page);
  await expect(ui(page).composer).toBeVisible();
}
async function savedWorkspace(page: Page) {
  const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).workspace as { sessions: { id: string; settings: Record<string, unknown> }[]; active: string };
}

 test.beforeEach(async ({ page }) => ready(page));

test("MOD-01 模型和推理档位在 Composer 就近选择并按会话持久化", async ({ page }) => {
  await page.route("**/api/pi-status", (route) => route.fulfill({ json: mockedPiCatalog }));
  await page.reload();

  await page.getByRole("button", { name: /选择模型/ }).click();
  const modelPicker = page.getByRole("dialog", { name: "选择模型" });
  await expect(modelPicker).toBeVisible();
  await modelPicker.getByRole("option", { name: /Mock A/ }).first().click();
  await page.getByRole("button", { name: /推理强度 High/ }).click();
  const effortPicker = page.getByRole("dialog", { name: "选择推理强度" });
  await effortPicker.getByRole("button", { name: "重置推理强度" }).click();
  await expect(page.getByRole("button", { name: /推理强度 High/ })).toBeVisible();
  const effortScale = effortPicker.getByRole("group", { name: "推理强度档位" });
  await expect(effortScale.getByRole("button")).toHaveText(["Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
  await expect(effortScale.getByRole("button", { name: "Minimal" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "Medium" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "XHigh" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "Max" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "Low" })).toBeEnabled();
  await expect(effortScale.getByRole("button", { name: "High", exact: true })).toBeEnabled();
  await effortPicker.getByRole("button", { name: "Low" }).click();
  await expect(page.getByRole("button", { name: /推理强度 Low/ })).toBeVisible();

  await page.locator(".new-conversation").click();
  await expect(page.getByRole("button", { name: /选择模型，当前 antigravity\/gemini-3\.8-flash/ })).toBeVisible();
  await page.getByRole("button", { name: /选择模型/ }).click();
  const secondPicker = page.getByRole("dialog", { name: "选择模型" });
  await secondPicker.getByLabel("搜索模型").fill("Mock B");
  await secondPicker.getByRole("option", { name: /Mock B/ }).click();
  await expect(page.getByRole("button", { name: /选择模型，当前 Mock B/ })).toBeVisible();
  await page.getByRole("button", { name: "推理强度 Low" }).click();
  const modelBEffortPicker = page.getByRole("dialog", { name: "选择推理强度" });
  const modelBEffortScale = modelBEffortPicker.getByRole("group", { name: "推理强度档位" });
  await expect(modelBEffortScale.getByRole("button")).toHaveText(["Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
  await expect(modelBEffortScale.getByRole("button", { name: "Minimal" })).toBeDisabled();
  await expect(modelBEffortScale.getByRole("button", { name: "Low" })).toBeEnabled();
  await expect(modelBEffortScale.getByRole("button", { name: "High", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "推理强度 Low" }).click();

  await expect.poll(async () => {
    const current = await savedWorkspace(page);
    const original = current.sessions.find((session) => session.id !== current.active);
    const active = current.sessions.find((session) => session.id === current.active);
    return original?.settings.model === "mock-provider/model-a" && active?.settings.model === "mock-provider/model-b" && !!original.settings.workingDirectory && !!active.settings.workingDirectory;
  }).toBe(true);
  const workspace = await savedWorkspace(page);
  const original = workspace.sessions.find((session) => session.id !== workspace.active)!;
  const current = workspace.sessions.find((session) => session.id === workspace.active)!;
  expect(original.settings.model).toBe("mock-provider/model-a");
  expect(original.settings.reasoningEffort).toBe("low");
  expect(current.settings.model).toBe("mock-provider/model-b");
  expect(original.settings.workingDirectory).toBeTruthy();
  expect(current.settings.workingDirectory).toBeTruthy();
  expect(original.settings.workingDirectory).not.toBe(current.settings.workingDirectory);

  await page.locator(`.session-row[data-session-id="${original.id}"] .session-main`).click();
  await expect(page.getByRole("button", { name: /选择模型，当前 Mock A/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /推理强度 Low/ })).toBeVisible();
});

test("MOD-02 右侧设置面板和工具关闭开关不存在，Agent 工具始终可用", async ({ page }) => {
  await expect(page.locator(".right-panel, .right-panel-backdrop")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /显示工作台|隐藏工作台|高级设置与调试/ })).toHaveCount(0);
  await expect(page.getByLabel("工具模式")).toHaveCount(0);
  const workspace = await savedWorkspace(page);
  expect(workspace.sessions[0].settings).not.toHaveProperty("toolMode");
  await expect.poll(async () => (await savedWorkspace(page)).sessions.find((session) => session.id === workspace.active)?.settings.workingDirectory).toBeTruthy();

  await setMockScript(page, [{ type: "tool", input: "always-on-tools" }, { type: "text", text: "TOOLS-STILL-AVAILABLE" }]);
  await ui(page).composer.fill("Use the available tool and continue");
  await ui(page).send.click();
  await expect(page.getByText("TOOLS-STILL-AVAILABLE", { exact: true })).toBeVisible();
  await expect(ui(page).stop).toHaveCount(0);
  const toolGroup = page.locator(".tool-group").first();
  await toolGroup.locator(":scope > details > summary").click();
  await expect(toolGroup).toContainText("调用工具 e2e_mock_tool");
  await expect(toolGroup).toContainText("完成");
});
