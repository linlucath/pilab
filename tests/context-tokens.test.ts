import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../shared/schema";
import { contextTokenMetrics, estimateMessageTokens } from "../src/utils/context-tokens";

test("context token estimates include thinking and long tool arguments before dehydration", () => {
  const assistant: Message = {
    id: "assistant-call",
    role: "assistant",
    content: "",
    enabled: true,
    providerState: {
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      thinking: [{ type: "thinking", thinking: "认真推理过程。".repeat(3000) }],
    },
    toolCalls: [{ id: "call-1", name: "gpt_session_send", arguments: JSON.stringify({ name: "worker", message: "很长的 GPT 任务说明。".repeat(3000) }) }],
  };
  const result: Message = {
    id: "tool-result",
    role: "tool",
    content: "很长的原始工具输出。".repeat(3000),
    enabled: true,
    toolCallId: "call-1",
    toolName: "gpt_session_send",
  };
  const raw = contextTokenMetrics([assistant, result]);
  const summary = "已查看并整理材料，完成了必要的修改与核对。";
  const compacted = contextTokenMetrics([
    { ...assistant, compactedByModel: true, modelSummary: summary },
    { ...result, compactedByModel: true, modelSummary: summary },
  ]);

  assert.ok(estimateMessageTokens(assistant) > 10_000);
  assert.equal(raw.savedPercent, 0);
  assert.ok(compacted.savedPercent >= 70, `expected substantial savings, got ${compacted.savedPercent}%`);
  assert.ok(compacted.context < raw.context / 3);
});
