import { stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Settings } from "../shared/schema";
import type { ConversationHistory } from "../extensions/pi-gpt-subagent/tools";
import { createGptSessionTools } from "./gpt-subagent";
import { createViewImageTool } from "../extensions/pi-gpt-subagent/images";
import { projectImages } from "./images";
import { formatArtifactRead, readArtifact, writeArtifact } from "./artifacts";

export function createArtifactTools(ownerSessionId?: string, artifactsRoot?: string): AgentTool<TSchema, unknown>[] {
  const root = artifactsRoot;
  return [
    {
      name: "read_artifact",
      label: "读取会话成果",
      description: `读取当前会话专属 artifacts 成果目录中的文本文件；结果带行号，最多输出 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB。可用 offset 和 limit 分页读取。`,
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1024, description: "相对于当前会话 artifacts 目录的文件路径，例如 research/summary.md。" }),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "起始行号（从 1 开始）" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "最多读取的行数" })),
      }, { additionalProperties: false }),
      execute: async (_id: string, rawArgs: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("读取会话成果已取消。");
        const args = rawArgs as { path: string; offset?: number; limit?: number };
        const content = await readArtifact(ownerSessionId, args.path, root);
        return {
          content: [{ type: "text", text: formatArtifactRead(content, args.offset, args.limit) }],
          details: { path: args.path, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) },
        };
      },
    },
    {
      name: "write_artifact",
      label: "写入会话成果",
      description: "向当前会话专属 artifacts 成果目录安全写入或更新文本文件（用于沉淀整理调研成果、技术方案，避免挤占对话历史）",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1024, description: "相对于当前会话 artifacts 目录的文件路径，例如 outline.md。" }),
        content: Type.String({ description: "要写入文件的 UTF-8 文本内容。" }),
      }, { additionalProperties: false }),
      execute: async (_id: string, rawArgs: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("写入会话成果已取消。");
        const args = rawArgs as { path: string; content: string };
        const result = await writeArtifact(ownerSessionId, args.path, args.content, root);
        return {
          content: [{ type: "text", text: `已安全写入当前会话成果文件 ${args.path}（${result.bytes} bytes）。` }],
          details: { path: args.path, bytes: result.bytes },
        };
      },
    },
  ];
}

export async function agentTools(
  settings: Settings,
  getHistory?: ConversationHistory,
  ownerSessionId?: string,
) {
  const cwd = settings.workingDirectory.trim() || process.cwd();
  if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("工具工作目录必须是存在的绝对路径目录。");
  const tools: AgentTool<any>[] = [
    ...createGptSessionTools(cwd, getHistory, ownerSessionId),
    createViewImageTool(() => projectImages, () => cwd) as unknown as AgentTool<TSchema, unknown>,
    ...createArtifactTools(ownerSessionId),
  ];
  return { cwd, tools };
}
