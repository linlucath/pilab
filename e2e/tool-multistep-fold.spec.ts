import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { e2eSession, openWorkspace, resetWorkspace, seedWorkspace } from "./fixtures/index";
import type { Message } from "../shared/schema";

const screenshotPath = "/Users/linlu/Desktop/pi-lab-tool-refactor/artifacts/ui-verification/multistep-compact-timeline.png";

async function ready(page: Page) {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
}

function multiStepMessages(sessionId: string, count: number, longOutput = false, toolNames: string[] = []): Message[] {
  const calls = Array.from({ length: count }, (_, index) => ({
    id: `${sessionId}-call-${index + 1}`,
    name: toolNames[index] || "read",
    arguments: JSON.stringify({ path: `src/review/step-${String(index + 1).padStart(2, "0")}.tsx` }),
  }));
  const outputs = calls.map((call, index) => ({
    id: `${sessionId}-result-${index + 1}`,
    role: "tool" as const,
    content: longOutput
      ? `# 步骤 ${index + 1}：检查结果\n\n${Array.from({ length: 8 }, (_, line) => `已核对第 ${line + 1} 项：实现保留了必要边界，并将验证结论与相关代码位置对应。${" 补充说明用于确认跨组件状态一致。".repeat(2)}`).join("\n\n")}`
      : `# 步骤 ${index + 1}：检查结果\n\n已完成第 ${index + 1} 步检查，输出保留必要上下文和结论。\n\n- 文件：src/review/step-${String(index + 1).padStart(2, "0")}.tsx\n- 状态：通过`,
    enabled: true,
    toolCallId: call.id,
    toolName: call.name,
  }));
  return [
    { id: `${sessionId}-system`, role: "system", content: "You are a careful implementation reviewer.", enabled: true },
    { id: `${sessionId}-user`, role: "user", content: `请检查包含 ${count} 个调用的工具轨迹，并优先呈现最终交付。`, enabled: true },
    { id: `${sessionId}-assistant`, role: "assistant", content: "", enabled: true, toolCalls: calls },
    ...outputs,
  ];
}

async function openGroup(page: Page, sessionId: string, count: number, longOutput = false, toolNames: string[] = []) {
  await seedWorkspace(page, [e2eSession(sessionId, `${count} 步工具轨迹`, multiStepMessages(sessionId, count, longOutput, toolNames))]);
  await openWorkspace(page);
  await page.locator(`.tool-group[data-step-count="${count}"] > details > summary`).click();
  return page.locator(`.tool-group[data-step-count="${count}"]`);
}

test.beforeEach(async ({ page }) => ready(page));

test("TOOL-09 多步工具组标题概括同类操作并缩短混合操作文案", async ({ page }) => {
  const sameKind = await openGroup(page, "smart-title-eight", 8);
  const sameKindTitle = sameKind.locator(":scope > details > summary > strong");
  await expect(sameKindTitle).toHaveText("› 查阅了 8 个相关文件");
  await expect(sameKindTitle).not.toContainText("step-01");

  const mixed = await openGroup(page, "smart-title-mixed", 4, false, ["read", "bash", "read", "bash"]);
  await expect(mixed.locator(":scope > details > summary > strong")).toHaveText("› 执行了 4 个操作步骤");
});

test("TOOL-09 八步轨迹默认只展开最后一步，中间步骤可独立展开并保存验收截图", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1120 });
  const group = await openGroup(page, "smart-fold-eight", 8);
  const steps = group.locator(".tool-step");
  const timeline = group.locator(".tool-timeline-thread");

  await expect(steps).toHaveCount(8);
  for (const [index, step] of (await steps.all()).entries()) {
    const summary = step.locator(":scope > summary");
    await expect(summary).toContainText(`步骤 ${index + 1}`);
    await expect(step.locator(".tool-step-indicator.complete")).toHaveText("✓");
    const summaryBox = await summary.boundingBox();
    expect(summaryBox?.height).toBeGreaterThanOrEqual(32);
    expect(summaryBox?.height).toBeLessThanOrEqual(36);
    await expect.poll(() => step.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(index === 7);
    await expect(step.locator(":scope > .tool-step-body")).toHaveCount(index === 7 ? 1 : 0);
  }
  await expect(timeline).toHaveCSS("max-height", "520px");
  await expect(steps.nth(0).locator(":scope > summary")).toHaveCSS("cursor", "pointer");

  await steps.nth(1).locator(":scope > summary").click();
  await expect(steps.nth(1).locator(":scope > .tool-step-body")).toBeVisible();
  await expect(steps.nth(7).locator(":scope > .tool-step-body")).toBeVisible();
  await steps.nth(4).locator(":scope > summary").click();
  await expect(steps.nth(4).locator(":scope > .tool-step-body")).toBeVisible();
  await expect(steps.nth(1).locator(":scope > .tool-step-body")).toBeVisible();
  await steps.nth(1).locator(":scope > summary").click();
  await expect(steps.nth(1).locator(":scope > .tool-step-body")).toHaveCount(0);
  await expect(steps.nth(4).locator(":scope > .tool-step-body")).toBeVisible();
  await steps.nth(4).locator(":scope > summary").click();
  await expect(steps.nth(4).locator(":scope > .tool-step-body")).toHaveCount(0);

  await mkdir("/Users/linlu/Desktop/pi-lab-tool-refactor/artifacts/ui-verification", { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
});

test("TOOL-09 展开十余步时轨迹限制在内部滚动区域", async ({ page }) => {
  const group = await openGroup(page, "smart-fold-twelve", 12, true);
  const steps = group.locator(".tool-step");
  const timeline = group.locator(".tool-timeline-thread");

  await expect(steps).toHaveCount(12);
  for (const step of await steps.all()) {
    if (!(await step.evaluate((element) => (element as HTMLDetailsElement).open)))
      await step.locator(":scope > summary").click();
  }
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(timeline).toHaveCSS("max-height", "520px");
  await expect(timeline).toHaveCSS("overflow-y", "auto");
  expect(await timeline.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(520);
});
