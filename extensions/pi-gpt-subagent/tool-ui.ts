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
function namesText(names: string[]) {
  return names.length ? names.map((name) => `「${name}」`).join("、") : "工兵";
}

/** Registry metadata is also consumed by the web UI, avoiding a second tool-name map. */
export const subagentToolUi = {
  subagent_dispatch: {
    name: "subagent_dispatch",
    displayName: "派发工兵任务",
    icon: "dispatch",
    summarizeInput(input: unknown) {
      const names = taskNames(record(input));
      return `派发工兵${namesText(names)}${names.length > 1 ? "等任务" : "任务"}`;
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
