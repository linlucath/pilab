import { expect, test } from "@playwright/test";
import { openWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";

test("LAY-06 长会话在流式更新期间渲染历史并限制消息行视口外布局", async ({ page }) => {
  const sessionId = "long-session-performance";
  const messages = [
    { id: "perf-user", role: "user" as const, content: "PERF-INITIAL-PROMPT", enabled: true },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `perf-history-${index}`,
      role: "assistant" as const,
      content: `PERF-HISTORY-${index} ${"historical markdown content ".repeat(18)}`,
      enabled: true,
    })),
  ];
  await seedWorkspace(page, [{ id: sessionId, title: "Long session performance", messages }], sessionId);
  await openWorkspace(page);
  await expect(page.locator('[data-message-id="perf-history-119"]')).toBeVisible();

  const rowStyles = await page.locator('[data-message-id="perf-history-0"]').evaluate((row) => {
    const style = getComputedStyle(row);
    return { visibility: style.contentVisibility, intrinsicSize: style.containIntrinsicSize };
  });
  expect(rowStyles.visibility).toBe("auto");
  expect(rowStyles.intrinsicSize).toContain("90px");

  await setMockScript(page, [{ type: "slow", text: `PERF-STREAM-${"incremental token ".repeat(80)}`, chunkSize: 2, delayMs: 5 }]);
  await page.evaluate(() => {
    const testWindow = window as Window & { __perfStreamMutations?: number; __perfStreamObserver?: MutationObserver };
    testWindow.__perfStreamMutations = 0;
    testWindow.__perfStreamObserver = new MutationObserver((records) => {
      const changedStreamMessage = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return !!target?.closest("article.chat-message.assistant")?.textContent?.includes("PERF-STREAM-");
      });
      if (changedStreamMessage) testWindow.__perfStreamMutations!++;
    });
    testWindow.__perfStreamObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await ui(page).composer.fill("PERF-START-STREAM");
  await ui(page).send.click();
  await expect(page.getByText(/PERF-STREAM-/)).toBeVisible();
  const stream = page.locator(".message-stream");
  await stream.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByText(/PERF-STREAM-/)).toBeVisible();
  await expect(page.locator('[data-message-id="perf-history-0"]')).toContainText("PERF-HISTORY-0");
  await expect(ui(page).stop).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("article.chat-message.assistant").last()).toContainText("PERF-STREAM-");
  const visibleUpdates = await page.evaluate(() => {
    const testWindow = window as Window & { __perfStreamMutations?: number; __perfStreamObserver?: MutationObserver };
    testWindow.__perfStreamObserver?.disconnect();
    return testWindow.__perfStreamMutations || 0;
  });
  expect(visibleUpdates).toBeGreaterThan(0);
  expect(visibleUpdates).toBeLessThan(350);
});
