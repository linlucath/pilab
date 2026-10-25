import { test, expect } from "@playwright/test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { toPiMessage } from "../server/transcript";
import { defaults } from "../shared/schema";
import { openWorkspace, resetWorkspace, sendMessage, ui } from "./fixtures/index";

// Local provider fixture checks the same Pi transcript conversion used by the
// real backend. No subscription credentials or external model calls are used.
for (const signature of [undefined, "signed-but-interrupted"]) test(`RUN-05 Claude 续聊跳过${signature ? "已签名但失败的" : "未签名"}思考且保留网页原始历史`, async ({ page }) => {
  await openWorkspace(page);
  await resetWorkspace(page);
  const session = { id: "claude-replay-fixture", title: "Claude replay fixture" };
  const model = { api: "antigravity", provider: "antigravity", id: "claude-opus-5-5" } as Model<Api>;
  const historical = {
    id: "interrupted-claude", role: "assistant", enabled: true, content: "原始正文保留",
    providerState: { api: model.api, provider: model.provider, model: model.id,
      thinking: [{ type: "thinking", thinking: "中断前的思考", ...(signature ? { thinkingSignature: signature } : {}) }], stopReason: "error" },
  };
  const initialized = await page.request.post("/api/workspace", { data: {
    active: session.id,
    sessions: [{ ...session, settings: defaults, messages: [historical] }],
  } });
  expect(initialized.ok()).toBe(true);
  await page.reload();
  await page.route("**/api/run", async (route) => {
    const body = route.request().postDataJSON();
    const native = body.messages.map((message: any) => toPiMessage(message, model));
    const unsigned = native.some((message: any) => message.role === "assistant" &&
      message.content.some((block: any) => block.type === "thinking" && !block.thinkingSignature));
    const failedReplay = native[body.messages.findIndex((message: any) => message.id === historical.id)]
      ?.content.some((block: any) => block.type === "thinking");
    const events = unsigned || failedReplay
      ? [{ type: "error", message: "messages.21.content.1.thinking.signature: Field required" }]
      : [{ type: "assistant_start", id: "continued" }, { type: "text", id: "continued", delta: "CLAUDE-CONTINUE-OK" }, { type: "done", reason: "stop" }];
    await route.fulfill({ contentType: "application/x-ndjson", body: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
  });
  await sendMessage(page, "继续对话");
  await expect(page.getByText("CLAUDE-CONTINUE-OK", { exact: true })).toBeVisible();
  await expect(ui(page).alerts).toHaveCount(0);
  const saved = await (await page.request.get("/api/workspace")).json();
  const original = saved.workspace.sessions.find((item: any) => item.id === session.id).messages.find((item: any) => item.id === historical.id);
  expect(original).toEqual(historical);
});
