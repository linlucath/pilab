import { mkdir } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eSession, openWorkspace, resetWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";
import type { Message } from "../shared/schema";

const outputDirectory = "artifacts/visual-matrix";

async function ready(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
  await expect(ui(page).composer).toBeVisible();
}

async function saveCard(page: Page, locator: Locator, filename: string) {
  await mkdir(outputDirectory, { recursive: true });
  await locator.screenshot({ path: `${outputDirectory}/${filename}`, animations: "disabled" });
}

function toolMessages({
  sessionId,
  callId,
  toolName = "read",
  arguments: callArguments = "{}",
  result,
  isError = false,
}: {
  sessionId: string;
  callId: string;
  toolName?: string;
  arguments?: string;
  result: string;
  isError?: boolean;
}): Message[] {
  return [
    { id: `${sessionId}-system`, role: "system", content: "You are a careful visual QA assistant.", enabled: true },
    { id: `${sessionId}-user`, role: "user", content: "请检查工具结果卡片的排版与状态。", enabled: true },
    { id: `${sessionId}-assistant`, role: "assistant", content: "", enabled: true, toolCalls: [{ id: callId, name: toolName, arguments: callArguments }] },
    { id: `${sessionId}-result`, role: "tool", content: result, toolCallId: callId, toolName, isError, enabled: true },
  ];
}

async function openSeededGroup(page: Page, messages: Message[], sessionId: string) {
  await seedWorkspace(page, [e2eSession(sessionId, "工具卡片视觉验收", messages)]);
  await openWorkspace(page);
  const group = page.locator(".tool-group").first();
  await expect(group).toBeVisible();
  const details = group.locator(":scope > details");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator(":scope > summary").click();
  return group;
}

test.beforeEach(async ({ page }) => ready(page));

test("VIS-01 运行中工具默认收起原始参数，生成真实运行态截图", async ({ page }) => {
  await setMockScript(page, [{ type: "tool", input: "VIS-01-PRIVATE-RAW-ARGUMENT", delayMs: 4500, output: "工具执行完成。" }]);
  await ui(page).composer.fill("验证运行中的工具状态卡片");
  await ui(page).send.click();

  const group = page.locator('.tool-group[data-step-count="1"]');
  const live = page.locator(".tool-live-call");
  await expect(group).toHaveClass(/is-live/);
  await expect(live).toContainText("正在执行 e2e_mock_tool");
  await expect(live.locator(".tool-live-pulse")).toBeVisible();
  await expect.poll(() => live.locator(".tool-live-pulse").evaluate((element) => getComputedStyle(element).animationName)).toBe("tool-live-pulse");
  await expect(live.locator(".tool-live-arguments")).not.toHaveAttribute("open", "");
  await expect(live.locator(".tool-live-arguments pre")).not.toBeVisible();
  await expect(group.locator(".tool-raw-details")).not.toHaveAttribute("open", "");

  await saveCard(page, live, "case-1-running.png");
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
});

test("VIS-02 单步成功结果置顶、仅一层主折叠且正文为 14px/1.6", async ({ page }) => {
  const sessionId = "visual-single-completed";
  const group = await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-single-call",
    result: "# 执行结果\n\n工具已完成项目结构读取，结果先于原始参数呈现。",
  }), sessionId);
  const step = group.locator(".tool-step");
  const result = step.locator(":scope > .tool-step-body > .tool-readable-block");

  await expect(step.locator(":scope > summary")).toHaveCount(0);
  await expect(group.locator(":scope > details > summary > svg")).toHaveCount(1);
  await expect(result).toBeVisible();
  await expect(result.locator(".markdown-body").locator(":scope > h1")).toHaveText("执行结果");
  const paragraph = result.locator(".markdown-body p");
  await expect.poll(() => paragraph.evaluate((element) => getComputedStyle(element).fontSize)).toBe("14px");
  await expect.poll(() => paragraph.evaluate((element) => {
    const style = getComputedStyle(element);
    return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
  })).toBeCloseTo(1.6, 1);

  await saveCard(page, group, "case-2-single-completed.png");
});

