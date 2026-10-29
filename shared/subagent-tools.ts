function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Compact large task messages while preserving the new dispatch shape in model context. */
export function compactSubagentDispatchArguments(source: string, summary: string, maxMessageChars = 800): string {
  try {
    const parsed: unknown = JSON.parse(source);
    const value = record(parsed);
    const compact = (task: Record<string, unknown>) => typeof task.message === "string" && task.message.length > maxMessageChars
      ? { ...task, message: `任务摘要：${summary.slice(0, maxMessageChars)}` }
      : task;
    if (typeof value.message === "string") return JSON.stringify(compact(value));
    if (value.task && typeof value.task === "object" && !Array.isArray(value.task))
      return JSON.stringify({ ...value, task: compact(record(value.task)) });
    if (Array.isArray(value.tasks)) return JSON.stringify({ ...value, tasks: value.tasks.map((task) => compact(record(task))) });
    return source;
  } catch {
    return source;
  }
}
