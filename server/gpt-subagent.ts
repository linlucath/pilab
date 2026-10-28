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
    status: session.status,
    model: session.model,
    updatedAt: session.updatedAt,
    ...(typeof session.replySequence === "number" ? { replySequence: session.replySequence } : {}),
    hasUnreadReply: !!session.lastText && (session.replySequence ?? 0) > (session.lastDeliveredReplySequence ?? 0),
    pendingQuestionCount: session.pendingInput.length,
    recentTools: summarizeRecentTools(recent),
    lastReplyPreview: preview.length > 300 ? `${preview.slice(0, 299)}…` : preview,
  };
}

export async function listGptSessions(cwdInput?: string): Promise<GptSessionSummary[]> {
  const cwd = await checkedCwd(cwdInput);
  const manager = managerFor(cwd);
  return manager.list().map((session) => summarize(manager, session));
}

export async function interruptGptSession(cwdInput: string | undefined, name: string): Promise<GptSessionSummary> {
  const cwd = await checkedCwd(cwdInput);
  const manager = managerFor(cwd);
  const result = await manager.interrupt(name);
  return summarize(manager, result.session);
}

export async function closeGptSession(cwdInput: string | undefined, name: string): Promise<GptSessionSummary> {
  const cwd = await checkedCwd(cwdInput);
  const manager = managerFor(cwd);
  const session = await manager.close(name);
  return summarize(manager, session);
}

export async function cleanupIdleGptSessions(cwdInput?: string) {
  const cwd = await checkedCwd(cwdInput);
  const manager = managerFor(cwd);
  const eligible = manager.cleanupCandidates();
  const results = await Promise.allSettled(eligible.map((session) => manager.closeIfIdle(session.id)));
  const closed = results.flatMap((result, index) => result.status === "fulfilled" && result.value ? [eligible[index].name] : []);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [{ name: eligible[index].name, error: "关闭失败，请检查服务状态。" }] : []);
  return { closed, failures, sessions: manager.list().map((session) => summarize(manager, session)) };
}

export function createGptSessionTools(cwd: string, getHistory?: ConversationHistory): AgentTool<any>[] {
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
  }), getHistory);
}

export async function shutdownGptSessions() {
  const results = await Promise.allSettled([...managers.values()].map((manager) => manager.shutdown()));
  managers.clear();
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
