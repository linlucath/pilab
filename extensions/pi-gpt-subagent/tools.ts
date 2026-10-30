import { createHash } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { subagentToolUi, type SubagentToolUiMetadata } from "./tool-ui.ts";
import { ToolRegistry } from "./registry.ts";
import {
  type GptRolePreset, type GptSessionManager,
  type ProgressEvent, type SessionInfo, type SessionStatus,
} from "./sessions.ts";

export interface SessionAccess {
  manager: GptSessionManager;
  resolveModel(requested?: string): Promise<string> | string;
}
export type ConversationHistory = () => readonly ConversationHistoryMessage[];
/** Pi-native tool shape shared with extension tools, without erasing inputs to `any`. */
export interface SessionTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  defaultActive?: boolean;
  parameters: TSchema;
  execute(
    id: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionToolContext,
  ): Promise<AgentToolResult<unknown>>;
}

export const DEFAULT_REPLY_MAX_CHARS = 3_200;
export const MIN_REPLY_MAX_CHARS = 500;
export const MAX_REPLY_MAX_CHARS = 24_000;
const sessionName = Type.String({ minLength: 1, maxLength: 160, description: "Unique conversation name or tracking handle returned by subagent_dispatch." });
const message = Type.String({ minLength: 1, maxLength: 100_000, description: "Task or follow-up text sent to the worker unchanged." });
const rolePreset = Type.Union([
  Type.Literal("scout"), Type.Literal("experimenter"), Type.Literal("implementer"),
], { description: "探路学者 scout、路径实验员 experimenter、工程执行员 implementer。" });
const taskSchema = Type.Object({
  name: sessionName,
  message,
  rolePreset: Type.Optional(rolePreset),
  action: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("create"), Type.Literal("send")])),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  sendMode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")])),
}, { additionalProperties: false });
type DispatchTask = Static<typeof taskSchema>;
const maxChars = Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS }));
const dispatchSchema = Type.Object({
  task: Type.Optional(taskSchema),
  tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: 8 })),
  mode: Type.Optional(Type.Union([Type.Literal("async"), Type.Literal("sync")])),
  maxChars,
}, { additionalProperties: false });
type DispatchInput = Static<typeof dispatchSchema>;
const querySchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("status")]),
  name: Type.Optional(sessionName),
  repeat: Type.Optional(Type.Boolean({ description: "Deliberately reread the latest completed brief." })),
  diagnostics: Type.Optional(Type.Boolean({ description: "Include bounded failure diagnostics and recent tool details." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  maxChars,
}, { additionalProperties: false });
type QueryInput = Static<typeof querySchema>;
const controlSchema = Type.Object({
  action: Type.Union([Type.Literal("abort"), Type.Literal("respond"), Type.Literal("close")]),
  name: sessionName,
  question: Type.Optional(Type.Integer({ minimum: 1 })),
  value: Type.Optional(Type.String({ maxLength: 100_000 })),
  confirmed: Type.Optional(Type.Boolean()),
  cancelled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const legacyCreateSchema = Type.Object({
  name: sessionName, rolePreset: Type.Optional(rolePreset), message: Type.Optional(message),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  wait: Type.Optional(Type.Boolean()),
  maxChars,
}, { additionalProperties: false });
const legacySendSchema = Type.Object({
  name: sessionName, message, rolePreset: Type.Optional(rolePreset),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")])),
  wait: Type.Optional(Type.Boolean()),
  maxChars,
}, { additionalProperties: false });
const legacyBatchTaskSchema = Type.Object({
  name: sessionName, message, rolePreset: Type.Optional(rolePreset),
  action: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("create"), Type.Literal("send")])),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")])),
}, { additionalProperties: false });
const legacyBatchSchema = Type.Object({
  tasks: Type.Array(legacyBatchTaskSchema, { minItems: 1, maxItems: 8 }),
  wait: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("any"), Type.Literal("all")])),
  maxChars,
}, { additionalProperties: false });
const legacyListSchema = Type.Object({}, { additionalProperties: false });
const legacyReadSchema = Type.Object({ name: sessionName, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), repeat: Type.Optional(Type.Boolean()), maxChars }, { additionalProperties: false });
const legacyWaitSchema = Type.Object({
  names: Type.Array(sessionName, { minItems: 1, maxItems: 8 }),
  mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
  maxChars,
}, { additionalProperties: false });
const legacyLogsSchema = Type.Object({ name: sessionName, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }, { additionalProperties: false });
const legacyRespondSchema = Type.Object({
  name: sessionName, question: Type.Optional(Type.Integer({ minimum: 1 })), value: Type.Optional(Type.String({ maxLength: 100_000 })),
  confirmed: Type.Optional(Type.Boolean()), cancelled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const legacyNameSchema = Type.Object({ name: sessionName }, { additionalProperties: false });

const clip = (text: string, length: number) => text.length <= length ? text : `${text.slice(0, length)}\n…（内容已截断）`;

export function clipReply(text: string, maxChars = DEFAULT_REPLY_MAX_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < MIN_REPLY_MAX_CHARS || maxChars > MAX_REPLY_MAX_CHARS)
    throw new Error(`回复长度预算必须在 ${MIN_REPLY_MAX_CHARS}–${MAX_REPLY_MAX_CHARS} 字符之间。`);
  if (text.length <= maxChars) return text;
  const notice = `\n\n[上下文保护：回复已按 ${maxChars} 字符预算截断；如需更多细节，请向工兵追问。]`;
  return text.slice(0, maxChars - notice.length) + notice;
}

interface Activity {
  tool: string;
  action?: string;
  status: "running" | "done" | "error" | "stopped";
  output?: string;
}
function toolActivity(events: ProgressEvent[], status: SessionStatus): Activity[] {
  const calls: Activity[] = [];
  const byId = new Map<string, Activity>();
  for (const event of events) {
    if (!event.toolName || !["tool_start", "tool_progress", "tool_end"].includes(event.type)) continue;
    let call = event.toolCallId ? byId.get(event.toolCallId) : undefined;
    if (!call && !event.toolCallId && event.type !== "tool_start")
      call = [...calls].reverse().find((item) => item.tool === event.toolName && item.status === "running");
    if (!call) {
      call = { tool: event.toolName, status: "running" };
      calls.push(call);
      if (event.toolCallId) byId.set(event.toolCallId, call);
    }
    if (event.type === "tool_start") {
      try {
        const args: unknown = JSON.parse(event.text);
        if (args && typeof args === "object" && !Array.isArray(args)) {
          const input = args as Record<string, unknown>;
          const target = input.command ?? input.query ?? input.path ?? input.pattern ?? input.url;
          if (typeof target === "string") call.action = clip(target.replace(/\s+/g, " ").trim(), 160);
        }
      } catch { /* Older logs may not contain structured arguments. */ }
    } else if (event.text) call.output = event.text;
    if (event.type === "tool_end") call.status = event.isError ? "error" : "done";
  }
  if (!["starting", "running", "waiting_input"].includes(status))
    for (const call of calls) if (call.status === "running") call.status = "stopped";
  return calls;
}

export function conversationSummary(session: SessionInfo) {
  return {
    name: session.name,
    handle: session.id,
    status: session.status,
    ...(session.role ? { role: session.role } : {}),
    ...(session.rolePreset ? { rolePreset: session.rolePreset } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.pendingInput.length ? { questions: session.pendingInput.map((item, index) => ({
      question: index + 1,
      type: item.method,
      title: item.title,
      ...(item.message ? { message: item.message } : {}),
      ...(Array.isArray(item.options) ? { options: item.options.filter((option): option is string => typeof option === "string") } : {}),
    })) } : {}),
  };
}

export function readConversation(manager: GptSessionManager, name: string, limit = 5, details = false, maxChars = DEFAULT_REPLY_MAX_CHARS) {
  const session = manager.read(name, 0, 1).session;
  const events = manager.recentEvents(name);
  let lastStart = -1;
  events.forEach((event, index) => { if (event.type === "running") lastStart = index; });
  const currentEvents = lastStart < 0 ? events : events.slice(lastStart);
  const activity = toolActivity(currentEvents, session.status).slice(-limit).map(({ action, output, ...call }) => ({
    ...call,
    ...(details && action ? { action } : {}),
    ...(details && output ? { output: clip(output, 6_000) } : {}),
  }));
  return {
    ...conversationSummary(session),
    ...(session.lastText ? { reply: details ? clip(session.lastText, 64_000) : clipReply(session.lastText, maxChars) } : {}),
    ...(session.partialText ? { writing: clip(session.partialText, details ? 16_000 : 6_000) } : {}),
    ...(activity.length && (details || session.status !== "idle" || !session.lastText || activity.some((item) => item.status === "error"))
      ? { activity } : {}),
  };
}

const stateLabels: Record<SessionStatus, string> = {
  starting: "正在启动", running: "正在工作", idle: "本轮已结束", waiting_input: "等待回答",
  interrupted: "已打断", suspended: "已暂停", closed: "已关闭", error: "运行出错",
};
export function formatConversationRead(read: ReturnType<typeof readConversation> & { unchanged?: boolean }): string {
  const lines = [`${read.name} · ${stateLabels[read.status]}`];
  if (read.error) lines.push(`错误：${read.error}`);
  if (read.reply) lines.push(`最近简报\n\n${read.reply}`);
  if (read.writing) lines.push(`正在回复\n\n${read.writing}`);
  if (read.unchanged) lines.push("暂无新简报。");
  else if (!read.reply && !read.writing && !read.questions?.length) lines.push("工兵暂时还没有发来简报。");
  if (read.questions?.length) lines.push("需要回答\n" + read.questions.map((question) => [
    `${question.question}. ${question.title || question.message || "等待输入"}`,
    question.title && question.message ? question.message : "",
    question.options?.length ? `选项：${question.options.join(" / ")}` : "",
    question.type === "confirm" ? "请回答是或否。" : "",
  ].filter(Boolean).join("\n")).join("\n\n"));
  if (read.activity?.length) lines.push("最近操作\n" + read.activity.map((item) => {
    const status = { running: "执行中", done: "已完成", error: "失败", stopped: "已停止" }[item.status];
    return `- ${status} · ${item.tool}${item.action ? `：${item.action}` : ""}${item.output ? `\n${item.output}` : ""}`;
  }).join("\n"));
  return lines.join("\n\n");
}

export interface ConversationHistoryMessage {
  role?: string;
  toolName?: string;
  content?: unknown;
  details?: unknown;
  gptReply?: ReplyDelivery;
}
export interface ReplyDelivery { session: string; sequence: number; digest: string }
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function replyDelivery(details: unknown): ReplyDelivery | undefined {
  const value = asRecord(details).piLabGptReply;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const delivery = value as Record<string, unknown>;
  return typeof delivery.session === "string" && /^gpt-[a-f0-9-]+$/.test(delivery.session) &&
    Number.isSafeInteger(delivery.sequence) && typeof delivery.sequence === "number" && delivery.sequence >= 0 &&
    typeof delivery.digest === "string" && /^[a-f0-9]{64}$/.test(delivery.digest)
    ? { session: delivery.session, sequence: delivery.sequence, digest: delivery.digest }
    : undefined;
}

/** Existing transcript history is the durable, parent-local source for deduplicating replies. */
function alreadyDelivered(history: readonly ConversationHistoryMessage[], delivery: ReplyDelivery, reply: string) {
  return history.some((item) => {
    if (!["tool", "toolResult"].includes(item.role || "") || !["subagent_query", "gpt_session_read", "gpt_session_wait"].includes(item.toolName || "")) return false;
    const previous = item.gptReply ?? replyDelivery(item.details);
    const content = item.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => asRecord(part)).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n")
      : "";
    return previous?.session === delivery.session && previous.sequence === delivery.sequence && previous.digest === delivery.digest && text.includes(reply);
  });
}

