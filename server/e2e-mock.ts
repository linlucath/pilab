import { randomUUID } from "node:crypto";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";

type MockStep =
  | { type: "text" | "slow" | "long"; text?: string; delayMs?: number; delayBeforeMs?: number; chunkSize?: number; thinking?: string; reason?: "stop" | "length" }
  | { type: "tool"; input?: string; assistantText?: string; thinking?: string; output?: string; delayMs?: number; outputChunkDelayMs?: number; outputError?: boolean }
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
      return {
        type: "tool",
        input: typeof step.input === "string" ? step.input.slice(0, 2000) : "fixture tool call",
        assistantText: typeof step.assistantText === "string" ? step.assistantText.slice(0, 20_000) : undefined,
        thinking: typeof step.thinking === "string" ? step.thinking.slice(0, 20_000) : undefined,
        output: typeof step.output === "string" ? step.output.slice(0, 100_000) : undefined,
        delayMs: typeof step.delayMs === "number" && Number.isFinite(step.delayMs) ? Math.max(0, Math.min(5000, step.delayMs)) : undefined,
        outputChunkDelayMs: typeof step.outputChunkDelayMs === "number" && Number.isFinite(step.outputChunkDelayMs) ? Math.max(0, Math.min(1000, step.outputChunkDelayMs)) : undefined,
        outputError: step.outputError === true,
      };
    if (step.type === "error")
      return { type: "error", message: typeof step.message === "string" ? step.message.slice(0, 2000) : "Scripted E2E error" };
    if (step.text !== undefined && typeof step.text !== "string") throw new Error("mock step text must be a string");
    const text = typeof step.text === "string" ? step.text.slice(0, 100_000) : undefined;
    const thinking = typeof step.thinking === "string" ? step.thinking.slice(0, 20_000) : undefined;
    const delayMs = typeof step.delayMs === "number" && Number.isFinite(step.delayMs) ? Math.max(0, Math.min(5000, step.delayMs)) : undefined;
    const delayBeforeMs = typeof step.delayBeforeMs === "number" && Number.isFinite(step.delayBeforeMs) ? Math.max(0, Math.min(5000, step.delayBeforeMs)) : undefined;
    const chunkSize = typeof step.chunkSize === "number" && Number.isFinite(step.chunkSize) ? Math.max(1, Math.min(1000, Math.floor(step.chunkSize))) : undefined;
    const reason = step.reason === "length" ? "length" : "stop";
    return { type: step.type as "text" | "slow" | "long", text, thinking, delayMs, delayBeforeMs, chunkSize, reason };
  });
}

export function resetE2eMockScript() { steps = []; activeToolStep = undefined; }
function nextStep(): MockStep {
  return steps.shift() || { type: "text", text: "E2E mock response" };
}

let activeToolStep: Extract<MockStep, { type: "tool" }> | undefined;
const abortedToolResult = () => ({ content: [{ type: "text" as const, text: "Mock tool execution interrupted." }], details: {}, isError: true });
const mockTool: AgentTool<any> = {
  name: "e2e_mock_tool",
  label: "E2E mock tool",
  description: "Safe local fixture tool; it does not access the filesystem or network.",
  parameters: Type.Object({ input: Type.Optional(Type.String()) }),
  execute: async (_id, params, signal, onUpdate) => {
    const step = activeToolStep;
    activeToolStep = undefined;
    if (step?.delayMs) {
      if (!(await wait(step.delayMs, signal))) return abortedToolResult();
    }
    const output = step?.output ?? `Mock tool result: ${(params as { input?: string }).input || "ok"}`;
    for (let index = 0; index < output.length; index += 2000) {
      if (signal?.aborted) return abortedToolResult();
      onUpdate?.({ content: [{ type: "text", text: output.slice(0, index + 2000) }], details: {} });
      if (index + 2000 < output.length && !(await wait(step?.outputChunkDelayMs ?? 12, signal))) return abortedToolResult();
    }
    return { content: [{ type: "text", text: output }], details: {}, ...(step?.outputError ? { isError: true } : {}) };
  },
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
    const emitText = async (text: string, chunkSize: number, delayMs: number) => {
      const block = { type: "text" as const, text: "" };
      const contentIndex = message.content.length;
      message.content.push(block);
      stream.push({ type: "text_start", contentIndex, partial: message });
      for (let index = 0; index < text.length; index += chunkSize) {
        if (signal?.aborted) return false;
        const chunk = text.slice(index, index + chunkSize);
        block.text += chunk;
        message.usage.output += chunk.length;
        message.usage.totalTokens += chunk.length;
        stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: message });
        if (index + chunkSize < text.length && delayMs > 0 && !(await wait(delayMs, signal))) return false;
      }
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
      return true;
    };
    const emitThinking = async (thinking?: string) => {
      if (!thinking) return true;
      const block = { type: "thinking" as const, thinking: "" };
      const contentIndex = message.content.length;
      message.content.push(block);
      stream.push({ type: "thinking_start", contentIndex, partial: message });
      for (let index = 0; index < thinking.length; index += 8) {
        if (signal?.aborted) return false;
        const chunk = thinking.slice(index, index + 8);
        block.thinking += chunk;
        stream.push({ type: "thinking_delta", contentIndex, delta: chunk, partial: message });
      }
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
      return true;
    };
    if (step.type === "tool") {
      if (!(await emitThinking(step.thinking))) return;
      if (step.assistantText && !(await emitText(step.assistantText, 8, 0))) return;
      const call = { type: "toolCall" as const, id: `e2e-${randomUUID()}`, name: "e2e_mock_tool", arguments: { input: step.input || "fixture tool call" } };
      const contentIndex = message.content.length;
      activeToolStep = step;
      message.content.push(call);
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      return;
    }
    if (step.delayBeforeMs && !(await wait(step.delayBeforeMs, signal))) {
      message.stopReason = "aborted";
      message.errorMessage = "Generation aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      return;
    }
    const text = step.text ?? (step.type === "long" ? "E2E long response. ".repeat(500) : "E2E mock response streamed from the isolated test provider.");
    if (!(await emitThinking(step.thinking))) {
      message.stopReason = "aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      return;
    }
    const chunkSize = step.chunkSize ?? (step.type === "slow" ? 2 : 8);
    const delayMs = step.delayMs ?? (step.type === "slow" ? 180 : 12);
    if (!(await emitText(text, chunkSize, delayMs))) {
      message.stopReason = "aborted";
      message.errorMessage = "Generation aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      return;
    }
    message.stopReason = step.reason ?? "stop";
    stream.push({ type: "done", reason: message.stopReason as "stop" | "length", message });
  })().catch((error) => {
    const message = emptyMessage(model);
    message.stopReason = "error";
    message.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "error", error: message });
  });
  return stream;
};
