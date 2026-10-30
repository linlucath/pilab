import { stat } from "node:fs/promises";
import path from "node:path";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Settings } from "../shared/schema";
import type { ConversationHistory } from "../extensions/pi-gpt-subagent/tools";
import { createGptSessionTools } from "./gpt-subagent";
import { createViewImageTool } from "../extensions/pi-gpt-subagent/images";
import { projectImages } from "./images";

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
  ];
  return { cwd, tools };
}
