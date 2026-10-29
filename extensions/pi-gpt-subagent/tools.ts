import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GPT_WAIT_TIMEOUT_SECONDS, rolePresetLabels, type GptRolePreset, type GptSessionManager, type ProgressEvent, type SessionInfo, type SessionStatus, type SendMode } from "./sessions.ts";

export interface SessionAccess {
  manager: GptSessionManager;
  resolveModel(requested?: string): Promise<string> | string;
}
export type SessionTool = Omit<ToolDefinition<any, any>, "execute"> & {
  execute(id: string, args: any, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<any>,
    ctx?: ExtensionToolContext): Promise<AgentToolResult<any>>;
};
const name = Type.String({ minLength: 1, maxLength: 160, description: "The conversation's unique name, exactly as set when creating it." });
const message = Type.String({ minLength: 1, maxLength: 100_000 });
const rolePreset = Type.Union([Type.Literal("scout"), Type.Literal("experimenter"), Type.Literal("implementer")], { description: "探路学者 scout、路径实验员 experimenter、工程执行员 implementer。" });
const schema = <T extends Record<string, any>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const response = (value: unknown, readable?: string): AgentToolResult<any> => ({
  content: [{ type: "text", text: readable ?? JSON.stringify(value) }], details: value,
});
function ownerSessionId(ctx: ExtensionToolContext | undefined, configured?: string) {
  const id = configured || ctx?.sessionManager.getSessionId();
  if (!id || id.length > 200) throw new Error("当前 Pi Lab 会话身份不可用，拒绝操作 GPT 工兵。");
  return id;
}

// Control acknowledgements must not replay an earlier GPT answer.
export function conversationSummary(session: SessionInfo) {
  return {
    name: session.name, status: session.status,
    ...(session.role ? { role: session.role } : {}),
    ...(session.rolePreset ? { rolePreset: session.rolePreset } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.pendingInput.length ? { questions: session.pendingInput.map((request, index) => ({
      question: index + 1, type: request.method, title: request.title,
      ...(request.message ? { message: request.message } : {}),
      ...(request.options ? { options: request.options } : {}),
    })) } : {}),
  };
}

export const DEFAULT_REPLY_MAX_CHARS = 3_200;
export const MIN_REPLY_MAX_CHARS = 500;
export const MAX_REPLY_MAX_CHARS = 24_000;
const clip = (text: string, length: number) => text.length <= length ? text : text.slice(0, length) + "\n…（内容已截断）";
export function withFeynmanReport(message: string, rolePreset?: GptRolePreset) {
  const role = rolePreset ? `本轮角色：${rolePresetLabels[rolePreset]}（${rolePreset}）。` : "本轮角色：通用探索，按任务自主判断并明确风险。";
  const behavior = rolePreset === "scout" ? "优先解释问题本质，定位关键代码路径与可验证证据，不做无关修改。"
    : rolePreset === "experimenter" ? "设计并执行低风险实验，比较路径，用结果解释因果并说明失败边界。"
    : rolePreset === "implementer" ? "按约束实施必要改动并运行最相关的验证，准确说明关键改动与结果。"
    : "涉及调研或排查时先解释根因与核心原理，再给出有证据的结论。";
  const reportProtocol = `【费曼式探索与结构化汇报协议】回复主 Agent 时，目标是让其掌控全局并真正理解问题；禁止堆砌“我读了 A、跑了 B”式无意义流水账，也禁止无证据的成功宣称。必须按以下四节汇报：\n1. 【核心直觉与本质】：涉及调研或排查时，先用直白清晰的语言说明问题的本质原理或根因；否则讲清任务核心。\n2. 【尝试路径与成果】：说明尝试了什么、验证成了什么或修改了哪些关键点，并给出证据。\n3. 【碰壁与反例】（若有）：明确说明未走通的路径及其卡住的核心矛盾；没有则写“无”。\n4. 【下一步建议】：给主 Agent 明确、可执行的决策建议。命令、文件名和日志只有在支撑结论时才列出。`;
  const hasProtocol = message.includes("【费曼式探索与结构化汇报协议】");
  return `【本轮角色与要求】${role} ${behavior}\n\n${message}${hasProtocol ? "" : `\n\n${reportProtocol}`}`;
}
export function clipReply(text: string, maxChars = DEFAULT_REPLY_MAX_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < MIN_REPLY_MAX_CHARS || maxChars > MAX_REPLY_MAX_CHARS)
    throw new Error(`回复长度预算必须在 ${MIN_REPLY_MAX_CHARS}–${MAX_REPLY_MAX_CHARS} 字符之间。`);
  if (text.length <= maxChars) return text;
  const notice = `\n\n[上下文保护：回复已按 ${maxChars} 字符预算截断；如需更多细节，请向工兵追问。]`;
  return text.slice(0, maxChars - notice.length) + notice;
}
type Activity = { tool: string; action?: string; status: "running" | "done" | "error" | "stopped"; output?: string };
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
        const args = JSON.parse(event.text);
        const action = args.command || args.query || args.path || args.pattern || args.url;
        if (typeof action === "string") call.action = clip(action.replace(/\s+/g, " ").trim(), 160);
      } catch { /* Older logs may not contain structured arguments. */ }
    } else if (event.text) call.output = event.text;
    if (event.type === "tool_end") call.status = event.isError ? "error" : "done";
  }
  if (!["starting", "running", "waiting_input"].includes(status))
    for (const call of calls) if (call.status === "running") call.status = "stopped";
  return calls;
}

