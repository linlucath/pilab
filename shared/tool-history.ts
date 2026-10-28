import type { Message, ToolCall } from "./schema";

export function wireToolCallId(id: string) {
  return id.split("|")[0];
}

export function addToolResult(
  messages: Message[],
  assistantId: string,
  callId: string,
  content: string,
  isError: boolean,
): Message[] {
  const assistantIndex = messages.findIndex((message) => message.id === assistantId);
  const assistant = messages[assistantIndex];
  if (!assistant || assistant.role !== "assistant" || messages.filter((message) => message.id === assistantId).length !== 1)
    throw new Error("找不到唯一对应的 assistant 工具调用。");

  const requestedId = wireToolCallId(callId);
  const matchingCalls = messages.flatMap((message) => (message.toolCalls || []).map((item) => ({ owner: message, call: item })))
    .filter(({ call: item }) => wireToolCallId(item.id) === requestedId);
  if (!requestedId || matchingCalls.length !== 1 || matchingCalls[0].owner.id !== assistant.id)
    throw new Error("该 assistant 消息中找不到唯一对应的工具调用。");
  const call = matchingCalls[0].call;
  if (messages.some((message) => message.role === "tool" && wireToolCallId(message.toolCallId || "") === requestedId))
    throw new Error("该工具调用已经有结果，不能重复补全。");

  const siblingCalls = new Map((assistant.toolCalls || []).map((item) => [wireToolCallId(item.id), item]));
  let insertAt = assistantIndex + 1;
  const seenResultIds = new Set<string>();
  while (insertAt < messages.length && messages[insertAt].role === "tool") {
    const next = messages[insertAt];
    const nextId = wireToolCallId(next.toolCallId || "");
    const sibling = siblingCalls.get(nextId);
    if (!sibling || sibling.name !== next.toolName || next.enabled !== assistant.enabled || seenResultIds.has(nextId))
      throw new Error("现有工具结果与该调用不匹配，不能安全插入结果。");
    seenResultIds.add(nextId);
    insertAt++;
  }
  if (messages.some((message, index) => message.role === "tool" && siblingCalls.has(wireToolCallId(message.toolCallId || "")) && (index <= assistantIndex || index >= insertAt)))
    throw new Error("现有工具结果不在调用对应的位置，不能安全插入结果。");

  let id = globalThis.crypto.randomUUID();
  while (messages.some((message) => message.id === id)) id = globalThis.crypto.randomUUID();
  const result: Message = {
    id,
    role: "tool",
    content,
    enabled: assistant.enabled,
    toolCallId: call.id,
    toolName: call.name,
    isError,
  };
  const next = [...messages];
  next.splice(insertAt, 0, result);
  return next;
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
