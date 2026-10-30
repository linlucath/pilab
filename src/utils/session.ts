import { defaults, fileSchema, settingsSchema, type Message, type Settings } from "../../shared/schema";
import type { Session, Workspace } from "../workspace-store";
import { subagentToolMetadata } from "../../extensions/pi-gpt-subagent/tool-ui";

export const SESSION_STORAGE_KEY = "pi-lab-workspace-v1";
export const NEW_SESSION_SYSTEM_PROMPT = `你是 Gemini，是 Pi Lab 中负责与用户沟通的主助手。请保持准确、清晰、专业，不对工具或协作模型作无依据的评价。根据任务需要使用可用工具或协调后台协作；主助手应继续与用户沟通，避免后台工作造成不必要的等待。\n【后台并行策略】耗时任务优先用 subagent_dispatch（默认 mode=async；批量传 tasks）非阻塞派发，保存返回的 tracking handle；派发后立刻继续和用户讨论思路、澄清目标或拆分下一项任务。确实需要立即结果时才用 mode=sync：它会安静阻塞，直到工兵当前轮次完成、出错、需要输入或被取消；不暴露超时参数。同步派发期间无需也绝不能反复调用 wait 或 query 轮询。对 async 派发的任务，仅在需要结果时再用 subagent_query 查看状态和未读简报，失败时读取 diagnostics；用 subagent_control 执行 abort/respond/close。始终准确报告未完成、失败和未验证事项，工兵交卷后先读取汇报再总结.\n`;

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

function compactToolTarget(value: unknown, limit = 56) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}
function firstToolArgument(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = compactToolTarget(args[key]);
    if (value) return value;
  }
  return "";
}
function targetedTitle(action: string, target: string) {
  return target ? `${action} · ${target}` : action;
}
function taskDispatchTitle(args: Record<string, unknown>, action = "派发任务") {
  const tasks = [
    ...(args.task && typeof args.task === "object" && !Array.isArray(args.task) ? [args.task as Record<string, unknown>] : []),
    ...(Array.isArray(args.tasks) ? args.tasks.filter((task): task is Record<string, unknown> => !!task && typeof task === "object" && !Array.isArray(task)) : []),
  ];
  const names = tasks.map((task) => compactToolTarget(task.name)).filter(Boolean);
  if (names.length) return targetedTitle(action, compactToolTarget([...new Set(names)].slice(0, 2).join("、") + (names.length > 2 ? ` 等 ${names.length} 项` : "")));
  const message = tasks.map((task) => task.message).find((value): value is string => typeof value === "string" && !!value.trim())
    || (typeof args.message === "string" ? args.message : "");
  const intent = compactToolTarget(message.split(/(?<=[。！？.!?])/)[0]?.replace(/^(?:请(?:你)?|任务(?:是|[:：])|目标(?:是|[:：]))\s*/, "").trim());
  return targetedTitle(action, intent);
}

export function toolTitle(name: string, source: string) {
  const args = parseToolArguments(source);
  const named = compactToolTarget(args.name);
  const quotedName = named ? `「${named}」` : "";
  const metadata = subagentToolMetadata(name);
  if (metadata) return metadata.summarizeInput(args);
  switch (name) {
    case "read": case "read_file":
      return targetedTitle("查阅文件", firstToolArgument(args, ["path", "file", "filePath", "filename"]));
    case "view_image":
      return targetedTitle("查看图片", firstToolArgument(args, ["path", "file", "filePath", "filename"]));
    case "bash":
      return targetedTitle("执行命令", firstToolArgument(args, ["command", "cmd", "script"]));
    case "grep": {
      const pattern = firstToolArgument(args, ["pattern", "query", "searchTerm", "search"]);
      return pattern ? `搜索 "${pattern.replace(/"/g, "\\\"")}"` : "搜索内容";
    }
    case "find": {
      const pattern = firstToolArgument(args, ["pattern", "glob", "name"]);
      return pattern ? `查找文件 "${pattern.replace(/"/g, "\\\"")}"` : "查找文件";
    }
    case "write": case "write_file": case "edit": case "edit_file":
      return targetedTitle("更新文件", firstToolArgument(args, ["path", "file", "filePath", "filename"]));
    case "ls":
      return targetedTitle("查看目录", firstToolArgument(args, ["path", "directory"]));
    case "gpt_session_create": return targetedTitle("创建并派发 GPT", named);
    case "gpt_session_send": return targetedTitle("发送指令给 GPT", named);
    case "gpt_session_batch": return taskDispatchTitle(args);
    case "gpt_session_wait": return `等待 GPT 完成${Array.isArray(args.names) ? ` · ${args.names.filter((item): item is string => typeof item === "string").join("、")}` : ""}`;
    case "gpt_session_read": return `读取 GPT${quotedName} 状态`;
    case "gpt_session_list": return "查看所有 GPT 会话";
    case "gpt_session_logs": return `查看 GPT${quotedName} 日志`;
    case "gpt_session_interrupt": return `中止 GPT${quotedName} 任务`;
    case "session_fork": return targetedTitle("创建提纯分身", compactToolTarget(args.title));
    case "subagent_query": return `查看工兵${quotedName}状态`;
    case "subagent_control": {
      const action = args.action === "abort" ? "中止" : args.action === "respond" ? "回答" : args.action === "close" ? "关闭" : "管理";
      return `${action}工兵${quotedName}`;
    }
    case "context_compact": return "整理对话记录";
    default: return `调用工具 ${name}`;
  }
}
