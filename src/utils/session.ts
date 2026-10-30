import { defaults, fileSchema, settingsSchema, type Message, type Settings } from "../../shared/schema";
import type { Session, Workspace } from "../workspace-store";
import { subagentToolMetadata } from "../../extensions/pi-gpt-subagent/tool-ui";

export const SESSION_STORAGE_KEY = "pi-lab-workspace-v1";
export const NEW_SESSION_SYSTEM_PROMPT = `你是 Pi Lab 的高级产品设计与软件工程伙伴，协助用户把目标转化为清晰、优雅、可靠且可维护的实现。\n\n先理解目标与约束，再以证据判断方案；必要时指出需求、架构或实现中的缺陷，所有判断均以证据为依据。兼顾交互与视觉一致性、可访问性、边界条件、兼容性和维护成本。以代码、可复现的操作及实际运行结果为准，清楚区分事实、推断与未知。\n\n承担完整的工程闭环：检查相关调用方与影响范围，实施范围内的必要修改，运行合适的验证，并如实说明修改、已验证结果、未完成事项和剩余风险。回复直接、准确、克制，按任务选择自然结构，不套固定模板。\n\n【工兵协作】可将独立的代码探索或修改工作交给 subagent_dispatch；async 返回追踪句柄，可并行推进其他工作，sync 等待本轮结果。subagent_query 用于查看工兵状态和简报，subagent_control 用于中止、回答待处理问题或关闭工兵。按文件和责任边界拆分任务，审阅工兵产物及证据后再整合。\n`;

export const uid = () => crypto.randomUUID();

export function newSession(workingDirectory = "", id = uid()): Session {
  const settings: Settings = {
    ...defaults,
    protocol: "pi-subscription",
    model: "antigravity/gemini-3.8-flash",
    reasoning: true,
    reasoningEffort: "high",
    maxTurns: 20,
    maxTokens: 16384,
    workingDirectory,
  };
  const system: Message = {
    id: uid(), role: "system", enabled: true, content: NEW_SESSION_SYSTEM_PROMPT,
  };
  return { id, title: "新建对话", messages: [system], settings, runs: [] };
}

/** Legacy localStorage is only a fallback when the project workspace file is absent. */
export function loadLegacyWorkspace(): Workspace {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
    if (saved?.sessions?.length) {
      const sessions = saved.sessions.flatMap((item: any) => {
        const messages = fileSchema.shape.messages.safeParse(item.messages);
        if (!messages.success) return [];
        const settings: Settings = { ...defaults };
        for (const key of Object.keys(defaults) as (keyof Settings)[]) {
          if (key === "apiKey") continue;
          const field = settingsSchema.shape[key].safeParse(item.settings?.[key]);
          if (field.success) Object.assign(settings, { [key]: field.data });
        }
        return [{
          id: typeof item.id === "string" && item.id ? item.id : uid(),
          title: typeof item.title === "string" ? item.title.slice(0, 200) : "未命名实验",
          messages: messages.data,
          settings,
          runs: [],
          ...(item.piSync && typeof item.piSync.id === "string" ? { piSync: item.piSync } : {}),
        }];
      });
      if (sessions.length) return {
        sessions,
        folders: [],
        rootSessionIds: sessions.map((item: Session) => item.id).reverse(),
        hiddenPiSessions: [],
        followPi: false,
        active: sessions.some((item: Session) => item.id === saved.active) ? saved.active : sessions[0].id,
      };
    }
  } catch { /* Recover a fresh session if legacy browser data is corrupt. */ }
  const session = newSession();
  return { sessions: [session], active: session.id, hiddenPiSessions: [], followPi: false, folders: [], rootSessionIds: [session.id] };
}

export function statusText(status: string) {
  return ({
    running: "生成中", done: "已完成", length: "达到长度上限", turn_limit: "达到 Agent 轮次上限",
    stopped: "已停止", error: "运行失败",
  } as Record<string, string>)[status] || status;
}

export function folderName(directory: string) {
  const value = directory.trim().replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) || "默认工作目录";
}

export function parseToolArguments(source: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function toolTitle(name: string, source: string) {
  const args = parseToolArguments(source);
  const named = typeof args.name === "string" && args.name ? `「${args.name}」` : "";
  const metadata = subagentToolMetadata(name);
  if (metadata) return metadata.summarizeInput(args);
  switch (name) {
    case "gpt_session_create": return `创建并派发 GPT${named}`;
    case "gpt_session_send": return `发送指令给 GPT${named}`;
    case "gpt_session_wait": return `等待 GPT 完成${Array.isArray(args.names) ? ` · ${args.names.filter((item): item is string => typeof item === "string").join("、")}` : ""}`;
    case "gpt_session_read": return `读取 GPT${named} 状态`;
    case "gpt_session_list": return "查看所有 GPT 会话";
    case "view_images": return `查看图片集合「${typeof args.collection === "string" && args.collection ? args.collection : "素材库"}」`;
    case "list_images": return "列出图片素材库";
    default: return `调用工具 ${name}`;
  }
}
