import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openWorkspace, resetWorkspace } from "./fixtures/index";

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const piStatus = {
  connected: true,
  subagentConnected: true,
  provider: "antigravity",
  defaultModel: "antigravity/gemini-3.8-flash",
  models: [{
    id: "antigravity/gemini-3.8-flash",
    name: "Gemini 3.8 Flash · antigravity",
    reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }],
  subagentModels: [
    { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai-codex", reasoningEfforts: ["off", "low", "high", "max"] },
    { id: "openai-codex/no-thinking", name: "No Thinking Model", provider: "openai-codex", reasoningEfforts: ["off"] },
  ],
};

test("MOD-10 工兵推理档位独立选择、联动并按会话持久化", async ({ page }) => {
  await page.route("**/api/pi-status", (route) => route.fulfill({ json: piStatus }));
  await resetWorkspace(page);
  await openWorkspace(page);

  const workerEffortButton = page.getByRole("button", { name: "工兵推理强度 Max" });
  await expect(workerEffortButton).toBeVisible();
  await expect(page.getByRole("button", { name: "推理强度 High" })).toBeVisible();
  await workerEffortButton.click();
  const picker = page.getByRole("dialog", { name: "选择工兵推理强度" });
  await expect(picker).toBeVisible();
  const effortScale = picker.getByRole("group", { name: "工兵推理强度档位" });
  await expect(effortScale.getByRole("button")).toHaveText(["Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
  await expect(effortScale.getByRole("button", { name: "Minimal" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "Medium" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "XHigh" })).toBeDisabled();
  await expect(effortScale.getByRole("button", { name: "Low" })).toBeEnabled();
  await expect(effortScale.getByRole("button", { name: "Max" })).toBeEnabled();

  const screenshot = path.resolve("artifacts/diagnostics/subagent-thinking-final.png");
  await mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 900 });
  const narrowPickerBounds = await picker.boundingBox();
  expect(narrowPickerBounds?.x).toBeGreaterThanOrEqual(12);
  expect((narrowPickerBounds?.x || 0) + (narrowPickerBounds?.width || 0)).toBeLessThanOrEqual(378);
  await page.setViewportSize({ width: 1600, height: 1000 });

  await effortScale.getByRole("button", { name: "High", exact: true }).click();
  await expect(page.getByRole("button", { name: "工兵推理强度 High" })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
    const workspace = (await response.json()).workspace as { sessions: { id: string; settings: Record<string, unknown> }[]; active: string };
    return workspace.sessions.find((session) => session.id === workspace.active)?.settings.defaultSubagentThinkingLevel;
  }).toBe("high");

  await page.getByRole("button", { name: /工兵模型.*gpt-6-luna/ }).click();
  const modelPicker = page.getByRole("dialog", { name: "选择工兵模型" });
  await modelPicker.getByRole("option", { name: /No Thinking Model/ }).click();
  await expect(page.getByRole("button", { name: "工兵推理强度 Off" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /不支持 High 推理强度/ })).toBeVisible();
  await page.getByRole("button", { name: "工兵推理强度 Off" }).click();
  const noThinkingScale = page.getByRole("dialog", { name: "选择工兵推理强度" }).getByRole("group", { name: "工兵推理强度档位" });
  await expect(noThinkingScale.getByRole("button", { name: "Off" })).toBeEnabled();
  for (const level of ["Minimal", "Low", "Medium", "High", "XHigh", "Max"])
    await expect(noThinkingScale.getByRole("button", { name: level, exact: true })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("button", { name: /工兵模型.*openai-codex\/no-thinking/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "工兵推理强度 Off" })).toBeVisible();
  const saved = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  const workspace = (await saved.json()).workspace as { sessions: { id: string; settings: Record<string, unknown> }[]; active: string };
  const settings = workspace.sessions.find((session) => session.id === workspace.active)?.settings;
  expect(settings?.defaultSubagentThinkingLevel).toBe("off");
});
