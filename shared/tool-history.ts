import type { Message, ToolCall } from "./schema";

export function wireToolCallId(id: string) {
  return id.split("|")[0];
}

export function toolHistoryError(messages: Message[]): string | null {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (pending.size && message.role !== "tool")
      return "工具调用后必须先补齐所有工具结果，再添加其他消息。请检查被删除或排除的工具结果。";
    if (message.role === "tool") {
      const id = wireToolCallId(message.toolCallId || "");
      const callName = pending.get(id);
      if (!id || !callName)
        return `工具结果没有对应的调用：${id || "未填写 Call ID"}`;
      if (message.toolName !== callName)
        return `工具结果名称应为 ${callName}。`;
      pending.delete(id);
    } else if (message.toolCalls?.length) {
      if (message.role !== "assistant")
        return "只有 assistant 消息可以包含工具调用。";
      for (const call of message.toolCalls) {
        const id = wireToolCallId(call.id);
        if (!id || seen.has(id))
          return `工具 Call ID 为空或重复：${id}`;
        pending.set(id, call.name);
        seen.add(id);
      }
    }
  }
  if (pending.size)
    return `请先为工具调用 ${[...pending.values()].join("、")} 添加工具结果。`;
  return null;
}

export function pairedToolResultIds(messages: Message[], assistant: Message) {
  const ids = new Set((assistant.toolCalls || []).map((call) => wireToolCallId(call.id)));
  return new Set(messages
    .filter((message) => message.role === "tool" && ids.has(wireToolCallId(message.toolCallId || "")))
    .map((message) => message.id));
}

export function findToolCallOwner(messages: Message[], tool: Message) {
  if (tool.role !== "tool") return undefined;
  const id = wireToolCallId(tool.toolCallId || "");
  return messages.find((message) => message.role === "assistant" &&
    message.toolCalls?.some((call) => wireToolCallId(call.id) === id));
}

export function patchMessageWithToolPairs(messages: Message[], id: string, patch: Partial<Message>) {
  const target = messages.find((message) => message.id === id);
  if (!target) return messages;
  let next = messages.map((message) => message.id === id ? { ...message, ...patch } : message);

  if (patch.enabled !== undefined && (target.toolCalls?.length || target.role === "tool")) {
    const owner = target.role === "assistant" ? target : findToolCallOwner(messages, target);
    if (owner) {
      const resultIds = pairedToolResultIds(messages, owner);
      next = next.map((message) => message.id === owner.id || resultIds.has(message.id)
        ? { ...message, enabled: patch.enabled! }
        : message);
    }
  }

  if (target.role === "tool" && (patch.toolCallId !== undefined || patch.toolName !== undefined)) {
    const owner = findToolCallOwner(messages, target);
    if (owner) {
      const oldId = wireToolCallId(target.toolCallId || "");
      next = next.map((message) => message.id !== owner.id ? message : {
        ...message,
        toolCalls: message.toolCalls?.map((call) => wireToolCallId(call.id) !== oldId ? call : {
          ...call,
          ...(patch.toolCallId !== undefined ? { id: patch.toolCallId } : {}),
          ...(patch.toolName !== undefined ? { name: patch.toolName } : {}),
        }),
      });
    }
  }
  return next;
}

export function patchToolCallWithResult(messages: Message[], assistantId: string, index: number, patch: Partial<ToolCall>) {
  const assistant = messages.find((message) => message.id === assistantId && message.role === "assistant");
  const oldCall = assistant?.toolCalls?.[index];
  if (!assistant || !oldCall) return messages;
  const oldId = wireToolCallId(oldCall.id);
  const nextCall = { ...oldCall, ...patch };
  const next = messages.map((message) => {
    if (message.id === assistantId)
      return { ...message, toolCalls: message.toolCalls?.map((call, position) => position === index ? nextCall : call) };
    if (message.role === "tool" && wireToolCallId(message.toolCallId || "") === oldId)
      return { ...message,
        ...(patch.id !== undefined ? { toolCallId: patch.id } : {}),
        ...(patch.name !== undefined ? { toolName: patch.name } : {}),
      };
    return message;
  });
  return next;
}

export function deleteToolCallWithResult(messages: Message[], assistantId: string, callId: string) {
  const assistant = messages.find((message) => message.id === assistantId && message.role === "assistant");
  if (!assistant?.toolCalls?.length) return messages;
  const key = wireToolCallId(callId);
  const remaining = assistant.toolCalls.filter((call) => wireToolCallId(call.id) !== key);
  const resultIds = new Set(messages.filter((message) => message.role === "tool" && wireToolCallId(message.toolCallId || "") === key).map((message) => message.id));
  const removeAssistant = !remaining.length && !assistant.content.trim() && !assistant.images?.length && !assistant.providerState?.thinking.length;
  return messages.flatMap((message) => {
    if (resultIds.has(message.id) || (removeAssistant && message.id === assistant.id)) return [];
    if (message.id === assistant.id) return [{ ...message, toolCalls: remaining.length ? remaining : undefined }];
    return [message];
  });
}

export function deleteMessageWithToolPairs(messages: Message[], id: string) {
  const target = messages.find((message) => message.id === id);
  if (!target) return messages;
  if (target.role === "assistant" && target.toolCalls?.length) {
    const resultIds = pairedToolResultIds(messages, target);
    return messages.filter((message) => message.id !== target.id && !resultIds.has(message.id));
  }
  if (target.role === "tool") {
    const owner = findToolCallOwner(messages, target);
    if (owner) {
      const key = wireToolCallId(target.toolCallId || "");
      const remaining = owner.toolCalls?.filter((call) => wireToolCallId(call.id) !== key) || [];
      const emptyOwner = !remaining.length && !owner.content.trim() && !owner.images?.length && !owner.providerState?.thinking.length;
      return messages.flatMap((message) => {
        if (message.id === target.id || (emptyOwner && message.id === owner.id)) return [];
        if (message.id === owner.id) return [{ ...message, toolCalls: remaining }];
        return [message];
      });
    }
  }
  return messages.filter((message) => message.id !== id);
}

export function completeToolBranchEnd(messages: Message[], index: number): number | null {
  const target = messages[index];
  if (!target) return null;
  if (target.role !== "assistant" && target.role !== "tool") return index;
  const owner = target.role === "assistant" ? target : findToolCallOwner(messages, target);
  if (!owner?.toolCalls?.length) return target.role === "tool" ? null : index;
  const ownerIndex = messages.findIndex((message) => message.id === owner.id);
  const pending = new Map(owner.toolCalls.map((call) => [wireToolCallId(call.id), call.name]));
  let end = ownerIndex;
  for (let cursor = ownerIndex + 1; cursor < messages.length && pending.size; cursor++) {
    const message = messages[cursor];
    if (message.role !== "tool") return null;
    const id = wireToolCallId(message.toolCallId || "");
    if (pending.get(id) !== message.toolName) return null;
    pending.delete(id);
    end = cursor;
  }
  return pending.size ? null : Math.max(end, index);
}
