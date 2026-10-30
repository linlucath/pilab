import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eSession, openWorkspace, resetWorkspace, seedWorkspace } from "./fixtures/index";
import type { Message } from "../shared/schema";

const screenshotPath = "artifacts/visual-matrix/header-args-refined.png";

async function ready(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
}

test.beforeEach(async ({ page }) => ready(page));

test("TOOL-09 tool headers show concise arguments and dispatch instructions above the result", async ({ page }) => {
  const sessionId = "header-args-refined";
  const prompt = `请梳理主应用的关键交互与工具调用边界，并汇报验证结果。\n\n${Array.from({ length: 18 }, (_, index) => `检查项 ${index + 1}：核对实现调用、参数来源、失败处理和可访问性，避免改变现有行为。`).join("\n\n")}`;
  const calls = [
    { id: "header-read", name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) },
    { id: "header-bash", name: "bash", arguments: JSON.stringify({ command: "npm run test" }) },
    { id: "header-grep", name: "grep", arguments: JSON.stringify({ pattern: "subagent_dispatch" }) },
    { id: "header-find", name: "find", arguments: JSON.stringify({ pattern: "*test*.ts" }) },
    { id: "header-dispatch", name: "subagent_dispatch", arguments: JSON.stringify({ task: { name: "quiet-wait-worker", message: prompt } }) },
  ];
  const messages: Message[] = [
    { id: `${sessionId}-system`, role: "system", content: "You are a careful visual QA assistant.", enabled: true },
    { id: `${sessionId}-user`, role: "user", content: "检查工具标题参数摘要与工兵任务信息的呈现。", enabled: true },
    { id: `${sessionId}-assistant`, role: "assistant", content: "", enabled: true, toolCalls: calls },
    ...calls.map((call, index) => ({
      id: `${sessionId}-result-${index}`,
      role: "tool" as const,
      content: index === calls.length - 1 ? "# 交付结果\n\n已完成调用边界检查与验证。" : `已完成 ${call.name} 检查。`,
      toolCallId: call.id,
      toolName: call.name,
      enabled: true,
    })),
  ];
  await seedWorkspace(page, [e2eSession(sessionId, "工具标题与任务指令", messages)]);
  await openWorkspace(page);

  const group = page.locator('.tool-group[data-message-id="header-args-refined-assistant"]');
  const groupDetails = group.locator(":scope > details");
  if (!(await groupDetails.evaluate((element) => (element as HTMLDetailsElement).open)))
    await groupDetails.locator(":scope > summary").click();

  const steps = group.locator(".tool-step");
  await expect(steps).toHaveCount(5);
  await expect(group.locator(":scope > details > summary")).toContainText("派发任务 · quiet-wait-worker");
  const expected = [
    "步骤 1 · 查阅文件 · src/App.tsx",
    "步骤 2 · 执行命令 · npm run test",
    '步骤 3 · 搜索 "subagent_dispatch"',
    '步骤 4 · 查找文件 "*test*.ts"',
    "步骤 5 · 派发任务 · quiet-wait-worker",
  ];
  for (const [index, title] of expected.entries()) {
    const heading = steps.nth(index).locator(":scope > summary > strong");
    await expect(heading).toHaveText(title);
    await expect(heading).toHaveCSS("white-space", "nowrap");
  }

  const dispatch = steps.nth(4);
  const instruction = dispatch.locator(".tool-task-instruction");
  await expect(instruction.locator(".tool-task-instruction-heading > strong")).toHaveText("任务指令");
  await expect(instruction.locator(".tool-task-instruction-heading > small")).toHaveText("quiet-wait-worker");
  await expect(instruction).toContainText("检查项 1");
  await expect.poll(() => instruction.locator(".tool-task-instruction-content").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(dispatch.locator(".tool-dispatch-result")).toContainText("交付结果");
  const order = await instruction.evaluate((element) => element.compareDocumentPosition(element.parentElement!.querySelector(".tool-dispatch-result")!) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(order).toBeTruthy();

  for (let index = 0; index < 4; index++)
    await steps.nth(index).locator(":scope > summary").click();
  await page.setViewportSize({ width: 1440, height: 1500 });
  await group.evaluate((element) => element.scrollIntoView({ block: "start", inline: "nearest" }));
  await mkdir("artifacts/visual-matrix", { recursive: true });
  await group.screenshot({ path: screenshotPath, animations: "disabled" });
});
