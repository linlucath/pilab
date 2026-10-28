import { modelRequestError } from "./network";
import { stat } from "node:fs/promises";
import path from "node:path";
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
import { piRuntime, resolvePiModel } from "./pi-subscription";
import { randomUUID } from "node:crypto";
import { agentTools } from "./tools";
import { e2eMockStreamFn, e2eMockTools, isE2eMode } from "./e2e-mock";
import { projectImages, restoreImageHistory } from "./images";
import { latestImageContext, retainToolImages } from "../extensions/pi-gpt-subagent/images";
import {
  exactPayload as serializeExactPayload,
  fromPiMessage,
  preparePiMessageForModel,
  validateToolHistory,
} from "./transcript";

export type Emit = (event: Record<string, unknown>) => void;
function inspectorPayload(value: unknown): unknown {
  if (typeof value === "string") {
    const match = /^data:(image\/[^;]+);base64,([\s\S]*)$/i.exec(value);
    return match ? `data:${match[1]};base64,[base64 image omitted; approximately ${Math.floor(match[2].length * 3 / 4)} bytes]` : value;
  }
  if (Array.isArray(value)) return value.map(inspectorPayload);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inspectorPayload(item)]));
  return value;
}
export function validateReasoningEffort(settings: Settings, model: Model<Api>) {
  const effort = getReasoningEffort(settings);
  if (!getSupportedThinkingLevels(model).includes(effort))
    throw new Error(
      `模型 ${model.id} 不支持 reasoning effort「${effort}」，请重新选择推理强度。`,
    );
  return effort;
}
export function prepareMessagesForModel(messages: Message[]): Message[] {
  let previousSummary = "";
  return messages.map((message) => {
    const compacted = message.compactedByModel === true || !!message.modelSummary?.trim();
    if (!compacted) { previousSummary = ""; return message; }
    const summary = message.modelSummary?.trim() || "工具调用已归档。";
    if (message.role === "tool") {
      const includeSummary = summary !== previousSummary;
      previousSummary = summary;
      return {
        ...message,
        content: includeSummary ? `[已脱水归档] ${summary}` : "[已脱水归档] 结果已并入同组摘要。",
        images: undefined,
      };
    }
    if (message.role !== "assistant") return message;
    const includeSummary = !(message.toolCalls?.length) && summary !== previousSummary;
    if (includeSummary) previousSummary = summary;
    const toolCalls = (message.toolCalls || []).map((call) => {
      if (!["gpt_session_create", "gpt_session_send"].includes(call.name)) return call;
      try {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        const request = typeof args.message === "string" ? args.message : "";
        if (request.length <= 800) return call;
        args.message = `任务摘要：${summary.slice(0, 800)}`;
        return { ...call, arguments: JSON.stringify(args) };
      } catch { return call; }
    });
    return {
      ...message,
      content: includeSummary ? `[已脱水归档] ${summary}` : "",
      images: undefined,
      providerState: message.providerState ? { ...message.providerState, thinking: [] } : undefined,
      toolCalls,
    };
  });
}

function prepareAgentContext(messages: AgentMessage[], sources: Message[]): AgentMessage[] {
  const wireId = (id: string) => id.split("|")[0];
  const compactedCalls = new Map<string, string>();
  const compactedResults = new Map<string, string>();
  for (const source of sources) {
    const summary = source.modelSummary?.trim();
    if (!(source.compactedByModel || summary)) continue;
    if (source.role === "assistant")
      for (const call of source.toolCalls ?? []) compactedCalls.set(wireId(call.id), summary || "工具调用已归档。");
    if (source.role === "tool" && source.toolCallId) compactedResults.set(wireId(source.toolCallId), summary || "工具结果已归档。");
  }
  let previousSummary = "";
  return messages.map((message) => {
    const value = message as any;
    if (value.role === "toolResult") {
      const summary = compactedResults.get(wireId(value.toolCallId));
      if (!summary) { previousSummary = ""; return message; }
      const includeSummary = summary !== previousSummary;
      previousSummary = summary;
      return { ...value, content: [{ type: "text", text: includeSummary ? `[已脱水归档] ${summary}` : "[已脱水归档] 结果已并入同组摘要。" }], details: undefined } as AgentMessage;
    }
    if (value.role === "assistant" && Array.isArray(value.content)) {
      const summaries: string[] = [...new Set<string>(value.content.flatMap((block: any) => block?.type === "toolCall" && compactedCalls.has(wireId(block.id)) ? [compactedCalls.get(wireId(block.id))!] : []))];
      if (!summaries.length) { previousSummary = ""; return message; }
      const summary = summaries[0];
      const content = value.content.flatMap((block: any) => {
        if (block?.type === "thinking" || block?.type === "text") return [];
        if (block?.type !== "toolCall" || !compactedCalls.has(wireId(block.id))) return [block];
        if (!["gpt_session_create", "gpt_session_send"].includes(block.name)) return [block];
        const args = block.arguments;
        if (!args || typeof args !== "object" || typeof args.message !== "string" || args.message.length <= 800) return [block];
        return [{ ...block, arguments: { ...args, message: `任务摘要：${summary.slice(0, 800)}` } }];
      });
      return { ...value, content } as AgentMessage;
    }
    previousSummary = "";
    return message;
  });
}

export function exactPayload(payload: unknown, settings: Settings, active: Message[]): Record<string, unknown> {
  return serializeExactPayload(payload, settings, prepareMessagesForModel(active));
}

async function e2eWorkingDirectory(settings: Settings) {
  const cwd = settings.workingDirectory.trim() || process.env.PI_LAB_E2E_CWD || process.cwd();
  if (settings.toolMode !== "none") {
    try {
      if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error();
    } catch {
      throw new Error("工具工作目录必须是存在的绝对路径目录。");
    }
  }
  return cwd;
}

