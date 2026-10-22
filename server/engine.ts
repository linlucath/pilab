import "./network";
import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  toToolDeclaration,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  getReasoningEffort,
  runSchema,
  type Message,
  type Settings,
} from "../shared/schema";
import { piRuntime } from "./pi-subscription";
import { randomUUID } from "node:crypto";
import { agentTools } from "./tools";
import {
  exactPayload,
  fromPiMessage,
  toPiMessage,
  validateToolHistory,
} from "./transcript";
export { exactPayload } from "./transcript";

export type Emit = (event: Record<string, unknown>) => void;
export function validateReasoningEffort(settings: Settings, model: Model<Api>) {
  const effort = getReasoningEffort(settings);
  if (!getSupportedThinkingLevels(model).includes(effort))
    throw new Error(
      `模型 ${model.id} 不支持 reasoning effort「${effort}」，请重新选择推理强度。`,
    );
  return effort;
}
export function validateTranscript(settings: Settings, messages: Message[]) {
  const active = messages.filter((m) => m.enabled);
  if (
    !active.length ||
    !active.some(
      (m) => m.content.trim() || m.toolCalls?.length || m.role === "tool",
    )
  )
    throw new Error("请添加至少一条有内容且已启用的消息。");
  if (settings.protocol === "pi-subscription") {
    const firstConversation = active.findIndex((m) => m.role !== "system");
    if (firstConversation === -1)
      throw new Error(
        "Pi 订阅至少需要一条 developer、user 或 assistant 消息。",
      );
    if (active.slice(firstConversation).some((m) => m.role === "system"))
      throw new Error(
        "Pi 订阅要求 system 指令位于开头（作为 instructions 发送）。请上移该消息，或切换至标准 OpenAI 接口。",
      );
  }
  if (settings.protocol === "anthropic-messages") {
    if (active.some((m) => m.role === "developer"))
      throw new Error(
        "Anthropic 不支持独立的 developer 角色。请切换至 OpenAI 协议，或手动将该消息改为 system。",
      );
    const firstConversation = active.findIndex((m) => m.role !== "system");
    if (firstConversation === -1)
      throw new Error("Anthropic 至少需要一条 user 或 assistant 消息。");
    if (active.slice(firstConversation).some((m) => m.role === "system"))
      throw new Error(
        "Anthropic 的 system 指令必须位于对话开头。请上移该消息或切换至 OpenAI 协议。",
      );
  }
  validateToolHistory(active);
  return active;
}
function envKey(settings: Settings) {
  return (
    settings.apiKey ||
    process.env.PI_LAB_API_KEY ||
    (settings.protocol === "anthropic-messages"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY) ||
    "local-no-key"
  );
}
export async function generate(
  input: unknown,
  emit: Emit,
  signal?: AbortSignal,
) {
  const { settings, messages } = runSchema.parse(input);
  const effort = getReasoningEffort(settings);
  const active = validateTranscript(settings, messages);
  const subscription =
    settings.protocol === "pi-subscription" ? await piRuntime() : undefined;
  const subscribedModel = subscription?.getModel(
    "openai-codex",
    settings.model,
  );
  if (subscription && !subscribedModel)
    throw new Error(`Pi 订阅模型不存在：${settings.model}`);
  if (
    subscription &&
    !(await subscription.listCredentials()).some(
      (c) => c.providerId === "openai-codex" && c.type === "oauth",
    )
  )
    throw new Error(
      "Pi 尚未登录 OpenAI Codex 订阅，请先在终端运行 pi 并使用 /login 登录。",
    );
  const model: Model<Api> = subscribedModel || {
    id: settings.model,
    name: settings.model,
    api:
      settings.protocol === "pi-subscription"
        ? "openai-codex-responses"
        : settings.protocol,
    provider:
      settings.protocol === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: settings.baseUrl.replace(/\/+$/, ""),
    reasoning: effort !== "off",
    ...(settings.protocol !== "anthropic-messages"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: settings.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (subscribedModel) validateReasoningEffort(settings, subscribedModel);
  const { cwd, tools } = await agentTools(settings);
  emit({ type: "runtime", cwd, tools: tools.map((t) => t.name) });
  const transcript: AgentMessage[] = active.map((m) => toPiMessage(m, model));
  // Agent continuation starts from an existing transcript. Declare the initial
  // loadout explicitly, including when the user already supplied a system message.
  if (tools.length) {
    const toolsAdded = tools.map(toToolDeclaration);
    if (transcript[0]?.role === "system") transcript[0] = { ...transcript[0], toolsAdded };
    else transcript.unshift({ role: "system", content: "", toolsAdded, timestamp: Date.now() });
  }
  const generatedTranscript: Message[] = [];
  let requestCount = 0;
  const streamFn: StreamFn = (chosen, context, options) => {
    requestCount++;
    const currentMessages = [...active, ...generatedTranscript];
    const requestOptions: SimpleStreamOptions = {
      ...options,
      ...(subscription
        ? { transport: "sse" as const }
        : { apiKey: envKey(settings) }),
      temperature:
        subscription || effort !== "off" ? undefined : settings.temperature,
      maxTokens: settings.maxTokens,
      maxRetries: 0,
      timeoutMs: 120_000,
      onPayload: (payload) => {
        const exact = exactPayload(payload, settings, currentMessages);
        emit({ type: "request", turn: requestCount, payload: exact });
        return exact;
      },
    };
    if (subscription)
      return subscription.streamSimple(chosen, context, requestOptions);
    if (chosen.api === "openai-completions")
      return completions(
        chosen as Model<"openai-completions">,
        context,
        requestOptions,
      );
    if (chosen.api === "openai-responses")
      return responses(
        chosen as Model<"openai-responses">,
        context,
        requestOptions,
      );
    return anthropic(
      chosen as Model<"anthropic-messages">,
      context,
      requestOptions,
    );
  };
  const agent = new Agent({
    initialState: {
      model,
      messages: transcript,
      tools,
      thinkingLevel: effort,
    },
    streamFn,
    toolExecution: "sequential",
    finishTurn: ({ message }) => {
      const needsTools =
        message.role === "assistant" &&
        message.content.some((b) => b.type === "toolCall");
      if (requestCount >= settings.maxTurns && needsTools) limited = true;
      if (!tools.length || requestCount >= settings.maxTurns)
        return { action: "end" };
      return undefined;
    },
  });
  let failed = false;
  let limited = false;
  let currentAssistantId = randomUUID();
  let lastReason = "stop";
  const usage = { input: 0, output: 0 };
  const toolIds = new Map<string, string>();
  const toolMessageId = (callId: string) => {
    if (!toolIds.has(callId)) toolIds.set(callId, randomUUID());
    return toolIds.get(callId)!;
  };
  agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      currentAssistantId = randomUUID();
      emit({
        type: "assistant_start",
        id: currentAssistantId,
        turn: requestCount,
      });
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta")
        emit({ type: "text", id: currentAssistantId, delta: delta.delta });
      if (delta.type === "thinking_delta")
        emit({ type: "thinking", id: currentAssistantId, delta: delta.delta });
      if (delta.type === "toolcall_delta" || delta.type === "toolcall_end")
        emit({
          type: "assistant",
          message: fromPiMessage(
            event.message as import("@earendil-works/pi-ai").AssistantMessage,
            currentAssistantId,
          ),
        });
    }
    if (event.type === "tool_execution_start")
      emit({
        type: "tool_activity",
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        output: "",
      });
    if (event.type === "tool_execution_update")
      emit({
        type: "tool_activity",
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        output: (event.partialResult?.content || [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n"),
      });
    if (event.type === "tool_execution_end")
      emit({ type: "tool_activity_end", id: event.toolCallId });
    if (event.type === "message_end" && event.message.role === "toolResult") {
      const message = fromPiMessage(
        event.message,
        toolMessageId(event.message.toolCallId),
      );
      generatedTranscript.push(message);
      emit({ type: "message", message });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const saved = fromPiMessage(message, currentAssistantId);
      generatedTranscript.push(saved);
      emit({ type: "assistant", message: saved });
      usage.input +=
        message.usage.input +
        message.usage.cacheRead +
        message.usage.cacheWrite;
      usage.output += message.usage.output;
      lastReason = message.stopReason;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failed = true;
        emit({
          type: "error",
          message:
            message.errorMessage ||
            (signal?.aborted ? "生成已停止" : "模型请求失败"),
        });
      }
    }
  });
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("请求已取消");
    // Empty prompt batch runs from the edited transcript without appending a synthetic user turn.
    await agent.prompt([]);
    if (agent.state.errorMessage && !failed) {
      failed = true;
      emit({ type: "error", message: agent.state.errorMessage });
    }
    if (!failed && !signal?.aborted)
      emit({
        type: "done",
        reason: limited ? "turn_limit" : lastReason,
        usage,
        turns: requestCount,
      });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
