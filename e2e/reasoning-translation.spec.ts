import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { e2eSession, openWorkspace, seedWorkspace } from "./fixtures/index";

const englishParagraphs = [
  "First, I should separate observed facts from assumptions. The existing implementation already supports an expandable reasoning view, so the screenshot should demonstrate that real interface rather than a fabricated mock-up.",
  "Next, I will preserve the original sequence and place each Chinese translation immediately after its English paragraph. This makes the source and its meaning easy to compare at a glance.",
];
const translations = [
  "首先，我应把已观察到的事实与推测区分开来。现有实现已经支持展开查看思考过程，因此截图应展示真实界面，而不是拼造的静态效果。",
  "接下来，我会保留原有顺序，让每段中文译文紧随对应的英文段落。这样一眼就能对照原文与含义。",
];
const thoughtText = englishParagraphs.join("\n\n");

test("REASONING-01 展开思考过程后逐段显示自动中译", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await seedWorkspace(page, [e2eSession("reasoning-translation", "Reasoning translation", [
    { id: "translation-user", role: "user", content: "请检查这项实现，并简要说明思路。", enabled: true },
    {
      id: "translation-assistant", role: "assistant", content: "我已完成检查，关键思路如下。", enabled: true,
      providerState: {
        api: "openai-completions", provider: "fixture", model: "fixture-model",
        thinking: [{ type: "thinking", thinking: thoughtText }],
      },
    },
  ])]);
  const translationBatches: string[][] = [];
  await page.route("**/api/translate", async (route) => {
    const body = route.request().postDataJSON() as { texts: string[]; targetLanguage: string };
    translationBatches.push(body.texts);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ translations: body.texts.map((_, index) => translations[index]) }),
    });
  });
  await openWorkspace(page);

  const accordion = page.locator(".thinking-accordion");
  await expect(accordion).toBeVisible();
  await expect(accordion.locator(".thinking-paragraph")).toHaveCount(2);
  await expect(accordion.locator(".thinking-translation-content")).toBeHidden();
  await expect(accordion.locator(".thinking-translation-cn")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(translationBatches).toHaveLength(0);

  await accordion.locator(":scope > summary").click();
  await expect(accordion.locator(".thinking-paragraph")).toHaveCount(2);
  await expect(accordion.locator(".thinking-original").nth(0)).toHaveText(englishParagraphs[0]);
  await expect(accordion.locator(".thinking-translation-cn").nth(0)).toContainText(translations[0]);
  await expect(accordion.locator(".thinking-original").nth(1)).toHaveText(englishParagraphs[1]);
  await expect(accordion.locator(".thinking-translation-cn").nth(1)).toContainText(translations[1]);
  await expect(accordion.locator(".thinking-translation-cn")).toHaveCount(2);
  await expect(accordion.locator(".thinking-translation-cn").nth(0)).toContainText(translations[0]);
  await expect(accordion.locator(".thinking-translation-cn").nth(1)).toContainText(translations[1]);
  expect(translationBatches).toEqual([englishParagraphs]);

  await mkdir("artifacts/shots", { recursive: true });
  await page.screenshot({ path: "artifacts/shots/reasoning_translation.png", clip: { x: 380, y: 145, width: 900, height: 370 } });
  await page.screenshot({ path: "artifacts/shots/reasoning_translation_full.png", fullPage: true });
});