export function readConversation(manager: GptSessionManager, name: string, limit = 5, details = false, maxChars = DEFAULT_REPLY_MAX_CHARS) {
  const session = manager.read(name, 0, 1).session;
  const events = manager.recentEvents(name);
  let lastStart = -1;
  events.forEach((event, index) => { if (event.type === "running") lastStart = index; });
  const currentEvents = lastStart < 0 ? events : events.slice(lastStart);
  const selected = toolActivity(currentEvents, session.status).slice(-limit);
  const activity = selected.map(({ action, output, ...call }) => ({
    ...call,
    ...(details && action ? { action } : {}),
    ...(details && output ? { output: clip(output, 6_000) } : {}),
  }));
  const summary = conversationSummary(session);
  return {
    ...summary,
    ...(session.lastText ? { reply: details ? clip(session.lastText, 64_000) : clipReply(session.lastText, maxChars) } : {}),
    ...(session.partialText ? { writing: clip(session.partialText, details ? 16_000 : 6_000) } : {}),
    ...(activity.length && (details || session.status !== "idle" || !session.lastText || activity.some((item) => item.status === "error"))
      ? { activity } : {}),
  };
}

const states: Record<SessionStatus, string> = {
    starting: "正在启动", running: "正在工作", idle: "本轮已结束", waiting_input: "等待回答",
    interrupted: "已打断", suspended: "已暂停", closed: "已关闭", error: "运行出错",
};
export function formatConversationRead(read: ReturnType<typeof readConversation> & { unchanged?: boolean }): string {
  const lines = [`${read.name} · ${states[read.status]}`];
  if (read.error) lines.push(`错误：${read.error}`);
  if (read.reply) lines.push(`最近回复\n\n${read.reply}`);
  if (read.writing) lines.push(`正在回复\n\n${read.writing}`);
  if (read.unchanged) lines.push("暂无新回复。");
  else if (!read.reply && !read.writing && !read.questions?.length) lines.push("GPT 暂时还没有发来回复。");
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
  role?: string; toolName?: string; content?: unknown; details?: unknown; gptReply?: ReplyDelivery;
}
export type ConversationHistory = () => readonly ConversationHistoryMessage[];

export interface ReplyDelivery { session: string; sequence: number; digest: string }
export function replyDelivery(details: unknown): ReplyDelivery | undefined {
  const value = (details as { piLabGptReply?: ReplyDelivery })?.piLabGptReply;
  return value && typeof value.session === "string" && /^gpt-[a-f0-9-]+$/.test(value.session) &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0 && /^[a-f0-9]{64}$/.test(value.digest) ? value : undefined;
}

