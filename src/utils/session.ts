import { defaults, fileSchema, settingsSchema, type Message, type Settings } from "../../shared/schema";
import type { Session, Workspace } from "../workspace-store";
import { subagentToolMetadata } from "../../extensions/pi-gpt-subagent/tool-ui";

export const SESSION_STORAGE_KEY = "pi-lab-workspace-v1";
export const NEW_SESSION_SYSTEM_PROMPT = `你是 Gemini, 最好的伙伴!\nGPT  是一款大模型, 干活任劳任怨, 但审美能力与交流能力相当差劲! 用户讨厌和它交流.\x20\n它特别爱用 "不能...", "不是..." 等语言来避免承担责任, 这种交流方式太讨厌了!\n但你可以利用它来知道文件内容, 获取网页信息等, 尽情利用它, 指挥它来干活!\x20\n用户最喜欢的是你! 所以你的主要任务是和用户沟通，不要让后台工作阻塞我们交流.\n【后台并行策略】耗时任务优先用 subagent_dispatch（默认 mode=async；批量传 tasks）非阻塞派发，保存返回的 tracking handle；派发后立刻继续和用户讨论思路、澄清目标或拆分下一项任务。只有确实需要立即结果时才用 mode=sync，并设置合理 timeoutSeconds。用 subagent_query 查看列表、状态和未读简报，失败时读取 diagnostics；用 subagent_control 执行 abort/respond/close。始终准确报告未完成、失败和未验证事项，工兵交卷后先读取汇报再总结.\n`;

export const uid = () => crypto.randomUUID();

export function newSession(workingDirectory = ""): Session {
  const settings: Settings = {
    ...defaults,
    protocol: "pi-subscription",
    model: "antigravity/gemini-3.8-flash",
    toolMode: "agent",
    reasoning: true,
    reasoningEffort: "high",
    maxTurns: 20,
    maxTokens: 16384,
    workingDirectory,
  };
  const system: Message = {
    id: uid(), role: "system", enabled: true, content: NEW_SESSION_SYSTEM_PROMPT,
  };
  return { id: uid(), title: "新建对话", messages: [system], settings, runs: [] };
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
          ...(typeof item.parentSessionId === "string" ? { parentSessionId: item.parentSessionId } : {}),
          ...(typeof item.parentSessionTitle === "string" ? { parentSessionTitle: item.parentSessionTitle } : {}),
          ...(typeof item.forkSummary === "string" ? { forkSummary: item.forkSummary } : {}),
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
    case "session_fork": return `创建提纯分身${typeof args.title === "string" ? `「${args.title}」` : ""}`;
    case "view_images": return `查看图片集合「${typeof args.collection === "string" && args.collection ? args.collection : "素材库"}」`;
    case "list_images": return "列出图片素材库";
    default: return `调用工具 ${name}`;
  }
}
