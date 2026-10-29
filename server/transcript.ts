import type {
  Api,
  AssistantMessage,
  Message as PiMessage,
  Model,
} from "@earendil-works/pi-ai";
import type { Message, Settings, ToolCall } from "../shared/schema";
import { imageReferences } from "../extensions/pi-gpt-subagent/images";
import { replyDelivery } from "../extensions/pi-gpt-subagent/tools";

export const wireCallId = (id: string) => id.split("|")[0];
export function callArguments(call: ToolCall) {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error(`工具 ${call.name} 的参数不是有效 JSON。`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`工具 ${call.name} 的参数必须是 JSON 对象。`);
  return value as Record<string, any>;
}

export function validateToolHistory(messages: Message[]) {
  const pendingCalls = new Map<string, ToolCall>();
  const seen = new Set<string>();
  let resultsStarted = false;
  for (const message of messages) {
    if (pendingCalls.size && message.role !== "tool") {
      const isCollectingCalls = !resultsStarted && message.role === "assistant" && !!message.toolCalls?.length;
      if (!isCollectingCalls)
        throw new Error(
          "工具调用后必须先补齐所有工具结果，再添加其他消息。请检查被删除或排除的工具结果。",
        );
    }
    if (message.role === "tool") {
      resultsStarted = true;
      const id = wireCallId(message.toolCallId || "");
      const call = pendingCalls.get(id);
      if (!call)
        throw new Error(`工具结果没有对应的调用：${id || "未填写 Call ID"}`);
      if (message.toolName !== call.name)
        throw new Error(`工具结果名称应为 ${call.name}。`);
      pendingCalls.delete(id);
      if (!pendingCalls.size) resultsStarted = false;
    } else if (message.toolCalls?.length) {
      if (message.role !== "assistant")
        throw new Error("只有 assistant 消息可以包含工具调用。");
      for (const call of message.toolCalls) {
        const id = wireCallId(call.id);
        if (!id || seen.has(id))
          throw new Error(`工具 Call ID 为空或重复：${id}`);
        callArguments(call);
        pendingCalls.set(id, call);
        seen.add(id);
      }
    }
  }
  if (pendingCalls.size)
    throw new Error(
      `请先为工具调用 ${[...pendingCalls.values()].map((c) => c.name).join("、")} 添加工具结果。`,
    );
}

export function preparePiMessageForModel(message: PiMessage, model: Model<Api>, sourceStopReason?: string): PiMessage {
  if (message.role !== "assistant" || model.provider !== "antigravity" || !model.id.startsWith("claude-"))
    return message;
  // A failed stream may already have a signature, but its thinking is still an
  // incomplete turn. Replaying it beside the successful retry can merge both
  // into one Claude turn. Keep failed thinking in UI history, not on the wire.
  const incomplete = ["error", "aborted"].includes(sourceStopReason || message.stopReason);
  return { ...message, content: message.content.filter((block) =>
    block.type !== "thinking" || (!incomplete && !!block.thinkingSignature?.trim())) };
}

export function toPiMessage(message: Message, model: Model<Api>): PiMessage {
  if (message.role === "tool")
    return {
      role: "toolResult",
      toolCallId: message.toolCallId!,
      toolName: message.toolName!,
      content: [{ type: "text", text: message.content }],
      isError: message.isError || false,
      ...(message.images?.length || message.gptReply ? { details: {
        ...(message.images?.length ? { piLabImages: message.images } : {}),
        ...(message.gptReply ? { piLabGptReply: message.gptReply } : {}),
      } } : {}),
      timestamp: Date.now(),
    };
  if (message.role !== "assistant")
    return {
      role: message.role === "developer" ? "system" : message.role,
      content: message.content,
      timestamp: Date.now(),
    };
  const state = message.providerState;
  return preparePiMessageForModel({
    role: "assistant",
    content: [
      ...(state?.thinking || []),
      ...(message.content
        ? [
            {
              type: "text" as const,
              text: message.content,
              textSignature: state?.textSignature,
            },
          ]
        : []),
      ...(message.toolCalls || []).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: callArguments(call),
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      })),
    ],
    api: (state?.api || model.api) as Api,
    provider: state?.provider || model.provider,
    model: state?.model || model.id,
    timestamp: Date.now(),
    stopReason: message.toolCalls?.length ? "toolUse" : state?.stopReason === "length" ? "length" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }, model, state?.stopReason);
}
export function fromPiMessage(message: PiMessage, id: string): Message {
  if (message.role === "assistant")
    return {
      id,
      role: "assistant",
      enabled: true,
      content: message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      toolCalls: message.content
        .filter((b) => b.type === "toolCall")
        .map((b) => ({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.arguments, null, 2),
          ...(b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {}),
        })),
      providerState: {
        api: message.api,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
        ...(message.errorMessage ? { errorMessage: message.errorMessage.slice(0, 12_000) } : {}),
        thinking: message.content.filter((b) => b.type === "thinking"),
        textSignature: message.content.find((b) => b.type === "text")
          ?.textSignature,
      },
    };
  if (message.role === "toolResult")
    return {
      id,
      role: "tool",
      enabled: true,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      ...(replyDelivery(message.details) ? { gptReply: replyDelivery(message.details) } : {}),
      ...(imageReferences(message.details).length ? { images: imageReferences(message.details) } : {}),
      content: message.content
        .map((b) =>
          b.type === "text"
            ? b.text
            : imageReferences(message.details).length ? "" : "[图片]",
        )
        .filter(Boolean)
        .join("\n"),
    };
  return {
    id,
    role: message.role,
    enabled: true,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n"),
  };
}