export function validateTranscript(settings: Settings, messages: Message[]) {
  const active = messages.filter((m) => m.enabled);
  if (
    !active.length ||
    !active.some(
      (m) => m.content.trim() || m.images?.length || m.toolCalls?.length || m.role === "tool",
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
  const modelOrEndpoint = `${settings.model} ${settings.baseUrl}`.toLowerCase();
  const providerKey =
    settings.protocol === "anthropic-messages"
      ? process.env.ANTHROPIC_API_KEY
      : modelOrEndpoint.includes("gemini") ||
          modelOrEndpoint.includes("generativelanguage.googleapis.com")
        ? process.env.GEMINI_API_KEY
        : process.env.OPENAI_API_KEY;
  return (
    settings.apiKey ||
    process.env.PI_LAB_API_KEY ||
    providerKey ||
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
  const e2e = isE2eMode();
  const subscription =
    !e2e && settings.protocol === "pi-subscription" ? await piRuntime() : undefined;
  const subscribedModel = subscription && resolvePiModel(subscription, settings.model);
  if (subscription && !subscribedModel)
    throw new Error(`Pi 订阅模型不存在：${settings.model}`);
  if (
    subscription &&
    subscribedModel && !subscription.hasConfiguredAuth(subscribedModel.provider)
  )
    throw new Error(
      `Pi 尚未登录 ${subscribedModel.provider}，请先在终端运行 pi 并使用 /login 登录。`,
    );
  const model: Model<Api> = subscribedModel || {
    id: settings.model,
    name: settings.model,
    api: e2e
      ? "openai-completions"
      : settings.protocol === "pi-subscription"
        ? "openai-codex-responses"
        : settings.protocol,
    provider:
      settings.protocol === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: settings.baseUrl.replace(/\/+$/, ""),
    reasoning: effort !== "off",
    ...(settings.protocol !== "anthropic-messages"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    // Custom API protocols have multimodal serializers; the selected model is ultimately validated upstream.
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: settings.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (subscribedModel) validateReasoningEffort(settings, subscribedModel);
  if (active.some((message) => message.images?.length) && !model.input.includes("image"))
    throw new Error(`模型 ${model.id} 不支持图片输入，请切换支持图片的模型。`);
  const generatedTranscript: Message[] = [];
  const history = () => [...active, ...generatedTranscript];
  const onEvent = (event: Record<string, unknown>) => {
    if (event.type === "session_forked") {
      emit({ type: "session_forked", fork: event.fork });
      return;
    }
    emit(event);
  };
  const { cwd, tools } = e2e
    ? {
        cwd: await e2eWorkingDirectory(settings),
        tools: settings.toolMode === "none" ? [] : e2eMockTools(),
      }
    : await agentTools(settings, history, onEvent);
  emit({ type: "runtime", cwd, tools: tools.map((t) => t.name) });
  const transcript: AgentMessage[] = await restoreImageHistory(prepareMessagesForModel(active), model);
  // Agent continuation starts from an existing transcript. Declare the initial
  // loadout explicitly, including when the user already supplied a system message.
  if (tools.length) {
    const toolsAdded = tools.map(toToolDeclaration);
    if (transcript[0]?.role === "system") transcript[0] = { ...transcript[0], toolsAdded };
    else transcript.unshift({ role: "system", content: "", toolsAdded, timestamp: Date.now() });
  }
  let requestCount = 0;
  const streamFn: StreamFn = (chosen, context, options) => {
    requestCount++;
    // Also normalize newly generated Agent turns, not just persisted history.
    context = { ...context, messages: context.messages.map((message) => preparePiMessageForModel(message, chosen)) };
    const currentMessages = prepareMessagesForModel([...active, ...generatedTranscript]);
    const requestOptions: SimpleStreamOptions = {
      ...options,
      ...(subscription
        ? { transport: "sse" as const }
        : { apiKey: e2e ? "e2e-mock" : envKey(settings) }),
      temperature:
        subscription || effort !== "off" ? undefined : settings.temperature,
      maxTokens: settings.maxTokens,
      maxRetries: 0,
      timeoutMs: 120_000,
      onPayload: (payload) => {
        // Use the provider's multimodal serializer when images are attached.
        // The exact text editor serializer intentionally handles text-only turns.
        const hasImages = context.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
        const exact = hasImages || (subscription && chosen.api !== "openai-codex-responses")
          ? payload
          : exactPayload(payload, settings, currentMessages);
        emit({ type: "request", turn: requestCount, payload: inspectorPayload(exact) });
        return exact;
      },
    };
    if (e2e) {
      requestOptions.onPayload?.({
        mock: true,
        model: chosen.id,
        ...(requestOptions.temperature !== undefined ? { temperature: requestOptions.temperature } : {}),
      }, chosen);
      return e2eMockStreamFn(chosen, context, requestOptions);
    }
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
    transformContext: async (messages) => latestImageContext(prepareAgentContext(messages, history())),
    beforeToolCall: async ({ toolCall }) => toolCall.name === "view_images" && !model.input.includes("image")
      ? { block: true, reason: "当前模型不支持图片，请切换到支持图片的模型。" } : undefined,
    afterToolCall: ({ result, toolCall }) => retainToolImages(projectImages, result, toolCall.name),
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
      if (saved.providerState && message.errorMessage)
        saved.providerState.errorMessage = modelRequestError(message.errorMessage, model).slice(0, 12_000);
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
            (message.errorMessage && modelRequestError(message.errorMessage, model)) ||
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
      emit({ type: "error", message: modelRequestError(agent.state.errorMessage, model) });
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