test("VIS-03 工具错误以柔和警示呈现且错误详情易读", async ({ page }) => {
  const sessionId = "visual-tool-error";
  const group = await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-error-call",
    toolName: "bash",
    arguments: JSON.stringify({ command: "npm test" }),
    result: "Error: Permission denied while reading the requested workspace file.\n\n确认工作区路径和文件权限后重试。",
    isError: true,
  }), sessionId);
  const error = group.locator(".tool-readable-block.error");

  await expect(group).toHaveClass(/tool-group--failed/);
  await expect(group.locator(".tool-group-state.error")).toContainText("失败");
  await expect(error).toContainText("Permission denied");
  await expect(error.locator(".markdown-body")).toHaveCSS("font-size", "14px");
  await expect(error).toHaveCSS("border-left-width", "2px");
  await expect(error).toHaveCSS("background-color", /\d+/);

  await saveCard(page, group, "case-3-error.png");
});

test("VIS-04 三步组合明确区分已完成、执行中与待返回，并共享一体化外壳", async ({ page }) => {
  await setMockScript(page, [{
    type: "tool",
    calls: [
      { input: "VIS-04-STEP-ONE", output: "步骤一已完成：扫描项目入口。" },
      { input: "VIS-04-STEP-TWO", delayMs: 4500, output: "步骤二正在读取文件。" },
      { input: "VIS-04-STEP-THREE", output: "步骤三等待执行。" },
    ],
  }]);
  await ui(page).composer.fill("验证连续三步工具调用的生命周期");
  await ui(page).send.click();

  const group = page.locator('.tool-group[data-step-count="3"]');
  await expect(group).toHaveClass(/is-live/);
  const steps = group.locator(".tool-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0).locator(":scope > summary")).toContainText("步骤 1");
  await expect(steps.nth(0).locator(".tool-state.complete")).toHaveText("完成");
  await expect(steps.nth(1).locator(":scope > summary")).toContainText("步骤 2");
  await expect(steps.nth(1).locator(".tool-state.running")).toHaveText("执行中");
  await expect(steps.nth(2).locator(":scope > summary")).toContainText("步骤 3");
  await expect(steps.nth(2).locator(".tool-state.pending")).toHaveText("待返回");
  await expect(steps.nth(0).locator(":scope > .tool-step-body")).toHaveCount(0);
  await expect(steps.nth(1).locator(":scope > .tool-step-body")).toBeVisible();
  await expect(steps.nth(2).locator(":scope > .tool-step-body")).toBeVisible();
  await expect(group.locator(":scope > details")).toHaveCount(1);
  const liveCall = page.locator(".tool-live-call");
  await expect(liveCall).toContainText("正在执行 e2e_mock_tool");
  await expect(liveCall.locator(".tool-live-arguments pre")).not.toBeVisible();

  await saveCard(page, group, "case-4-multistep.png");
  await ui(page).stop.click();
  await expect(ui(page).stop).toHaveCount(0);
});

test("VIS-05 长篇 Markdown 报告标题控制在 15–16px 且代码块保留优雅留白", async ({ page }) => {
  const sessionId = "visual-markdown-report";
  const report = [
    "# 交付报告：工具卡片视觉验收",
    "本轮对九个关键渲染状态进行了浏览器验收，并保留可复核的截图证据。正文层级与工具交付内容保持一致。",
    "## 验收结论",
    "工具轨迹可以折叠查看；成功、运行中和失败状态各自有稳定且克制的强调方式。长段落不会挤压卡片边界。",
    "## 实现摘要",
    "- 将工具步骤归并到一个有边界的时间线容器。",
    "- 将当前活动步骤与未来待返回步骤明确区分。",
    "- 原始调用数据默认收起，交付正文优先展示。",
    "## 关键代码",
    "```tsx",
    "const status = running ? \"执行中\" : result ? \"完成\" : \"待返回\";",
    "return <ToolStepGroup steps={steps} activeCallId={activeCallId} />;",
    "```",
    "## 后续建议",
    "保留真实浏览器截图、状态断言和窄屏溢出检查，确保后续样式调整不会回退已验收的工具交付体验。",
  ].join("\n\n");
  const group = await openSeededGroup(page, toolMessages({ sessionId, callId: "visual-report-call", result: report }), sessionId);
  const result = group.locator(".tool-readable-block");
  const headings = result.locator(".markdown-body h1, .markdown-body h2");
  await expect(headings).toHaveCount(5);
  for (const heading of await headings.all()) {
    const size = Number.parseFloat(await heading.evaluate((element) => getComputedStyle(element).fontSize));
    expect(size, await heading.innerText()).toBeGreaterThanOrEqual(15);
    expect(size, await heading.innerText()).toBeLessThanOrEqual(16);
  }
  await expect(result.locator(".markdown-code pre")).toHaveCSS("padding-left", "14px");
  await expect(result.locator(".markdown-code pre code")).toContainText("ToolStepGroup");

  await saveCard(page, group, "case-5-markdown-report.png");
});

test("VIS-06 Bash 输出使用深色等宽终端微视窗并可滚动查看", async ({ page }) => {
  const sessionId = "visual-bash-terminal";
  const terminalOutput = ["$ npm run test", ...Array.from({ length: 46 }, (_, index) => `✓ test suite ${String(index + 1).padStart(2, "0")} passed · duration 12ms`), "", "All tests passed."].join("\n");
  const result = `\`\`\`bash\n${terminalOutput}\n\`\`\``;
  const group = await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-bash-call",
    toolName: "bash",
    arguments: JSON.stringify({ command: "npm run test" }),
    result,
  }), sessionId);
  const terminal = group.locator(".markdown-code");
  const pre = terminal.locator("pre");

  await expect(terminal.locator(".code-head")).toContainText("bash");
  await expect(pre).toHaveCSS("max-height", "240px");
  await expect(pre).toHaveCSS("overflow-y", "auto");
  await expect(pre.locator("code")).toHaveCSS("font-family", /monospace|Plex Mono/i);
  await expect.poll(() => pre.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(pre).toContainText("All tests passed.");

  await saveCard(page, group, "case-6-bash-terminal.png");
});