export function normalizeConsecutiveToolCallMessages(messages: PiMessage[]): PiMessage[] {
  const normalized: PiMessage[] = [];
  for (const message of messages) {
    const previous = normalized.at(-1);
    if (previous?.role === "assistant" && message.role === "assistant" &&
      previous.content.some((block) => block.type === "toolCall") &&
      message.content.some((block) => block.type === "toolCall")) {
      const merged: AssistantMessage = {
        ...previous,
        content: [...previous.content, ...message.content],
        stopReason: "toolUse",
      };
      normalized[normalized.length - 1] = merged;
    } else normalized.push(message);
  }
  return normalized;
}

function groupConsecutiveAssistantToolCalls(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const message of messages) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    if (previous?.role === "assistant" && previous.toolCalls?.length &&
      message.role === "assistant" && message.toolCalls?.length)
      previousGroup!.push(message);
    else groups.push([message]);
  }
  return groups;
}

function sameSource(message: Message, settings: Settings) {
  return (
    message.providerState?.model === settings.model &&
    message.providerState.api ===
      (settings.protocol === "pi-subscription"
        ? "openai-codex-responses"
        : settings.protocol)
  );
}
function responseItems(
  message: Message,
  settings: Settings,
): Record<string, unknown>[] {
  if (message.role === "tool")
    return [
      {
        type: "function_call_output",
        call_id: wireCallId(message.toolCallId!),
        output: message.content,
      },
    ];
  const items: Record<string, unknown>[] = [];
  if (message.role === "assistant" && sameSource(message, settings)) {
    for (const block of message.providerState?.thinking || []) {
      if (!block.thinkingSignature) continue;
      const item = JSON.parse(block.thinkingSignature);
      if (item?.type !== "reasoning")
        throw new Error("保存的推理签名格式无效。");
      items.push(item);
    }
  }
  if (message.content || !message.toolCalls?.length)
    items.push({
      type: "message",
      role: message.role,
      content: message.content,
    });
  for (const call of message.toolCalls || []) {
    const [callId, itemId] = call.id.split("|");
    items.push({
      type: "function_call",
      call_id: callId,
      name: call.name,
      arguments: call.arguments,
      ...(sameSource(message, settings) && itemId?.startsWith("fc_")
        ? { id: itemId }
        : {}),
    });
  }
  return items;
}
function anthropicAssistantContent(message: Message, settings: Settings) {
  const thinking = sameSource(message, settings)
    ? (message.providerState?.thinking || [])
        .filter((block) => block.thinkingSignature)
        .map((block) => block.redacted
          ? { type: "redacted_thinking", data: block.thinkingSignature }
          : { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature })
    : [];
  return [
    ...thinking,
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...(message.toolCalls || []).map((call) => ({
      type: "tool_use",
      id: wireCallId(call.id),
      name: call.name,
      input: callArguments(call),
    })),
  ];
}
/** Keep edited text/roles exact while representing tools in each provider's native protocol. */
export function exactPayload(
  payload: unknown,
  settings: Settings,
  active: Message[],
): Record<string, unknown> {
  const value = { ...(payload as Record<string, unknown>) };
  if (settings.protocol === "openai-completions") {
    const messages: Record<string, unknown>[] = [];
    for (const group of groupConsecutiveAssistantToolCalls(active)) {
      if (group.length > 1) {
        messages.push({
          role: "assistant",
          content: group.map((message) => message.content).filter(Boolean).join("\n") || null,
          tool_calls: group.flatMap((message) => (message.toolCalls || []).map((call) => ({
            id: wireCallId(call.id),
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }))),
        });
        continue;
      }
      const m = group[0];
      messages.push(m.role === "tool"
        ? {
            role: "tool",
            tool_call_id: wireCallId(m.toolCallId!),
            content: m.content,
          }
        : {
            role: m.role,
            content: m.content || (m.toolCalls?.length ? null : ""),
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((call) => ({
                    id: wireCallId(call.id),
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          });
    }
    value.messages = messages;
  } else if (
    settings.protocol === "openai-responses" ||
    settings.protocol === "pi-subscription"
  ) {
    const subscription = settings.protocol === "pi-subscription";
    value.input = active
      .filter((m) => !subscription || m.role !== "system")
      .flatMap((m) => responseItems(m, settings));
    if (subscription)
      value.instructions = active
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
    else delete value.instructions;
  } else {
    const messages: { role: string; content: any }[] = [];
    for (const group of groupConsecutiveAssistantToolCalls(active.filter((m) => m.role !== "system"))) {
      if (group.length > 1) {
        messages.push({ role: "assistant", content: group.flatMap((message) => anthropicAssistantContent(message, settings)) });
        continue;
      }
      const m = group[0];
      if (m.role === "tool") {
        const result = {
          type: "tool_result",
          tool_use_id: wireCallId(m.toolCallId!),
          content: m.content,
          is_error: m.isError || false,
        };
        const previous = messages.at(-1);
        if (
          previous?.role === "user" &&
          Array.isArray(previous.content) &&
          previous.content.every((b: any) => b.type === "tool_result")
        )
          previous.content.push(result);
        else messages.push({ role: "user", content: [result] });
      } else if (
        m.role === "assistant" &&
        (m.toolCalls?.length || sameSource(m, settings))
      ) {
        messages.push({ role: "assistant", content: anthropicAssistantContent(m, settings) });
      } else messages.push({ role: m.role, content: m.content });
    }
    value.messages = messages;
    const system = active
      .filter((m) => m.role === "system")
      .map((m) => ({ type: "text", text: m.content }));
    if (system.length) value.system = system;
    else delete value.system;
  }
  return value;
}
