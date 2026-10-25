import type { Message } from "./schema";

/** Build a clean fork prefix: original leading instructions, distilled memory, then optional recent plain turns. */
export function buildForkMessages(input: {
  messages: Message[];
  distilledMemory: string;
  keepRecentTurns?: number;
  id: () => string;
}): Message[] {
  const requested = input.keepRecentTurns ?? 0;
  const turnsToKeep = Number.isFinite(requested) ? Math.max(0, Math.min(6, Math.floor(requested))) : 0;
  const leading: Message[] = [];
  for (const message of input.messages) {
    if (message.role !== "system" && message.role !== "developer") break;
    if (message.enabled) leading.push({ ...message, id: input.id(), enabled: true });
  }

  const turns: Message[][] = [];
  let currentTurn: Message[] = [];
  for (const message of input.messages) {
    if (!message.enabled || !((message.role === "user") || (message.role === "assistant" && !message.toolCalls?.length)) ||
      (!message.content.trim() && !message.images?.length)) continue;
    if (message.role === "user") {
      if (currentTurn.length) turns.push(currentTurn);
      currentTurn = [message];
    } else if (currentTurn.length) currentTurn.push(message);
  }
  if (currentTurn.length) turns.push(currentTurn);
  const recent = (turnsToKeep ? turns.slice(-turnsToKeep).flat() : []).map((message) => ({
    ...message,
    id: input.id(),
    enabled: true,
    toolCalls: undefined,
    toolCallId: undefined,
    toolName: undefined,
    isError: undefined,
    compactedByModel: undefined,
    modelSummary: undefined,
    gptReply: undefined,
    providerState: undefined,
  }));

  const memory = input.distilledMemory.trim().slice(0, 20_000);
  return [
    ...leading,
    { id: input.id(), role: "system" as const, content: `【记忆结晶】\n${memory}`, enabled: true },
    ...recent,
  ].slice(0, 500);
}