test("VIS-07 view_image 结果只显示轻量确认且不会泄露 Base64", async ({ page }) => {
  const sessionId = "visual-view-image";
  const group = await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-view-image-call",
    toolName: "view_image",
    arguments: JSON.stringify({ path: "artifacts/preview.png" }),
    result: "图片已读取并加入本轮模型上下文（PNG，1280 × 720）。",
  }), sessionId);
  const readable = group.locator(".tool-readable-block");
  const visibleText = await readable.innerText();

  await expect(readable).toContainText("图片已读取");
  expect(visibleText).not.toMatch(/data:image\/|;base64,|[A-Za-z0-9+/]{128,}={0,2}/i);
  await expect(group.locator("img")).toHaveCount(0);
  await expect(group.locator(".tool-raw-details")).not.toHaveAttribute("open", "");

  await saveCard(page, group, "case-7-view-image.png");
});

test("VIS-08 暗色主题下工具外壳、状态与结果层级自然", async ({ page }) => {
  const sessionId = "visual-dark-mode";
  await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-dark-call",
    result: "# 暗色结果\n\n深色主题下边界柔和，正文对比清晰，状态色不过度发亮。",
  }), sessionId);
  await page.evaluate(() => localStorage.setItem("pilab-theme-v2", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkGroup = page.locator(".tool-group").first();
  const details = darkGroup.locator(":scope > details");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator(":scope > summary").click();
  await expect.poll(() => page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim())).toBe("#1d1d1d");
  await expect(darkGroup.locator(".tool-readable-block")).toBeVisible();
  await expect(darkGroup.locator(".tool-group-state.complete")).toBeVisible();

  await saveCard(page, darkGroup, "case-8-dark-mode.png");
});

test("VIS-09 375px 窄屏下消息换行自然且页面无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const sessionId = "visual-narrow-viewport";
  const longPath = `路径片段-${"very-long-unbroken-file-name-without-spaces-".repeat(7)}-end`;
  const group = await openSeededGroup(page, toolMessages({
    sessionId,
    callId: "visual-narrow-call",
    result: `# 窄屏检查\n\n这段交付内容在手机宽度下仍应清晰换行，不能撑开页面。\n\n${longPath}`,
  }), sessionId);
  await page.setViewportSize({ width: 375, height: 900 });

  await expect(group.locator(".tool-readable-block")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => group.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await group.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);

  await saveCard(page, group, "case-9-narrow-viewport.png");
});