export async function answerConversation(manager: GptSessionManager, args: {
  name: string; question?: number; value?: string; confirmed?: boolean; cancelled?: boolean;
}, owner?: string) {
  if (owner) manager.assertOwner(args.name, owner);
  const pending = manager.read(args.name, 0, 1).session.pendingInput;
  if (args.question === undefined && pending.length > 1)
    throw new Error("有多个待回答的问题，请指定 question 中的问题序号。");
  const request = pending[(args.question ?? 1) - 1];
  if (!request) throw new Error("该问题已不存在。");
  return conversationSummary(await manager.respond(args.name, request.id, {
    value: args.value, confirmed: args.confirmed, cancelled: args.cancelled,
  }, owner));
}

function diagnostics(manager: GptSessionManager, name: string) {
  const session = manager.read(name, 0, 1).session;
  const events = manager.recentEvents(name);
  const starts = new Map<string, ProgressEvent>();
  for (const event of events) if (event.type === "tool_start" && event.toolCallId) starts.set(event.toolCallId, event);
  const failures = events.filter((event) => event.type === "error" || (event.type === "tool_end" && event.isError)).slice(-8).map((event) => {
    const start = event.toolCallId ? starts.get(event.toolCallId) : undefined;
    return {
      at: event.at,
      ...(event.toolName ? { tool: event.toolName } : {}),
      ...(start?.text ? { arguments: clip(start.text, 2_000) } : {}),
      message: clip(event.text || session.error || "Worker operation failed.", 6_000),
    };
  });
  return {
    status: session.status,
    ...(session.error ? { error: clip(session.error, 6_000) } : {}),
    failures,
    recentEvents: events.slice(-12).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      ...(event.toolName ? { tool: event.toolName } : {}),
      ...(event.isError ? { isError: true } : {}),
      ...(event.text ? { summary: clip(event.text, 1_000) } : {}),
    })),
  };
}

