import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fromPiMessage, preparePiMessageForModel, toPiMessage } from "../server/transcript";
import type { Message } from "../shared/schema";

const model = { api: "antigravity", provider: "antigravity", id: "claude-opus-5-5" } as Model<Api>;
const historical: Message = {
  id: "partial", role: "assistant", content: "Visible reply", enabled: true,
  providerState: { api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", thinking: [
    { type: "thinking", thinking: "Interrupted thinking" },
    { type: "thinking", thinking: "Empty signature", thinkingSignature: "" },
    { type: "thinking", thinking: "Whitespace signature", thinkingSignature: "  " },
    { type: "thinking", thinking: "Signed thinking", thinkingSignature: "opaque-provider-signature" },
    { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-redacted-signature" },
  ] },
  toolCalls: [{ id: "call-1", name: "read", arguments: '{"path":"seed.txt"}', thoughtSignature: "signed-call" }],
};

test("Claude replays only signed thinking and preserves visible text, tool calls and stored history", () => {
  const before = structuredClone(historical);
  const replay = toPiMessage(historical, model);
  assert.equal(replay.role, "assistant");
  if (replay.role !== "assistant") throw new Error("Expected assistant");
  assert.deepEqual(replay.content.filter((block) => block.type === "thinking"), historical.providerState!.thinking.slice(3));
  assert.equal(replay.content.find((block) => block.type === "text")?.text, historical.content);
  assert.deepEqual(fromPiMessage(replay, "roundtrip").toolCalls, historical.toolCalls?.map((call) => ({ ...call, arguments: JSON.stringify(JSON.parse(call.arguments), null, 2) })));
  assert.deepEqual(historical, before);
});

test("provider-boundary normalization also handles a newly streamed unsigned thinking block", () => {
  const message = toPiMessage(historical, { ...model, id: "gemini-3.8-flash" });
  const prepared = preparePiMessageForModel(message, model);
  assert.equal(prepared.role, "assistant");
  if (prepared.role !== "assistant" || message.role !== "assistant") throw new Error("Expected assistant");
  assert.equal(prepared.content.filter((block) => block.type === "thinking").length, 2);
  assert.equal(message.content.filter((block) => block.type === "thinking").length, 5);
});

test("Claude excludes failed/aborted thinking even with signatures, preserving successful retry and original records", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const failed: Message = { ...structuredClone(historical), providerState: { ...structuredClone(historical.providerState!), stopReason } };
    const before = structuredClone(failed);
    const replay = toPiMessage(failed, model);
    if (replay.role !== "assistant") throw new Error("Expected assistant");
    assert.equal(replay.content.filter((block) => block.type === "thinking").length, 0);
    assert.equal(replay.content.find((block) => block.type === "text")?.text, failed.content);
    assert.equal(replay.content.filter((block) => block.type === "toolCall").length, 1);
    const nativeFailure = { ...toPiMessage(historical, model), stopReason };
    const normalized = preparePiMessageForModel(nativeFailure as any, model);
    if (normalized.role !== "assistant") throw new Error("Expected assistant");
    assert.equal(normalized.content.filter((block) => block.type === "thinking").length, 0);
    const retry = toPiMessage(historical, model);
    if (retry.role !== "assistant") throw new Error("Expected assistant");
    assert.equal(retry.content.filter((block) => block.type === "thinking").length, 2);
    assert.deepEqual(failed, before);
  }
});

test("Gemini/GPT replay behavior and user messages are unchanged", () => {
  for (const target of [{ ...model, id: "gemini-4-argon" }, { ...model, provider: "openai-codex", id: "gpt-test" }]) {
    const replay = toPiMessage(historical, target);
    if (replay.role !== "assistant") throw new Error("Expected assistant");
    assert.deepEqual(replay.content.filter((block) => block.type === "thinking"), historical.providerState!.thinking);
  }
  const user = { role: "user" as const, content: "Keep text", timestamp: 0 };
  assert.equal(preparePiMessageForModel(user, model), user);
});
