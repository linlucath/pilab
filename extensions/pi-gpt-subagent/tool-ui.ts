export type SubagentToolIcon = "dispatch" | "query" | "control";
export type SubagentToolName = "subagent_dispatch" | "subagent_query" | "subagent_control";

export interface SubagentToolUiMetadata {
  name: SubagentToolName;
  displayName: string;
  icon: SubagentToolIcon;
  summarizeInput(input: unknown): string;
  summarizeResult(result: unknown): string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function taskNames(input: Record<string, unknown>): string[] {
  const one = record(input.task);
  const many = Array.isArray(input.tasks) ? input.tasks.map(record) : [];
  return [one.name, ...many.map((task) => task.name)].filter((name): name is string => typeof name === "string" && !!name.trim());
}
function compactText(value: string, limit = 56) {
  const normalized = value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}
function taskMessages(input: Record<string, unknown>): string[] {
  const one = record(input.task);
  const many = Array.isArray(input.tasks) ? input.tasks.map(record) : [];
  return [one.message, ...many.map((task) => task.message), input.message]
    .filter((message): message is string => typeof message === "string" && !!message.trim());
}
function dispatchTarget(input: Record<string, unknown>) {
  const names = taskNames(input).map((name) => compactText(name)).filter(Boolean);
  if (names.length) return compactText([...new Set(names)].slice(0, 2).join("、") + (names.length > 2 ? ` 等 ${names.length} 项` : ""));
  const message = taskMessages(input)[0];
  if (!message) return "";
  const intent = message.replace(/```[\s\S]*?```/g, "代码").replace(/\s+/g, " ").trim()
    .split(/(?<=[。！？.!?])/).map((part) => part.trim())
    .find((part) => !/^(?:you are\b|你是(?:一名|一个)|system prompt|系统提示)/i.test(part)) || "";
  return compactText(intent.replace(/^(?:请(?:你)?|任务(?:是|[:：])|目标(?:是|[:：]))\s*/, "").trim());
}

/** Registry metadata is also consumed by the web UI, avoiding a second tool-name map. */
export const subagentToolUi = {
  subagent_dispatch: {
    name: "subagent_dispatch",
    displayName: "派发工兵任务",
    icon: "dispatch",
    summarizeInput(input: unknown) {
      const target = dispatchTarget(record(input));
      return target ? `派发任务 · ${target}` : "派发任务";
    },
    summarizeResult(result: unknown) {
      const value = record(result);
      const started = Array.isArray(value.started) ? value.started.length : Array.isArray(value.sessions) ? value.sessions.length : 0;
      return typeof value.mode === "string" ? `${value.mode === "sync" ? "同步" : "后台"}派发 · ${started} 个会话` : "工兵任务派发";
    },
  },
  subagent_query: {
    name: "subagent_query",
    displayName: "查询工兵状态",
    icon: "query",
    summarizeInput(input: unknown) {
      const value = record(input);
      return value.action === "status" && typeof value.name === "string" ? `读取工兵「${value.name}」状态` : "查看工兵状态";
    },
    summarizeResult(result: unknown) {
      const value = record(result);
      const status = record(value.status);
      return typeof value.status === "string" ? `工兵状态 · ${value.status}`
        : typeof status.status === "string" ? `工兵状态 · ${status.status}`
          : Array.isArray(value.sessions) ? `工兵列表 · ${value.sessions.length} 个会话` : "工兵诊断";
    },
  },
  subagent_control: {
    name: "subagent_control",
    displayName: "控制工兵流程",
    icon: "control",
    summarizeInput(input: unknown) {
      const value = record(input);
      const action = value.action === "abort" ? "中止" : value.action === "respond" ? "回答" : value.action === "close" ? "关闭" : "控制";
      return `${action}工兵${typeof value.name === "string" ? `「${value.name}」` : ""}`;
    },
    summarizeResult(result: unknown) {
      const value = record(result);
      return `${typeof value.action === "string" ? value.action : "控制"} · ${typeof value.status === "string" ? value.status : "已处理"}`;
    },
  },
} satisfies Record<SubagentToolName, SubagentToolUiMetadata>;

export function subagentToolMetadata(name: string): SubagentToolUiMetadata | undefined {
  return Object.values(subagentToolUi).find((metadata) => metadata.name === name);
}
