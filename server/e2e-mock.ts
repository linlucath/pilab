import { randomUUID } from "node:crypto";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";

type MockStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; chunkSize?: number }
  | { type: "tool"; input?: string }
  | { type: "error"; message?: string };

let steps: MockStep[] = [];
export const isE2eMode = () => process.env.PI_LAB_E2E === "1";

export function setE2eMockScript(input: unknown) {
  if (!Array.isArray(input) || input.length > 20)
    throw new Error("mock script must be an array with at most 20 steps");
  steps = input.map((value): MockStep => {
    if (!value || typeof value !== "object") throw new Error("each mock step must be an object");
    const step = value as Record<string, unknown>;
    if (!["text", "slow", "tool", "error", "long"].includes(String(step.type)))
      throw new Error("mock step type must be text, slow, tool, error, or long");
    if (step.type === "tool")
      return { type: "tool", input: typeof step.input === "string" ? step.input.slice(0, 2000) : "fixture tool call" };
    if (step.type === "error")
      return { type: "error", message: typeof step.message === "string" ? step.message.slice(0, 2000) : "Scripted E2E error" };
    if (step.text !== undefined && typeof step.text !== "string") throw new Error("mock step text must be a string");
    const text = typeof step.text === "string" ? step.text.slice(0, 100_000) : undefined;
    const delayMs = typeof step.delayMs === "number" && Number.isFinite(step.delayMs) ? Math.max(0, Math.min(5000, step.delayMs)) : undefined;
    const chunkSize = typeof step.chunkSize === "number" && Number.isFinite(step.chunkSize) ? Math.max(1, Math.min(1000, Math.floor(step.chunkSize))) : undefined;
    return { type: step.type as "text" | "slow" | "long", text, delayMs, chunkSize };
  });
}

export function resetE2eMockScript() { steps = []; }
function nextStep(): MockStep {
  return steps.shift() || { type: "text", text: "E2E mock response" };
}

const mockTool: AgentTool<any> = {
  name: "e2e_mock_tool",
  label: "E2E mock tool",
  description: "Safe local fixture tool; it does not access the filesystem or network.",
  parameters: Type.Object({ input: Type.Optional(Type.String()) }),
  execute: async (_id, params) => ({ content: [{ type: "text", text: `Mock tool result: ${(params as { input?: string }).input || "ok"}` }], details: {} }),
};
export function e2eMockTools(): AgentTool<any>[] { return [mockTool]; }

const emptyUsage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const emptyMessage = (model: Model<any>): AssistantMessage => ({
  role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
  usage: emptyUsage(), stopReason: "pending", timestamp: Date.now(),
});

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(true); }, ms);
    const abort = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export const e2eMockStreamFn: StreamFn = (model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  const step = nextStep();
  const signal = options?.signal;
  void (async () => {
    const message = emptyMessage(model);
    stream.push({ type: "start", partial: message });
    if (step.type === "error") {
      message.stopReason = "error";
      message.errorMessage = step.message || "Scripted E2E error";
      stream.push({ type: "error", reason: "error", error: message });
      return;
    }
    if (step.type === "tool") {
      const call = { type: "toolCall" as const, id: `e2e-${randomUUID()}`, name: "e2e_mock_tool", arguments: { input: step.input || "fixture tool call" } };
      message.content.push(call);
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      return;
    }
    const text = step.text ?? (step.type === "long" ? "E2E long response. ".repeat(500) : "E2E mock response streamed from the isolated test provider.");
    const block = { type: "text" as const, text: "" };
    const contentIndex = message.content.length;
    message.content.push(block);
    stream.push({ type: "text_start", contentIndex, partial: message });
    const chunkSize = step.chunkSize ?? (step.type === "slow" ? 2 : 8);
    const delayMs = step.delayMs ?? (step.type === "slow" ? 180 : 12);
    for (let index = 0; index < text.length; index += chunkSize) {
      if (signal?.aborted) {
        message.stopReason = "aborted";
        message.errorMessage = "Generation aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        return;
      }
      const chunk = text.slice(index, index + chunkSize);
      block.text += chunk;
      message.usage.output += chunk.length;
      message.usage.totalTokens += chunk.length;
      stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: message });
      if (index + chunkSize < text.length && delayMs > 0 && !(await wait(delayMs, signal))) {
        message.stopReason = "aborted";
        message.errorMessage = "Generation aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        return;
      }
    }
    stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    message.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message });
  })().catch((error) => {
    const message = emptyMessage(model);
    message.stopReason = "error";
    message.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "error", error: message });
  });
  return stream;
};
