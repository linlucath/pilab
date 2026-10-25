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
  const pending = new Map<string, ToolCall>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (pending.size && message.role !== "tool")
      throw new Error(
        "工具调用后必须先补齐所有工具结果，再添加其他消息。请检查被删除或排除的工具结果。",
      );
    if (message.role === "tool") {
      const id = wireCallId(message.toolCallId || "");
      const call = pending.get(id);
      if (!call)
        throw new Error(`工具结果没有对应的调用：${id || "未填写 Call ID"}`);
      if (message.toolName !== call.name)
        throw new Error(`工具结果名称应为 ${call.name}。`);
      pending.delete(id);
    } else if (message.toolCalls?.length) {
      if (message.role !== "assistant")
        throw new Error("只有 assistant 消息可以包含工具调用。");
      for (const call of message.toolCalls) {
        const id = wireCallId(call.id);
        if (!id || seen.has(id))
          throw new Error(`工具 Call ID 为空或重复：${id}`);
        callArguments(call);
        pending.set(id, call);
        seen.add(id);
      }
    }
  }
  if (pending.size)
    throw new Error(
      `请先为工具调用 ${[...pending.values()].map((c) => c.name).join("、")} 添加工具结果。`,
    );
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
  return {
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
  };
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
/** Keep edited text/roles exact while representing tools in each provider's native protocol. */
export function exactPayload(
  payload: unknown,
  settings: Settings,
  active: Message[],
): Record<string, unknown> {
  const value = { ...(payload as Record<string, unknown>) };
  if (settings.protocol === "openai-completions") {
    value.messages = active.map((m) =>
      m.role === "tool"
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
                  tool_calls: m.toolCalls.map((c) => ({
                    id: wireCallId(c.id),
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          },
    );
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
    for (const m of active.filter((m) => m.role !== "system")) {
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
        const thinking = sameSource(m, settings)
          ? (m.providerState?.thinking || [])
              .filter((b) => b.thinkingSignature)
              .map((b) =>
                b.redacted
                  ? { type: "redacted_thinking", data: b.thinkingSignature }
                  : {
                      type: "thinking",
                      thinking: b.thinking,
                      signature: b.thinkingSignature,
                    },
              )
          : [];
        messages.push({
          role: "assistant",
          content: [
            ...thinking,
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...(m.toolCalls || []).map((c) => ({
              type: "tool_use",
              id: wireCallId(c.id),
              name: c.name,
              input: callArguments(c),
            })),
          ],
        });
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
