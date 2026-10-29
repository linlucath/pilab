import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { GptSessionManager, type ProgressEvent, type SessionInfo } from "../extensions/pi-gpt-subagent/sessions";
import { nativeTransportFactory, sessionStorageDir } from "../extensions/pi-gpt-subagent/native";
import { createSessionTools, type ConversationHistory } from "../extensions/pi-gpt-subagent/tools";
import { piRuntime } from "./pi-subscription";
import { projectImages } from "./images";
import type { GptSessionSummary } from "../shared/gpt-sessions";

const managers = new Map<string, GptSessionManager>();

function managerFor(cwd: string) {
  let manager = managers.get(cwd);
  if (!manager) {
    manager = new GptSessionManager({
      storageDir: sessionStorageDir(`lab:${cwd}`), cwd,
      createTransport: nativeTransportFactory(projectImages.projectRoot),
    });
    managers.set(cwd, manager);
  }
  return manager;
}

async function checkedCwd(value?: string) {
  const cwd = value?.trim() || process.cwd();
  if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("GPT 会话 cwd 必须是已存在的绝对目录。");
  return cwd;
}

/** Only expose tool metadata to the dashboard; ProgressEvent.text contains raw args/output. */
export function summarizeRecentTools(events: ProgressEvent[], limit = 6): GptSessionSummary["recentTools"] {
  const executions = new Map<string, GptSessionSummary["recentTools"][number]>();
  for (const event of events) {
    if (!event.toolName || !event.toolCallId || !["tool_start", "tool_progress", "tool_end"].includes(event.type)) continue;
    const previous = executions.get(event.toolCallId);
    const status = event.type === "tool_end"
      ? event.isError ? "error" : "completed"
      : "running";
    executions.set(event.toolCallId, { name: event.toolName, status, at: event.at || previous?.at || 0 });
  }
  return [...executions.values()].slice(-limit).reverse();
}

function summarize(manager: GptSessionManager, session: SessionInfo): GptSessionSummary {
  const recent = manager.read(session.id, Math.max(0, session.cursor - 80), 80).events;
  const preview = (session.lastText || "").replace(/\s+/g, " ").trim();
  return {
    id: session.id,
    name: session.name,
    ...(session.role ? { role: session.role } : {}),
    ...(session.rolePreset ? { rolePreset: session.rolePreset } : {}),
    ...(session.ownerSessionId ? { ownerSessionId: session.ownerSessionId } : {}),
    status: session.status,
    model: session.model,
    updatedAt: session.updatedAt,
    ...(typeof session.replySequence === "number" ? { replySequence: session.replySequence } : {}),
    hasUnreadReply: !!session.lastText && (session.replySequence ?? 0) > (session.lastDeliveredReplySequence ?? 0),
    hasActiveWaiter: manager.hasActiveWaiter(session.id),
    pendingQuestionCount: session.pendingInput.length,
    recentTools: summarizeRecentTools(recent),
    lastReplyPreview: preview.length > 300 ? `${preview.slice(0, 299)}…` : preview,
  };
}

function checkedOwnerSessionId(value?: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("ownerSessionId 必须是 1 到 200 个字符。");
  return value;
}

export async function listGptSessions(cwdInput?: string, ownerInput?: string): Promise<GptSessionSummary[]> {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  const manager = managerFor(cwd);
  return manager.list(owner).map((session) => summarize(manager, session));
}

export async function readGptSessionTranscript(cwdInput: string | undefined, name: string, ownerInput: string, options: { after?: number; before?: number; limit?: number } = {}) {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  const manager = managerFor(cwd);
  manager.assertOwner(name, owner);
  const page = await manager.readTranscript(name, options);
  return { session: summarize(manager, page.session), events: page.events, hasMore: page.hasMore, nextCursor: page.nextCursor, previousCursor: page.previousCursor };
}

export async function sendGptSessionGuidance(cwdInput: string | undefined, name: string, ownerInput: string, message: string, mode: "steer" | "followUp" | "interrupt" = "steer") {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  if (typeof message !== "string" || !message.trim() || message.length > 100_000)
    throw new Error("指导消息必须是 1 到 100000 个字符。");
  const manager = managerFor(cwd);
  manager.assertOwner(name, owner);
  const result = await manager.send(name, message, mode, undefined, owner);
  return { session: summarize(manager, result.session), delivery: result.disposition ?? "accepted" };
}

export async function interruptGptSession(cwdInput: string | undefined, name: string, ownerInput: string): Promise<GptSessionSummary> {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  const manager = managerFor(cwd);
  const result = await manager.interrupt(name, owner);
  return summarize(manager, result.session);
}

export async function closeGptSession(cwdInput: string | undefined, name: string, ownerInput: string): Promise<GptSessionSummary> {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  const manager = managerFor(cwd);
  const session = await manager.close(name, false, owner);
  return summarize(manager, session);
}

export async function cleanupIdleGptSessions(cwdInput: string | undefined, ownerInput: string) {
  const cwd = await checkedCwd(cwdInput);
  const owner = checkedOwnerSessionId(ownerInput);
  const manager = managerFor(cwd);
  const eligible = manager.cleanupCandidates(owner);
  const results = await Promise.allSettled(eligible.map((session) => manager.closeIfIdle(session.id, owner)));
  const closed = results.flatMap((result, index) => result.status === "fulfilled" && result.value ? [eligible[index].name] : []);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [{ name: eligible[index].name, error: "关闭失败，请检查服务状态。" }] : []);
  return { closed, failures, sessions: manager.list(owner).map((session) => summarize(manager, session)) };
}

export function createGptSessionTools(cwd: string, getHistory?: ConversationHistory, ownerSessionId?: string): AgentTool<any>[] {
  return createSessionTools(async () => ({
    manager: managerFor(cwd),
    resolveModel: async (requested?: string) => {
      const runtime = await piRuntime();
      const credentials = await runtime.listCredentials();
      if (!credentials.some((credential) => credential.providerId === "openai-codex" && credential.type === "oauth"))
        throw new Error("请先在 Pi 中通过 /login 登录 OpenAI Codex。");
      const id = requested || process.env.PI_LAB_GPT_SUBAGENT_MODEL?.trim() || "gpt-6-luna";
      if (!id || !runtime.getModel("openai-codex", id))
        throw new Error(`Pi 中找不到 GPT 模型：${id || "模型目录为空"}`);
      return id;
    },
  }), getHistory, ownerSessionId);
}

export async function shutdownGptSessions() {
  const results = await Promise.allSettled([...managers.values()].map((manager) => manager.shutdown()));
  managers.clear();
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
