import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { sessionForkArgsSchema, type Settings, type Message } from "../shared/schema";
import { buildForkMessages } from "../shared/session-fork";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createGptSessionTools } from "./gpt-subagent";
import { createImageTools } from "../extensions/pi-gpt-subagent/images";
import { projectImages } from "./images";
import type { ConversationHistory } from "../extensions/pi-gpt-subagent/tools";

function createContextCompactTool(getHistory: () => Message[], onEvent?: (event: Record<string, unknown>) => void): AgentTool<TSchema, unknown> {
  return {
    name: "context_compact",
    label: "脱水归档工具记录",
    description: "Mark completed historical tool-call steps as compacted while preserving the assistant call/result pairing. Supply exact toolCallIds from prior assistant tool calls and a concise modelSummary. The summary is kept in model context; raw results remain in the UI and can be restored. Only compact when enough information is captured in the summary.",
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 100 }),
      modelSummary: Type.String({ minLength: 1, maxLength: 12_000 }),
    }, { additionalProperties: false }),
    execute: async (_id: string, rawArgs: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("上下文脱水已取消。");
      const args = rawArgs as { toolCallIds: string[]; modelSummary: string };
      const summary = args.modelSummary.trim();
      if (!summary) throw new Error("modelSummary 不能为空。");
      const history = getHistory().filter((message) => message.enabled);
      const wireId = (id: string) => id.split("|")[0];
      const owners = new Map<string, Message>();
      const results = new Map<string, Message>();
      for (const message of history) {
        if (message.role === "assistant")
          for (const call of message.toolCalls ?? []) owners.set(wireId(call.id), message);
        if (message.role === "tool" && message.toolCallId) results.set(wireId(message.toolCallId), message);
      }
      const selectedOwners = new Set<Message>();
      for (const id of args.toolCallIds) {
        const key = wireId(id);
        const owner = owners.get(key);
        if (!owner || !results.has(key)) throw new Error(`工具调用 ${id} 尚未完成，或没有配对的工具结果，不能脱水。`);
        selectedOwners.add(owner);
      }
      const callIds = new Set<string>();
      const targets = new Set<Message>();
      for (const owner of selectedOwners) {
        const calls = owner.toolCalls ?? [];
        if (!calls.length || calls.some((call) => !results.has(wireId(call.id))))
          throw new Error("脱水必须保持同一条 assistant 消息中的所有工具调用与结果配对。");
        targets.add(owner);
        for (const call of calls) {
          callIds.add(call.id);
          targets.add(results.get(wireId(call.id))!);
        }
      }
      for (const message of targets) {
        message.compactedByModel = true;
        message.modelSummary = summary;
      }
      onEvent?.({
        type: "context_compacted",
        messageIds: [...targets].map((message) => message.id),
        toolCallIds: [...callIds],
        modelSummary: summary,
      });
      return { content: [{ type: "text", text: `已脱水归档 ${callIds.size} 个已完成工具调用；原始结果仍保留并可还原。` }], details: { messageIds: [...targets].map((message) => message.id), toolCallIds: [...callIds] } };
    },
  };
}

function createSessionForkTool(getHistory: () => Message[], onEvent?: (event: Record<string, unknown>) => void): AgentTool<TSchema, unknown> {
  return {
    name: "session_fork",
    label: "创建提纯分身",
    description: "Create a clean Pi Lab conversation fork from a concise distilled-memory summary. The UI preserves the parent's working directory and settings, records lineage, and carries zero recent turns by default for a fresh KV-cache prefix. Use only when the user explicitly asks to fork or distill this conversation; never replace or edit the parent.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200, description: "Title for the new conversation." }),
      distilledMemory: Type.String({ minLength: 1, maxLength: 20_000, description: "Memory crystal: core principles and conclusions, user preferences and constraints, proven dead ends, and the next concrete objective." }),
      keepRecentTurns: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Number of latest plain user/assistant turns to include after the memory; defaults to 0 for a clean prefix." })),
    }, { additionalProperties: false }),
    execute: async (_id: string, rawArgs: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("创建分身已取消。");
      const args = sessionForkArgsSchema.parse(rawArgs);
      const fork = {
        id: randomUUID(),
        title: args.title,
        forkSummary: args.distilledMemory,
        keepRecentTurns: args.keepRecentTurns,
        messages: buildForkMessages({
          messages: getHistory(),
          distilledMemory: args.distilledMemory,
          keepRecentTurns: args.keepRecentTurns,
          id: () => randomUUID(),
        }),
      };
      onEvent?.({ type: "session_forked", fork });
      return {
        content: [{ type: "text", text: `已为你派生提纯分身会话「${args.title}」，携带了核心记忆结晶。` }],
        details: { title: args.title, forkId: fork.id, keepRecentTurns: args.keepRecentTurns },
      };
    },
  };
}

export async function agentTools(
  settings: Settings,
  getHistory?: ConversationHistory,
  onEvent?: (event: Record<string, unknown>) => void,
  ownerSessionId?: string,
) {
  const cwd = settings.workingDirectory.trim() || process.cwd();
  if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("工具工作目录必须是存在的绝对路径目录。");
  const history = () => (getHistory?.() ?? []) as Message[];
  const tools: AgentTool<any>[] = [
    createContextCompactTool(history, onEvent),
    createSessionForkTool(history, onEvent),
    ...createGptSessionTools(cwd, getHistory, ownerSessionId),
    ...createImageTools(() => projectImages, "viewer") as unknown as AgentTool<TSchema, unknown>[],
  ];
  return { cwd, tools };
}
