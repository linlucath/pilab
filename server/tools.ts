import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../shared/schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export async function agentTools(settings: Settings) {
  const cwd = settings.workingDirectory.trim() || process.cwd();
  if (settings.toolMode === "none") return { cwd, tools: [] };
  if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("工具工作目录必须是存在的绝对路径目录。");
  const tools: AgentTool<any>[] = [
    createReadTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
  if (settings.toolMode === "agent")
    tools.push(createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd));
  return { cwd, tools };
}
