import type { Message } from "../../shared/schema";

type CompactedMessage = Message & { compactedByModel?: boolean; modelSummary?: string };

export function estimateTextTokens(value: string) {
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.35 + other / 4);
}

export function estimateMessageTokens(message: Message) {
  const extra = message.toolCalls?.map((call) => `${call.name} ${call.arguments}`).join(" ") || "";
  const thinking = message.providerState?.thinking.map((block) => block.thinking).join(" ") || "";
  const images = (message.images?.length || 0) * 85;
  return 4 + estimateTextTokens(`${message.role} ${message.content} ${thinking} ${extra}`) + images;
}

function estimateCompactedMessageTokens(message: Message, summary: string, includeSummary: boolean) {
  let tokens = includeSummary ? 4 + estimateTextTokens(`[已脱水归档] ${summary}`) : 0;
  if (message.role === "assistant") {
    for (const call of message.toolCalls || []) {
      let args = call.arguments;
      if (["gpt_session_create", "gpt_session_send"].includes(call.name)) {
        try {
          const parsed = JSON.parse(args) as Record<string, unknown>;
          if (typeof parsed.message === "string" && parsed.message.length > 800)
            args = JSON.stringify({ ...parsed, message: `任务摘要：${summary.slice(0, 800)}` });
        } catch { /* Preserve malformed historical arguments in the estimate. */ }
      }
      tokens += 4 + estimateTextTokens(`${call.name} ${call.id} ${args}`);
    }
  } else if (message.role === "tool") {
    tokens += estimateTextTokens("[已脱水归档] 结果已并入同组摘要。");
  }
  return tokens;
}

export function contextTokenMetrics(messages: Message[]) {
  const uncompressed = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  let context = 0;
  let previousSummary = "";
  for (const message of messages) {
    if (!message.enabled) { previousSummary = ""; continue; }
    const compacted = message as CompactedMessage;
    const isCompacted = compacted.compactedByModel === true || !!compacted.modelSummary?.trim();
    if (isCompacted) {
      const summary = compacted.modelSummary?.trim() || "工具调用已归档。";
      context += estimateCompactedMessageTokens(message, summary, summary !== previousSummary);
      previousSummary = summary;
    } else {
      context += estimateMessageTokens(message);
      previousSummary = "";
    }
  }
  return { context, savedPercent: uncompressed ? Math.max(0, Math.min(100, Math.round((1 - context / uncompressed) * 100))) : 0 };
}
