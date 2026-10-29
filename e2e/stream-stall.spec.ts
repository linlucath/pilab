import { test, expect } from "@playwright/test";
import { openWorkspace, resetWorkspace, sendMessage, setMockScript, ui } from "./fixtures/index";

test.beforeEach(async ({ page }) => {
  await openWorkspace(page);
  await resetWorkspace(page);
  await page.reload();
});

test("RUN-05 /api/run 长时间等待工具期间发送合法 NDJSON 心跳", async ({ page }) => {
  await setMockScript(page, [
    { type: "tool", input: "one", delayMs: 4_500 },
    { type: "tool", input: "two", delayMs: 4_500 },
    { type: "tool", input: "three", delayMs: 4_500 },
    { type: "text", text: "工具等待后继续完成" },
  ]);
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    (window as Window & { __runHeartbeatCount?: number }).__runHeartbeatCount = 0;
    window.fetch = async (input, init) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(target, location.href).pathname !== "/api/run") return nativeFetch(input, init);
      const response = await nativeFetch(input, init);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          chunks.push(value);
          totalBytes += value.length;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() || "";
          for (const line of lines) if (line.trim() && JSON.parse(line).type === "heartbeat")
            (window as Window & { __runHeartbeatCount?: number }).__runHeartbeatCount!++;
        }
        if (done) break;
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
  await sendMessage(page, "心跳保活测试");
  await expect(ui(page).assistantMessages).toContainText("工具等待后继续完成", { timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => (window as Window & { __runHeartbeatCount?: number }).__runHeartbeatCount || 0), { timeout: 25_000 }).toBeGreaterThan(0);
  await expect(ui(page).stop).toHaveCount(0);
});

test("RUN-05 上游流停滞时说明等待超时并保留原始错误和日志", async ({ page }) => {
  const reason = "stream stalled: no data for 120000ms";
  await setMockScript(page, [{ type: "error", message: reason }]);
  await sendMessage(page, "超时诊断测试");
  await expect(ui(page).alerts).toContainText("连续 120 秒未收到数据");
  await expect(ui(page).alerts).toContainText(reason);
  await expect(ui(page).stop).toHaveCount(0);
  await expect(page.locator(".message-row--user-bubble")).toContainText("超时诊断测试");
  await page.getByLabel("打开调试工具", { exact: true }).click();
  await page.getByRole("button", { name: "运行记录", exact: true }).click();
  await expect(page.locator(".run-history")).toContainText(reason);
  const response = await page.request.get("/api/logs?category=run&q=stream%20stalled");
  const { logs } = await response.json();
  expect(logs.some((entry: any) => entry.event === "run_error" && entry.data.reason.includes(reason))).toBe(true);
});

test("RUN-05 本地连接失败与上游模型错误分开显示", async ({ page }) => {
  await page.route("**/api/run", (route) => route.abort("connectionrefused"));
  await sendMessage(page, "连接失败测试");
  await expect(ui(page).alerts).toContainText("网页连接本地服务失败");
  await expect(ui(page).stop).toHaveCount(0);
  const response = await page.request.get("/api/logs?category=client&q=run_request_error");
  expect((await response.json()).logs.length).toBeGreaterThan(0);
});

test("RUN-05 缺少完成事件时保留部分正文并记录断流", async ({ page }) => {
  await page.route("**/api/run", (route) => route.fulfill({
    contentType: "application/x-ndjson",
    body: [
      { type: "heartbeat" },
      { type: "assistant_start", id: "partial-reply" },
      { type: "text", id: "partial-reply", delta: "仍应保留的部分回复" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  }));
  await sendMessage(page, "断流测试");
  await expect(ui(page).alerts).toContainText("回复流意外中断");
  await expect(ui(page).assistantMessages).toContainText("仍应保留的部分回复");
  await expect(page.getByText("heartbeat", { exact: true })).toHaveCount(0);
  await expect(ui(page).stop).toHaveCount(0);
  const response = await page.request.get("/api/logs?category=client&q=stream_unexpected_eof");
  expect((await response.json()).logs.length).toBeGreaterThan(0);
});

test("RUN-05 流读取网络异常时为尚未返回结果的工具调用补失败结果", async ({ page }) => {
  const events = [
    { type: "heartbeat" },
    { type: "assistant", message: {
      id: "partial-tool-owner", role: "assistant", content: "", enabled: true,
      toolCalls: [{ id: "partial-tool-call", name: "e2e_mock_tool", arguments: "{}" }],
    } },
  ].map((event) => `${JSON.stringify(event)}\n`);
  await page.evaluate((lines) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(target, location.href).pathname !== "/api/run") return nativeFetch(input, init);
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < lines.length) controller.enqueue(new TextEncoder().encode(lines[index++]));
          else controller.error(new TypeError("NetworkError when attempting to fetch resource."));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    };
  }, events);
  await sendMessage(page, "工具断流测试");
  const toolGroup = page.locator(".tool-group");
  await expect(ui(page).alerts).toContainText("回复流连接意外中断");
  await toolGroup.locator(":scope > details > summary").click();
  const tool = toolGroup.locator('.tool-step[data-tool-name="e2e_mock_tool"]');
  await expect(tool).toContainText("失败");
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".tool-readable-block.error")).toContainText("Connection closed");
  await expect(ui(page).stop).toHaveCount(0);
});

test("RUN-05 断流时为尚未返回结果的工具调用补失败结果", async ({ page }) => {
  await page.route("**/api/run", (route) => route.fulfill({
    contentType: "application/x-ndjson",
    body: [
      { type: "heartbeat" },
      { type: "assistant", message: {
        id: "partial-tool-owner", role: "assistant", content: "", enabled: true,
        toolCalls: [{ id: "partial-tool-call", name: "e2e_mock_tool", arguments: "{}" }],
      } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  }));
  await sendMessage(page, "工具断流测试");
  const toolGroup = page.locator(".tool-group");
  await expect(ui(page).alerts).toContainText("回复流意外中断");
  await toolGroup.locator(":scope > details > summary").click();
  const tool = toolGroup.locator('.tool-step[data-tool-name="e2e_mock_tool"]');
  await expect(tool).toContainText("失败");
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".tool-readable-block.error")).toContainText("Connection closed");
  await expect(ui(page).stop).toHaveCount(0);
});