interface QueryDeliveryState { anchor: unknown; pending: Set<string> }
interface ToolContext extends SessionAccess {
  owner: string;
  history: readonly ConversationHistoryMessage[];
  extensionContext?: ExtensionToolContext;
  signal?: AbortSignal;
  waitMode?: "any" | "all";
  deliveryState: QueryDeliveryState;
}
function response(value: unknown, readable?: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: readable ?? JSON.stringify(value) }], details: value };
}
function errorResult(error: unknown): AgentToolResult<unknown> {
  let reason: string;
  try { reason = (error instanceof Error ? error.message : String(error)).slice(0, 12_000); }
  catch { reason = "未知错误"; }
  return { ...response({ error: reason }, `工兵操作失败：${reason}`), isError: true };
}
function ownerSessionId(ctx: ExtensionToolContext | undefined, configured?: string) {
  const id = configured || ctx?.sessionManager.getSessionId();
  if (!id || id.length > 200) throw new Error("当前 Pi Lab 会话身份不可用，拒绝操作 GPT 工兵。");
  return id;
}

function queryStatus(context: ToolContext, name: string, args: Pick<QueryInput, "repeat" | "limit" | "maxChars" | "diagnostics">) {
  const { manager, owner, history, extensionContext } = context;
  manager.assertOwner(name, owner);
  const read = readConversation(manager, name, args.limit ?? 5, false, args.maxChars ?? DEFAULT_REPLY_MAX_CHARS);
  const { reply, writing: _draft, ...status } = read;
  const session = manager.read(name, 0, 1).session;
  const delivery = {
    session: session.id,
    sequence: session.replySequence ?? 0,
    digest: createHash("sha256").update(reply || "").digest("hex"),
  };
  const currentHistory = getConversationHistory(history, extensionContext);
  const anchor = extensionContext
    ? `${extensionContext.sessionManager.getSessionId()}:${extensionContext.sessionManager.getLeafId()}`
    : currentHistory.at(-1);
  const key = `${delivery.session}:${delivery.sequence}:${delivery.digest}`;
  const deliveryState = context.deliveryState;
  if (anchor !== deliveryState.anchor) {
    deliveryState.anchor = anchor;
    deliveryState.pending.clear();
  }
  const pending = deliveryState.pending;
  const unchanged = !!reply && !args.repeat && (alreadyDelivered(currentHistory, delivery, reply) || pending.has(key));
  const result = {
    ...status,
    ...(reply && !unchanged ? { reply } : {}),
    ...(unchanged ? { unchanged: true } : {}),
    ...((args.diagnostics || session.status === "error") ? { diagnostics: diagnostics(manager, name) } : {}),
  };
  const output = response(result, formatConversationRead(result));
  if (result.reply) {
    output.details = { ...result, piLabGptReply: delivery };
    pending.add(key);
  }
  if (reply && (result.reply || unchanged)) manager.markReplyDelivered(name, delivery.sequence);
  return output;
}
function getConversationHistory(history: readonly ConversationHistoryMessage[], ctx?: ExtensionToolContext): readonly ConversationHistoryMessage[] {
  return history.length ? history : (ctx?.sessionManager.buildSessionProjection().messages ?? []) as readonly ConversationHistoryMessage[];
}