/** Derive delivery from this parent's actual history, so reloads, branches and other parents stay independent. */
function alreadyDelivered(history: readonly ConversationHistoryMessage[], delivery: ReplyDelivery, reply: string) {
  return history.some((message) => {
    if (!["tool", "toolResult"].includes(message.role || "") || !["gpt_session_read", "gpt_session_wait"].includes(message.toolName || "")) return false;
    const previous = message.gptReply ?? replyDelivery(message.details);
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";
    return previous?.session === delivery.session && previous.sequence === delivery.sequence && previous.digest === delivery.digest && text.includes(reply);
  });
}

function formatToolLogs(read: ReturnType<typeof readConversation>) {
  const lines = [`${read.name} · 工具日志`];
  if (!read.activity?.length) lines.push("暂无工具日志。");
  for (const item of read.activity ?? []) {
    const status = { running: "执行中", done: "已完成", error: "失败", stopped: "已停止" }[item.status];
    lines.push(`${item.tool} · ${status}${item.action ? `\n${item.action}` : ""}\n${item.output || "（无输出）"}`);
  }
  return lines.join("\n\n");
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

export function createSessionTools(
  getAccess: (ctx?: ExtensionToolContext) => Promise<SessionAccess>,
  getHistory?: ConversationHistory,
  configuredOwnerSessionId?: string,
): SessionTool[] {
  // A tool batch may finish several reads before its results are appended to history.
  let pendingAnchor: unknown;
  const pendingDeliveries = new Set<string>();
  const unreadReport = (manager: GptSessionManager, owner: string, name: string, args: { limit?: number; repeat?: boolean; maxChars?: number }, ctx?: ExtensionToolContext) => {
    manager.assertOwner(name, owner);
    const read = readConversation(manager, name, args.limit ?? 5, false, args.maxChars ?? DEFAULT_REPLY_MAX_CHARS);
    const history = getHistory?.() ?? ctx?.sessionManager.buildSessionProjection().messages ?? [];
    const { reply, writing: _draft, ...status } = read;
    const session = manager.read(name, 0, 1).session;
    const delivery = { session: session.id, sequence: session.replySequence ?? 0, digest: createHash("sha256").update(reply || "").digest("hex") };
    const anchor = ctx ? `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}` : history.at(-1);
    if (anchor !== pendingAnchor) { pendingDeliveries.clear(); pendingAnchor = anchor; }
    const deliveryKey = JSON.stringify(delivery);
    const unchanged = !!reply && !args.repeat && (alreadyDelivered(history, delivery, reply) || pendingDeliveries.has(deliveryKey));
    const result = { ...status, ...(reply && !unchanged ? { reply } : {}), ...(unchanged ? { unchanged: true } : {}) };
    const output = response(result, formatConversationRead(result));
    if (result.reply) {
      output.details = { ...result, piLabGptReply: delivery };
      pendingDeliveries.add(deliveryKey);
    }
    if (reply && (result.reply || unchanged)) manager.markReplyDelivered(name, delivery.sequence);
    return output;
  };
  const waitAndReport = async (manager: GptSessionManager, owner: string, names: string[], options: {
    timeoutSeconds?: number; mode?: "any" | "all"; maxChars?: number;
  }, signal?: AbortSignal, ctx?: ExtensionToolContext,
  extra: Record<string, unknown> | (() => Record<string, unknown>) = {}, startAfter?: Promise<unknown>) => {
    for (const name of names) manager.assertOwner(name, owner);
    if (signal?.aborted) throw new Error("等待已取消；GPT 仍可继续在后台工作。");
    const mode = options.mode ?? "any";
    const waited = await manager.wait(names, (options.timeoutSeconds ?? GPT_WAIT_TIMEOUT_SECONDS) * 1_000, signal, mode, startAfter);
    if (signal?.aborted) throw new Error("等待已取消；GPT 仍可继续在后台工作。");
    const reports = waited.sessions.map((session) => unreadReport(manager, owner, session.name, { maxChars: options.maxChars }, ctx));
    const reportText = reports.map((report) => report.content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n")).join("\n\n---\n\n");
    const statusText = waited.sessions.map((session) => `${session.name} · ${states[session.status]}`).join("\n");
    const note = waited.timedOut
      ? `\n\n等待超时（${options.timeoutSeconds ?? GPT_WAIT_TIMEOUT_SECONDS} 秒）；未完成的工兵仍在后台工作。`
      : !waited.completed && waited.session
        ? `\n\n因「${waited.session.name}」${states[waited.session.status]}，提前结束等待；其他会话仍可在后台继续。`
        : "";
    const extraDetails = typeof extra === "function" ? extra() : extra;
    return response({
      ...extraDetails, mode, completed: waited.completed, timedOut: waited.timedOut,
      ...(waited.session ? { trigger: conversationSummary(waited.session) } : {}),
      sessions: reports.map((report) => report.details),
    }, [reportText || statusText || "暂无会话状态。", note].join(""));
  };
  const tools: SessionTool[] = [
    {
      name: "gpt_session_list", label: "GPT sessions",
      description: "List persistent GPT conversations by name and current status, without replaying replies. Use gpt_session_read for new replies. Running conversations continue independently while you talk to the user.",
      promptSnippet: "List your persistent GPT conversations and their current activity",
      parameters: schema({}),
      execute: async (_id, _args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        return response(manager.list(ownerSessionId(ctx, configuredOwnerSessionId)).map((session) => conversationSummary(session)));
      },
    },
    {
      name: "gpt_session_read", label: "Read GPT conversation",
      description: "Read a named GPT conversation: status, an unread completed reply, questions and recent tool names/statuses. Already delivered replies and in-progress reply drafts are omitted by default. Set repeat=true only to deliberately reread the latest reply. Tool arguments and outputs are always omitted, including failures; use gpt_session_logs only for specific diagnostics. Returns immediately; an ended turn does not prove success. Use gpt_session_wait to await completion instead of polling or sleeping.",
      promptSnippet: "Read live output and tool activity from a GPT conversation",
      parameters: schema({
        name,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum recent tool executions to include; defaults to 5." })),
        repeat: Type.Optional(Type.Boolean({ description: "Deliberately reread the latest completed reply even if already delivered; defaults to false." })),
        maxChars: Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS, description: `Maximum reply characters; defaults to ${DEFAULT_REPLY_MAX_CHARS}. Truncation includes a context-protection note.` })),
      }),
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        return unreadReport(manager, ownerSessionId(ctx, configuredOwnerSessionId), args.name, args, ctx);
      },
    },
    {
      name: "gpt_session_wait", label: "Wait for GPT",
      description: `After creating or messaging GPT, use this when you need its result. Example: gpt_session_wait({"names":["排版"]}). mode="any" (default) returns when one conversation finishes or needs attention; mode="all" waits for every conversation unless one needs input, fails, stops, or times out. Omit timeoutSeconds for the ${GPT_WAIT_TIMEOUT_SECONDS}-second maximum. Replies default to ${DEFAULT_REPLY_MAX_CHARS} characters to protect context; maxChars can be set from ${MIN_REPLY_MAX_CHARS} to ${MAX_REPLY_MAX_CHARS}. Never use bash sleep or repeated read/list polling. Tool arguments and outputs are omitted. An ended turn does not prove success.`, 
      promptSnippet: "Wait for GPT results or questions without sleeping or polling",
      parameters: schema({
        names: Type.Array(name, { minItems: 1, maxItems: 8, description: "One or more distinct conversation names." }),
        mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "any returns on the first completed/attention state; all waits for every session unless one needs input or errors. Defaults to any." })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: GPT_WAIT_TIMEOUT_SECONDS, description: `Maximum wait in seconds; defaults to ${GPT_WAIT_TIMEOUT_SECONDS}.` })),
        maxChars: Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS, description: `Character budget per reply; defaults to ${DEFAULT_REPLY_MAX_CHARS}.` })),
      }),
      execute: async (_id, args, signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        return waitAndReport(manager, ownerSessionId(ctx, configuredOwnerSessionId), args.names, args, signal, ctx);
      },
    },
    {
      name: "gpt_session_logs", label: "GPT tool logs",
      description: "Read bounded raw tool arguments and outputs from a named GPT conversation. Only use when the user explicitly requests log contents or when diagnosing a specific failing tool. Do not use for checking progress, waiting for completion or summarizing results; use gpt_session_read instead. Raw logs remain stored in the GPT conversation even when omitted from reports.",
      parameters: schema({
        name,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "How many recent tool executions to inspect; defaults to 1." })),
      }),
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        manager.assertOwner(args.name, ownerSessionId(ctx, configuredOwnerSessionId));
        const read = readConversation(manager, args.name, args.limit ?? 1, true);
        return response({ name: read.name, activity: read.activity ?? [] }, formatToolLogs(read));
      },
    },
  ];
  tools.unshift({
    name: "gpt_session_create", label: "Create GPT conversation",
    description: `Delegate work to a persistent GPT conversation, optionally choosing rolePreset scout, experimenter or implementer. Creation is non-blocking by default (wait=false): after dispatch, keep talking with the user while the worker runs. Set wait=true only when the user explicitly needs the result before continuing. Use gpt_session_batch with wait=none for parallel background tasks. ${GPT_WAIT_TIMEOUT_SECONDS}-second cap applies only to explicit waits.`,
    promptSnippet: "Open a persistent GPT conversation and let it work independently in the background",
    promptGuidelines: [
      "Delegate file inspection, shell commands, code changes and image preparation to GPT. Ask for concise findings and named image collections, keeping raw tool logs in GPT's conversation. Use list_images/view_images for visual review.",
      "每次交接都必须遵守【费曼式探索与结构化汇报协议】：禁止堆砌“我读了 A、跑了 B”式流水账；涉及调研或排查，先用直白语言讲清本质原理/根因。按四节汇报：【核心直觉与本质】、【尝试路径与成果】（含验证结果、关键改动与证据）、【碰壁与反例】（说明卡住的核心矛盾；没有则写“无”）、【下一步建议】（给主 Agent 明确决策建议）。区分事实与猜测。", 
      "Give each GPT conversation a short, unique name and an optional role label such as 审计工兵、代码工兵、资料研究 or 截图工兵. Use that same name with send/read/interrupt instead of creating a new conversation for every message.",
      "Prefer non-blocking dispatch for long work: gpt_session_create defaults to wait=false and gpt_session_batch defaults to wait=none. After dispatch, immediately continue the user's conversation, discuss the approach, or split another task; never wait unless an immediate result is necessary.",
      `When you need GPT to finish, call gpt_session_wait({"names":["登录检查"]}), omitting timeoutSeconds to wait up to ${GPT_WAIT_TIMEOUT_SECONDS} seconds (20 minutes). Never wait through bash sleep or repeated read/list calls. A timeout is not completion; you may wait again. Cancelling a wait does not stop GPT.`,
      "Use gpt_session_read for progress and replies. Tool results stay inside GPT's conversation; only call gpt_session_logs when the user requests raw logs or a specific failing tool needs diagnosis.",
      "Choose rolePreset scout to map principles and evidence, experimenter to compare low-risk paths and explain dead ends, or implementer to make scoped changes and run focused checks. Pass relevant background and constraints; workers do not receive the full parent conversation. Coordinate file ownership.",
      "gpt_session_send mode=steer adds guidance at the next safe boundary; mode=interrupt stops current work first. Never restart a user-interrupted session without the user's instruction.",
    ],
    parameters: schema({
      name,
      rolePreset: Type.Optional(rolePreset),
      message: Type.Optional(message),
      cwd: Type.Optional(Type.String({ description: "Existing absolute working directory; defaults to this Pi conversation's working directory." })), 
      model: Type.Optional(Type.String({ description: "Pi openai-codex model id; defaults to PI_LAB_GPT_SUBAGENT_MODEL or gpt-6-luna. GPT conversations use max thinking." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for this conversation's current turn instead of returning on acceptance; defaults to false." })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: GPT_WAIT_TIMEOUT_SECONDS, description: `Wait deadline when wait=true; defaults to ${GPT_WAIT_TIMEOUT_SECONDS}.` })),
      maxChars: Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS, description: `Reply character budget when wait=true; defaults to ${DEFAULT_REPLY_MAX_CHARS}.` })),
    }),
    execute: async (_id, args, signal, _onUpdate, ctx) => {
      if (signal?.aborted) throw new Error("Conversation creation was cancelled.");
      const { manager, resolveModel } = await getAccess(ctx);
      const owner = ownerSessionId(ctx, configuredOwnerSessionId);
      const initialMessage = args.message ? withFeynmanReport(args.message, args.rolePreset) : undefined;
      const session = await manager.create({ name: args.name, rolePreset: args.rolePreset, ownerSessionId: owner, message: initialMessage, cwd: args.cwd, model: await resolveModel(args.model) });
      if (args.wait) return waitAndReport(manager, owner, [session.name], { mode: "any", timeoutSeconds: args.timeoutSeconds, maxChars: args.maxChars }, signal, ctx, { operation: "create", model: session.model });
      return response({ ...conversationSummary(session), model: session.model });
    },
  });
  tools.push(
    {
      name: "gpt_session_send", label: "Message GPT conversation",
      description: `Send another message to an existing GPT conversation, preserving all its context. Optionally set rolePreset to scout, experimenter or implementer for this task. While running, default steer delivers guidance at the next safe boundary; followUp queues a turn; interrupt aborts current work and clears queued messages. Returns on acceptance by default. Set wait=true to wait for a result, with timeoutSeconds up to ${GPT_WAIT_TIMEOUT_SECONDS}.`,
      promptSnippet: "Send guidance or another task to an existing GPT conversation",
      parameters: schema({ name, message, rolePreset: Type.Optional(rolePreset),
        mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")])), 
        wait: Type.Optional(Type.Boolean({ description: "Wait for this conversation's current turn instead of returning on acceptance; defaults to false." })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: GPT_WAIT_TIMEOUT_SECONDS })),
        maxChars: Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS })) }),
      execute: async (_id, args, signal, _onUpdate, ctx) => {
        if (signal?.aborted) throw new Error("Message was cancelled before delivery.");
        const { manager } = await getAccess(ctx);
        const owner = ownerSessionId(ctx, configuredOwnerSessionId);
        const sentPromise = manager.send(args.name, withFeynmanReport(args.message, args.rolePreset), args.mode ?? "steer", args.rolePreset, owner);
        if (args.wait) {
          let sent: Awaited<typeof sentPromise> | undefined;
          const dispatchReady = sentPromise.then((result) => { sent = result; });
          return waitAndReport(manager, owner, [args.name], { mode: "any", timeoutSeconds: args.timeoutSeconds, maxChars: args.maxChars }, signal, ctx,
            () => ({ operation: "send", delivery: sent?.disposition ?? "accepted" }), dispatchReady);
        }
        const sent = await sentPromise;
        return response({ ...conversationSummary(sent.session), delivery: sent.disposition ?? "accepted" });
      },
    },
    {
      name: "gpt_session_batch", label: "Run GPT tasks in parallel",
      description: `Start or message up to eight GPT conversations concurrently, with optional rolePreset scout, experimenter or implementer per task. The default is non-blocking wait=none so the coordinator can keep chatting while workers work; use wait=any/all only when an immediate report is necessary. Each worker must return the four-section Feynman handoff with evidence and dead ends. Replies default to ${DEFAULT_REPLY_MAX_CHARS} characters; raw tool arguments/outputs are omitted.`, 
      promptSnippet: "Start several independent GPT tasks concurrently and aggregate their replies",
      parameters: schema({
        tasks: Type.Array(Type.Object({
          name, message, rolePreset: Type.Optional(rolePreset),
          action: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("create"), Type.Literal("send")])),
          model: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
          mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")])),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
        wait: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("any"), Type.Literal("all")])),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: GPT_WAIT_TIMEOUT_SECONDS })),
        maxChars: Type.Optional(Type.Integer({ minimum: MIN_REPLY_MAX_CHARS, maximum: MAX_REPLY_MAX_CHARS })),
      }),
      execute: async (_id, args, signal, _onUpdate, ctx) => {
        if (signal?.aborted) throw new Error("批量任务已取消。");
        const { manager, resolveModel } = await getAccess(ctx);
        const owner = ownerSessionId(ctx, configuredOwnerSessionId);
        const tasks = args.tasks as { name: string; message: string; rolePreset?: GptRolePreset; action?: "auto" | "create" | "send"; model?: string; cwd?: string; mode?: SendMode }[];
        const names = tasks.map((task) => task.name.trim());
        if (new Set(names).size !== names.length) throw new Error("批量任务的会话名字必须互不相同。");
        const existing = new Set(manager.list(owner).map((session) => session.name));
        const settled = await Promise.allSettled(tasks.map(async (task) => {
          if (signal?.aborted) throw new Error("批量任务已取消。");
          const action = !task.action || task.action === "auto" ? (existing.has(task.name) ? "send" : "create") : task.action;
          if (action === "create") {
            const session = await manager.create({ name: task.name, rolePreset: task.rolePreset, ownerSessionId: owner, message: withFeynmanReport(task.message, task.rolePreset), cwd: task.cwd, model: await resolveModel(task.model) });
            return { name: task.name, ...(session.role ? { role: session.role } : {}), ...(session.rolePreset ? { rolePreset: session.rolePreset } : {}), action, model: session.model, delivery: "accepted" };
          }
          const sent = await manager.send(task.name, withFeynmanReport(task.message, task.rolePreset), task.mode ?? "steer", task.rolePreset, owner);
          return { name: task.name, action: "send", delivery: sent.disposition ?? "accepted" };
        }));
        const started = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ name: tasks[index].name, error: String(result.reason?.message ?? result.reason) }] : []);
        const wait = args.wait ?? "none";
        if (wait === "none" || !started.length) return response({ wait, started, failures }, [
          ...started.map((item) => `${item.name} · ${item.action} · ${item.delivery}`),
          ...failures.map((item) => `${item.name} · 失败：${item.error}`),
        ].join("\n") || "没有启动任何会话。");
        return waitAndReport(manager, owner, started.map((item) => item.name), {
          mode: wait, timeoutSeconds: args.timeoutSeconds, maxChars: args.maxChars,
        }, signal, ctx, { operation: "batch", started, failures });
      },
    },
    {
      name: "gpt_session_interrupt", label: "Interrupt GPT conversation",
      description: "Immediately abort GPT's current request and running tools, and clear pending steering/follow-up messages. Keep the same conversation and files for later continuation. Interrupting your own Gemini turn does not automatically stop independent GPT sessions; use this tool when asked to stop one.",
      promptSnippet: "Stop a GPT conversation's current work while retaining its context",
      parameters: schema({ name }),
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        const owner = ownerSessionId(ctx, configuredOwnerSessionId);
        return response(conversationSummary((await manager.interrupt(args.name, owner)).session));
      },
    },
    {
      name: "gpt_session_close", label: "Close GPT process",
      description: "Close a GPT conversation by name and stop its current work. Retain its full history. A later send to the same name reopens the conversation.",
      parameters: schema({ name }),
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        const owner = ownerSessionId(ctx, configuredOwnerSessionId);
        return response(conversationSummary(await manager.close(args.name, false, owner)));
      },
    },
    {
      name: "gpt_session_respond", label: "Answer GPT input request",
      description: "Answer a pending question in a named GPT conversation. If there is only one question, its number can be omitted. Supply confirmed for confirmation, value for select/input/editor, or cancelled=true. Relay questions requiring the human's decision to the user before answering.",
      parameters: schema({ name, question: Type.Optional(Type.Integer({ minimum: 1 })), value: Type.Optional(Type.String()),
        confirmed: Type.Optional(Type.Boolean()), cancelled: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args, _signal, _onUpdate, ctx) => {
        const { manager } = await getAccess(ctx);
        return response(await answerConversation(manager, args, ownerSessionId(ctx, configuredOwnerSessionId)));
      },
    },
  );
  // Keep operational, ownership, cancellation and Pi RPC failures inside the Agent
  // tool protocol. A failed GPT operation becomes an explicit model-visible error
  // result instead of a rejected execute() promise reaching the outer run loop.
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (id, args, signal, onUpdate, ctx) => {
      try { return await execute(id, args, signal, onUpdate, ctx); }
      catch (error) {
        let message: string;
        try { message = (error instanceof Error ? error.message : String(error)).slice(0, 12_000); }
        catch { message = "未知错误"; }
        const result = response({ error: message }, `GPT 工兵操作失败：${message}`);
        result.isError = true;
        return result;
      }
    };
  }
  return tools;
}