function dispatchTaskName(task: DispatchTask) { return task.name.trim(); }
function dispatchTasks(input: DispatchInput): DispatchTask[] {
  if (!!input.task === !!input.tasks) throw new Error("请提供 task 或 tasks 中的一个，不能同时提供或都省略。");
  const tasks = input.tasks ?? (input.task ? [input.task] : []);
  if (!tasks.length || tasks.length > 8) throw new Error("一次派发需要 1–8 个任务。");
  const names = tasks.map(dispatchTaskName);
  if (names.some((name) => !name) || new Set(names).size !== names.length)
    throw new Error("同一次批量派发的工兵名称必须非空且互不相同。");
  return tasks;
}

function settledValues<T>(results: PromiseSettledResult<T>[]) {
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}
function settledFailures<T>(results: PromiseSettledResult<T>[], names: string[]) {
  return results.flatMap((result, index) => result.status === "rejected" ? [{
    name: names[index],
    error: result.reason instanceof Error ? result.reason.message.slice(0, 2_000) : String(result.reason).slice(0, 2_000),
  }] : []);
}

async function dispatch(input: DispatchInput, context: ToolContext, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("工兵派发已取消。");
  const { manager, owner, resolveModel } = context;
  const tasks = dispatchTasks(input);
  const mode = input.mode ?? "async";
  const current = new Map(manager.list(owner).map((session) => [session.name, session]));
  const prepared = await Promise.allSettled(tasks.map(async (task) => {
    const name = dispatchTaskName(task);
    const existing = current.get(name);
    const action = !task.action || task.action === "auto" ? (existing ? "send" : "create") : task.action;
    if (action === "create") {
      if (existing) throw new Error(`工兵「${name}」已存在；请用 action=send 继续任务，或换一个名称。`);
      const session = await manager.create({
        name,
        ownerSessionId: owner,
        rolePreset: task.rolePreset,
        cwd: task.cwd,
        model: await resolveModel(task.model),
      });
      return { task, name, action, session };
    }
    if (!existing) throw new Error(`找不到工兵「${name}」；请先以 action=create 派发。`);
    manager.assertOwner(existing.id, owner);
    return { task, name, action, session: existing };
  }));
  const ready = settledValues(prepared);
  const failures = settledFailures(prepared, tasks.map(dispatchTaskName));
  if (!ready.length) return response({ mode, started: [], failures }, failures.map((item) => `${item.name} · 失败：${item.error}`).join("\n") || "没有启动任何工兵。");

  const startPromise = Promise.allSettled(ready.map(({ task, name }) => manager.send(
    name,
    task.message,
    task.sendMode ?? "steer",
    task.rolePreset,
    owner,
  )));
  if (mode === "async") {
    const startedResults = await startPromise;
    const started = settledValues(startedResults).map((result) => ({
      name: result.session.name,
      handle: result.session.id,
      status: result.session.status,
      delivery: result.disposition ?? "accepted",
    }));
    failures.push(...settledFailures(startedResults, ready.map((item) => item.name)));
    const details = { mode, started, failures };
    const summary = [
      ...started.map((item) => `${item.name} · ${item.status} · 追踪句柄 ${item.handle}`),
      ...failures.map((item) => `${item.name} · 失败：${item.error}`),
    ].join("\n");
    return response(details, summary || "没有启动任何工兵。");
  }

  // wait() installs its listeners synchronously before the sends can settle; startPromise
  // is a barrier so a very fast worker cannot race the synchronous handoff.
  const waiting = manager.wait(ready.map((item) => item.name), signal, context.waitMode ?? "all", startPromise);
  const [startedResults, waited] = await Promise.all([startPromise, waiting]);
  failures.push(...settledFailures(startedResults, ready.map((item) => item.name)));
  const reports = waited.sessions.map((session) => queryStatus(context, session.id, { maxChars: input.maxChars }));
  const sessions = reports.map((report) => report.details);
  const reportText = reports.map((report) => report.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n")).join("\n\n---\n\n");
  const note = !waited.completed && waited.session
    ? `\n\n因「${waited.session.name}」${stateLabels[waited.session.status]}，提前结束等待；其他工兵仍可在后台继续。`
    : "";
  const details = {
    mode,
    completed: waited.completed,
    ...(waited.session ? { trigger: conversationSummary(waited.session) } : {}),
    sessions,
    failures,
  };
  const startSummary = failures.map((failure) => `${failure.name} · 失败：${failure.error}`).join("\n");
  return response(details, [reportText || "暂无会话状态。", startSummary, note].filter(Boolean).join("\n\n"));
}

type LegacyCreateInput = Static<typeof legacyCreateSchema>;
type LegacySendInput = Static<typeof legacySendSchema>;
type LegacyBatchInput = Static<typeof legacyBatchSchema>;
type LegacyWaitInput = Static<typeof legacyWaitSchema>;
type LegacyReadInput = Static<typeof legacyReadSchema>;
type LegacyLogsInput = Static<typeof legacyLogsSchema>;
type LegacyRespondInput = Static<typeof legacyRespondSchema>;

async function legacyCreate(input: LegacyCreateInput, context: ToolContext) {
  if (!input.message) {
    const session = await context.manager.create({
      name: input.name, rolePreset: input.rolePreset, ownerSessionId: context.owner,
      cwd: input.cwd, model: await context.resolveModel(input.model),
    });
    if (input.wait) {
      const waited = await context.manager.wait([session.name], context.signal, "any");
      const current = waited.sessions[0] ?? session;
      return response({ ...conversationSummary(current), model: current.model });
    }
    return response({ ...conversationSummary(session), model: session.model });
  }
  const task: DispatchTask = {
    name: input.name, message: input.message, rolePreset: input.rolePreset,
    action: "create", cwd: input.cwd, model: input.model,
  };
  const result = await dispatch({ task, mode: input.wait ? "sync" : "async", maxChars: input.maxChars },
    { ...context, waitMode: "any" }, context.signal);
  const details = asRecord(result.details);
  const session = context.manager.read(input.name, 0, 1).session;
  return response({ ...details, ...conversationSummary(session), operation: "create", model: session.model }, result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
}

async function legacySend(input: LegacySendInput, context: ToolContext) {
  context.manager.assertOwner(input.name, context.owner);
  const result = await dispatch({
    task: { name: input.name, message: input.message, rolePreset: input.rolePreset, action: "send", sendMode: input.mode ?? "steer" },
    mode: input.wait ? "sync" : "async", maxChars: input.maxChars,
  }, { ...context, waitMode: "any" }, context.signal);
  const details = asRecord(result.details);
  if (input.wait) return response(details, result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
  const session = context.manager.read(input.name, 0, 1).session;
  const started = Array.isArray(details.started) ? asRecord(details.started[0]) : {};
  return response({ ...conversationSummary(session), delivery: started.delivery ?? "accepted" });
}

async function legacyBatch(input: LegacyBatchInput, context: ToolContext) {
  const wait = input.wait ?? "none";
  const result = await dispatch({
    tasks: input.tasks.map((task) => ({
      name: task.name, message: task.message, rolePreset: task.rolePreset, action: task.action,
      model: task.model, cwd: task.cwd, sendMode: task.mode,
    })),
    mode: wait === "none" ? "async" : "sync",
    maxChars: input.maxChars,
  }, { ...context, waitMode: wait === "any" ? "any" : "all" }, context.signal);
  const details = asRecord(result.details);
  if (wait === "none") return response({ ...details, wait }, result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
  return response({ ...details, mode: wait }, result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
}

async function legacyWait(input: LegacyWaitInput, context: ToolContext) {
  for (const name of input.names) context.manager.assertOwner(name, context.owner);
  const waited = await context.manager.wait(
    input.names, context.signal, input.mode ?? "any",
  );
  const reports = waited.sessions.map((session) => queryStatus(context, session.id, { maxChars: input.maxChars }));
  const details = {
    mode: input.mode ?? "any", completed: waited.completed,
    ...(waited.session ? { trigger: conversationSummary(waited.session) } : {}),
    sessions: reports.map((report) => report.details),
  };
  const text = reports.map((report) => report.content.map((part) => part.type === "text" ? part.text : "").join("\n")).join("\n\n---\n\n");
  return response(details, text || "暂无会话状态。");
}

export function createSessionTools(
  getAccess: (ctx?: ExtensionToolContext) => Promise<SessionAccess>,
  getHistory?: ConversationHistory,
  configuredOwnerSessionId?: string,
): SessionTool[] {
  const registry = new ToolRegistry<ToolContext>();
  const deliveryState: QueryDeliveryState = { anchor: undefined, pending: new Set() };
  registry
    .register<typeof dispatchSchema, AgentToolResult<unknown>>({
      name: "subagent_dispatch",
      description: `Create or continue one worker task, or submit up to eight tasks. mode="async" (default) starts work in the background and returns tracking handles. mode="sync" waits until each current turn finishes, fails, needs input, or is cancelled. action="auto" selects create or send based on the worker name; action="create" and action="send" select explicitly. sendMode controls message delivery. maxChars bounds returned briefs.`,
      parameters: dispatchSchema,
      ui: subagentToolUi.subagent_dispatch,
      execute: (input, context) => dispatch(input, context, context.signal),
    })
    .register<typeof querySchema, AgentToolResult<unknown>>({
      name: "subagent_query",
      description: "Read the worker list or one worker's status by name or tracking handle. Status includes the latest brief, current state, pending questions, and recent activity. diagnostics=true includes bounded failure details; repeat=true includes the latest brief again. limit and maxChars bound the response.",
      parameters: querySchema,
      ui: subagentToolUi.subagent_query,
      async execute(input, context) {
        if (input.action === "list") {
          if (input.name) throw new Error("action=list does not accept name.");
          const sessions = context.manager.list(context.owner).map(conversationSummary);
          return response({ sessions }, sessions.map((session) => `${session.name} · ${stateLabels[session.status]}`).join("\n") || "没有工兵会话。");
        }
        if (!input.name) throw new Error("action=status 必须提供工兵 name 或 tracking handle。");
        const result = queryStatus(context, input.name, input);
        return result;
      },
    })
    .register<typeof controlSchema, AgentToolResult<unknown>>({
      name: "subagent_control",
      description: "Apply an operation to a worker: abort stops current work and clears queued tasks; respond submits an answer to pending input; close stops the process and preserves its native session history. Respond fields include question, value, confirmed, and cancelled.",
      parameters: controlSchema,
      ui: subagentToolUi.subagent_control,
      async execute(input, context) {
        const { manager, owner } = context;
        if (input.action === "abort") {
          const interrupted = await manager.interrupt(input.name, owner);
          const summary = conversationSummary(interrupted.session);
          return response({ action: input.action, ...summary }, `${summary.name} · 已中止`);
        }
        if (input.action === "close") {
          const closed = await manager.close(input.name, false, owner);
          const summary = conversationSummary(closed);
          return response({ action: input.action, ...summary }, `${summary.name} · 已关闭并保留会话历史`);
        }
        const answered = await answerConversation(manager, input, owner);
        return response({ action: input.action, ...answered }, `${answered.name} · 已提交回答`);
      },
    });

  const addLegacy = <Parameters extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: Parameters,
    ui: SubagentToolUiMetadata,
    execute: (input: Static<Parameters>, context: ToolContext) => Promise<AgentToolResult<unknown>>,
  ) => registry.register({ name, description, parameters, ui, defaultActive: false, execute });
  addLegacy("gpt_session_create", "Create GPT conversation", "Compatibility alias for subagent_dispatch. wait=true waits for the current worker turn to finish, fail, or request input.", legacyCreateSchema, subagentToolUi.subagent_dispatch, legacyCreate);
  addLegacy("gpt_session_send", "Message GPT conversation", "Compatibility alias for subagent_dispatch action=send. wait=true waits for the current turn to finish, fail, or request input.", legacySendSchema, subagentToolUi.subagent_dispatch, legacySend);
  addLegacy("gpt_session_batch", "Run GPT tasks in parallel", "Legacy alias for subagent_dispatch with tasks[].", legacyBatchSchema, subagentToolUi.subagent_dispatch, legacyBatch);
  addLegacy("gpt_session_list", "List GPT conversations", "Legacy alias for subagent_query action=list.", legacyListSchema, subagentToolUi.subagent_query,
    async (_input, context) => response(context.manager.list(context.owner).map(conversationSummary)));
  addLegacy("gpt_session_read", "Read GPT conversation", "Legacy alias for subagent_query action=status.", legacyReadSchema, subagentToolUi.subagent_query,
    async (input, context) => queryStatus(context, input.name, input));
  addLegacy("gpt_session_wait", "Wait for GPT conversations", "Compatibility alias that waits for selected workers to reach the requested completion condition.", legacyWaitSchema, subagentToolUi.subagent_query, legacyWait);
  addLegacy("gpt_session_logs", "Diagnose GPT conversation", "Legacy alias for subagent_query diagnostics.", legacyLogsSchema, subagentToolUi.subagent_query,
    async (input, context) => queryStatus(context, input.name, { diagnostics: true, limit: input.limit }));
  addLegacy("gpt_session_interrupt", "Interrupt GPT conversation", "Legacy alias for subagent_control action=abort.", legacyNameSchema, subagentToolUi.subagent_control,
    async (input, context) => {
      const stopped = await context.manager.interrupt(input.name, context.owner);
      return response(conversationSummary(stopped.session));
    });
  addLegacy("gpt_session_close", "Close GPT process", "Legacy alias for subagent_control action=close.", legacyNameSchema, subagentToolUi.subagent_control,
    async (input, context) => response(conversationSummary(await context.manager.close(input.name, false, context.owner))));
  addLegacy("gpt_session_respond", "Answer GPT input request", "Legacy alias for subagent_control action=respond.", legacyRespondSchema, subagentToolUi.subagent_control,
    async (input, context) => response(await answerConversation(context.manager, input, context.owner)));

  return registry.list().map((definition) => ({
    defaultActive: definition.defaultActive,
    name: definition.name,
    label: definition.ui.displayName,
    description: definition.description,
    promptSnippet: definition.ui.summarizeInput({}),
    parameters: definition.parameters,
    execute: async (_id: string, input: unknown, signal?: AbortSignal, _onUpdate?: AgentToolUpdateCallback<unknown>, ctx?: ExtensionToolContext) => {
      try {
        if (signal?.aborted) throw new Error("工兵操作已取消。");
        const access = await getAccess(ctx);
        const owner = ownerSessionId(ctx, configuredOwnerSessionId);
        const history = getHistory?.() ?? [];
        const context: ToolContext = { ...access, owner, history, extensionContext: ctx, signal, deliveryState };
        return await registry.execute(definition.name, input, context) as AgentToolResult<unknown>;
      } catch (error) {
        return errorResult(error);
      }
    },
  }));
}
