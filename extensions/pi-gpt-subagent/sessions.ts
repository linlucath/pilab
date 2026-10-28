import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { RpcTransport } from "./rpc.ts";

export type SessionStatus = "starting" | "running" | "idle" | "waiting_input" |
  "interrupted" | "suspended" | "closed" | "error";
export type SendMode = "steer" | "followUp" | "interrupt";
export const rolePresets = ["scout", "experimenter", "implementer"] as const;
export type GptRolePreset = (typeof rolePresets)[number];
export const rolePresetLabels: Record<GptRolePreset, string> = {
  scout: "探路学者", experimenter: "路径实验员", implementer: "工程执行员",
};
export const GPT_WAIT_TIMEOUT_SECONDS = 20 * 60;
export interface SessionInfo {
  id: string;
  name: string;
  role?: string;
  rolePreset?: GptRolePreset;
  cwd: string;
  model: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
  lastText: string;
  replySequence?: number;
  lastDeliveredReplySequence?: number;
  partialText: string;
  error?: string;
  cursor: number;
  pendingInput: Record<string, any>[];
  queuedMessages: { steering: string[]; followUp: string[] };
}
export interface ProgressEvent {
  sequence: number;
  at: number;
  type: string;
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}
export interface WorkerSpec {
  id: string;
  name: string;
  rolePreset?: GptRolePreset;
  cwd: string;
  model: string;
  sessionDirectory: string;
  sessionFile?: string;
}
export type TransportFactory = (
  spec: WorkerSpec,
  onEvent: (event: Record<string, any>) => void,
  onExit: (error?: Error) => void,
) => RpcTransport;
interface ManagedSession {
  info: SessionInfo;
  events: ProgressEvent[];
  client?: RpcTransport;
  ready: boolean;
  starting?: Promise<RpcTransport>;
  chain: Promise<unknown>;
  pendingOperations: number;
  epoch: number;
  quiet: number;
  active: boolean;
  lastPartialAt: number;
  roundTextSegments: string[];
  toolUpdateAt: Map<string, number>;
}
export interface SessionManagerOptions {
  storageDir: string;
  cwd: string;
  createTransport: TransportFactory;
  onNotice?(session: SessionInfo): void;
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}
function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 12_000);
}
function eventTail(file: string): ProgressEvent[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512_000);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ProgressEvent]; } catch { return []; }
    }).slice(-200);
  } finally { closeSync(fd); }
}

/** Persistent native Pi conversations, with independent live processes and control queues. */
export class GptSessionManager {
  private entries = new Map<string, ManagedSession>();
  private disposed = false;
  private shutdownPromise?: Promise<void>;
  private manifest: string;
  private waiters = new Map<ManagedSession, Set<() => void>>();

  constructor(private options: SessionManagerOptions) {
    mkdirSync(options.storageDir, { recursive: true, mode: 0o700 });
    this.manifest = path.join(options.storageDir, "sessions.json");
    if (!existsSync(this.manifest)) return;
    const saved = JSON.parse(readFileSync(this.manifest, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.sessions))
      throw new Error(`GPT session manifest is invalid: ${this.manifest}`);
    const usedNames = new Set<string>();
    for (const info of saved.sessions as SessionInfo[]) {
      if (!/^gpt-[a-f0-9-]+$/.test(info.id) || !path.isAbsolute(info.cwd))
        throw new Error(`GPT session manifest contains an invalid session: ${this.manifest}`);
      const baseName = info.name.trim().replace(/[\r\n|]/g, " ").slice(0, 160) || "GPT";
      info.name = baseName === "all" || /^gpt-[a-f0-9-]+$/.test(baseName) ? `会话 ${baseName}` : baseName;
      if (!rolePresets.includes(info.rolePreset as GptRolePreset)) delete info.rolePreset;
      if (info.rolePreset) info.role = rolePresetLabels[info.rolePreset];
      else if (typeof info.role !== "string" || !info.role.trim() || info.role.trim().length > 80 || /[\r\n]/.test(info.role))
        delete info.role;
      else info.role = info.role.trim();
      const originalName = info.name;
      for (let suffix = 2; usedNames.has(info.name); suffix++) info.name = `${originalName.slice(0, 150)} (${suffix})`;
      usedNames.add(info.name);
      if (["starting", "running", "waiting_input"].includes(info.status)) {
        info.status = "suspended";
        info.error = "Pi was reloaded or exited. Conversation retained; send a new message to resume. Pending input/queues were not resumed.";
      }
      info.pendingInput = [];
      info.queuedMessages = { steering: [], followUp: [] };
      const entry = this.makeEntry(info);
      entry.events = eventTail(this.eventFile(info.id));
      info.cursor = Math.max(info.cursor, entry.events.at(-1)?.sequence ?? 0);
      info.replySequence ??= [...entry.events].reverse().find((event) => event.type === "assistant" && info.lastText.startsWith(event.text))?.sequence ?? 0;
      this.entries.set(info.id, entry);
    }
  }

  private makeEntry(info: SessionInfo): ManagedSession {
    return {
      info, events: [], ready: false, chain: Promise.resolve(), pendingOperations: 0, epoch: 0,
      quiet: 0, active: false, lastPartialAt: 0, roundTextSegments: [], toolUpdateAt: new Map(),
    };
  }
  private eventFile(id: string) { return path.join(this.options.storageDir, `${id}.events.jsonl`); }
  private persist() {
    const temporary = `${this.manifest}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(temporary), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: this.list() }), { mode: 0o600 });
    renameSync(temporary, this.manifest);
  }
  private record(entry: ManagedSession, type: string, text: string, extra: Partial<ProgressEvent> = {}) {
    const event: ProgressEvent = {
      ...extra, sequence: ++entry.info.cursor, at: Date.now(), type,
      text: text.slice(0, 32_000),
    };
    entry.info.updatedAt = event.at;
    entry.events.push(event);
    if (entry.events.length > 200) entry.events.shift();
    const filePath = this.eventFile(entry.info.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.persist();
    this.changed(entry);
  }
  private changed(entry: ManagedSession) {
    for (const listener of this.waiters.get(entry) ?? []) queueMicrotask(listener);
  }
  private notify(entry: ManagedSession) {
    // An active wait delivers this update itself; don't also queue a parent turn.
    if (this.disposed || entry.quiet || this.waiters.get(entry)?.size) return;
    try { this.options.onNotice?.(this.view(entry)); } catch { /* Parent may be shutting down. */ }
  }
  private fail(entry: ManagedSession, error: unknown) {
    if (entry.quiet || this.disposed || ["interrupted", "closed"].includes(entry.info.status) || entry.info.status === "error") return;
    entry.info.status = "error";
    entry.info.error = errorText(error);
    this.record(entry, "error", entry.info.error);
    this.notify(entry);
  }
  markReplyDelivered(id: string, sequence: number) {
    const entry = this.get(id);
    if (!Number.isInteger(sequence) || sequence < 0) return;
    entry.info.lastDeliveredReplySequence = Math.max(entry.info.lastDeliveredReplySequence ?? 0, sequence);
    this.persist();
  }
  private view(entry: ManagedSession): SessionInfo {
    return structuredClone(entry.info);
  }
  private get(id: string) {
    const key = id.trim();
    const exactId = this.entries.get(key);
    if (exactId) return exactId;
    const named = [...this.entries.values()].filter((entry) => entry.info.name === key);
    if (named.length > 1) throw new Error(`GPT 会话名称重复：${id}。请先关闭旧会话并整理名称。`);
    if (named.length === 1) return named[0];
    const prefixes = [...this.entries.values()].filter((entry) => entry.info.id.startsWith(key));
    if (prefixes.length > 1) throw new Error(`GPT 会话 ID 前缀「${id}」不唯一，请提供更长的前缀。`);
    if (prefixes.length === 1) return prefixes[0];
    throw new Error(`找不到 GPT 会话「${id}」，请先查看会话列表。`);
  }
  private exclusive<T>(entry: ManagedSession, operation: () => Promise<T>, checkEpoch = true): Promise<T> {
    const epoch = entry.epoch;
    entry.pendingOperations++;
    const run = entry.chain.catch(() => {}).then(async () => {
      if (checkEpoch && (this.disposed || epoch !== entry.epoch))
        throw new Error("GPT session operation was interrupted.");
      return operation();
    }).finally(() => { entry.pendingOperations--; this.changed(entry); });
    entry.chain = run.then(() => {}, () => {});
    return run;
  }

  private start(entry: ManagedSession): Promise<RpcTransport> {
    if (entry.starting) return entry.starting;
    if (entry.client && entry.ready) return Promise.resolve(entry.client);
    if (this.disposed) return Promise.reject(new Error("GPT session manager is closed."));
    entry.info.status = "starting";
    entry.info.error = undefined;
    const client = this.options.createTransport({
      id: entry.info.id, name: entry.info.name, rolePreset: entry.info.rolePreset, cwd: entry.info.cwd,
      model: entry.info.model, sessionFile: entry.info.sessionFile,
      sessionDirectory: path.join(this.options.storageDir, "native"),
    }, (event) => this.handleEvent(entry, event), (error) => {
      if (entry.client !== client) return;
      entry.client = undefined;
      entry.ready = false;
      entry.active = false;
      entry.info.pendingInput = [];
      this.fail(entry, error ?? new Error("GPT process stopped unexpectedly."));
    });
    entry.client = client;
    entry.starting = (async () => {
      try {
        const state = await client.request("get_state");
        if (state.model?.provider !== "openai-codex" || state.model?.id !== entry.info.model)
          throw new Error("Pi started the GPT session with an unexpected model/provider.");
        entry.info.sessionFile = state.sessionFile;
        entry.info.status = "idle";
        entry.ready = true;
        this.record(entry, "ready", `Native Pi session ready (${entry.info.model}).`);
        return client;
      } catch (error) {
        await client.stop();
        throw error;
      } finally { entry.starting = undefined; }
    })();
    return entry.starting;
  }

  async create(input: { name: string; role?: string; rolePreset?: GptRolePreset; model: string; message?: string; cwd?: string }) {
    if (this.disposed) throw new Error("GPT session manager is closed.");
    const name = input.name.trim();
    if (input.rolePreset && !rolePresets.includes(input.rolePreset)) throw new Error("未知工兵角色预设。");
    const role = input.rolePreset ? rolePresetLabels[input.rolePreset] : input.role?.trim();
    if (role && (role.length > 80 || /[\r\n]/.test(role)))
      throw new Error("工兵角色标签最多 80 字，且不能包含换行。");
    if (!name || name.length > 160 || /[\r\n|]/.test(name) || name === "all" || /^gpt-[a-f0-9-]+$/.test(name))
      throw new Error("请使用 1–160 字的会话名称，不包含换行、竖线或保留名称 all、内部 ID。");
    const cwd = input.cwd || this.options.cwd;
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error("GPT working directory must be an existing absolute directory.");
    if ([...this.entries.values()].some((entry) => entry.info.name === name))
      throw new Error(`GPT 会话「${name}」已存在，请按名称继续对话，或使用另一个名称。`);
    const now = Date.now();
    const info: SessionInfo = {
      id: `gpt-${randomUUID()}`, name, ...(role ? { role } : {}), ...(input.rolePreset ? { rolePreset: input.rolePreset } : {}), cwd, model: input.model,
      status: "starting", createdAt: now, updatedAt: now, lastText: "", partialText: "",
      cursor: 0, pendingInput: [], queuedMessages: { steering: [], followUp: [] },
    };
    const entry = this.makeEntry(info);
    this.entries.set(info.id, entry);
    this.record(entry, "created", `Created ${input.name} with independent tools and conversation.`);
    const start = input.message
      ? this.send(info.id, input.message)
      : this.exclusive(entry, () => this.start(entry));
    // Creating a conversation never waits for model work or even process initialization.
    void start.catch((error) => this.fail(entry, error));
    return this.view(entry);
  }

  async send(id: string, message: string, mode: SendMode = "steer", rolePreset?: GptRolePreset) {
    if (!message.trim()) throw new Error("Message must not be empty.");
    if (rolePreset && !rolePresets.includes(rolePreset)) throw new Error("未知工兵角色预设。");
    if (mode === "interrupt") await this.interrupt(id);
    const entry = this.get(id);
    if (rolePreset) {
      entry.info.rolePreset = rolePreset;
      entry.info.role = rolePresetLabels[rolePreset];
      this.persist(); this.changed(entry);
    }
    return this.exclusive(entry, async () => {
      const epoch = entry.epoch;
      const client = await this.start(entry);
      if (this.disposed || epoch !== entry.epoch) throw new Error("GPT message was interrupted before delivery.");
      entry.info.error = undefined;
      entry.info.status = "running";
      const result = await client.request("prompt", {
        message, streamingBehavior: mode === "followUp" ? "followUp" : "steer",
      });
      if (result?.disposition === "handled" && !entry.active) entry.info.status = "idle";
      this.record(entry, "message_sent", message);
      return { session: this.view(entry), disposition: result?.disposition };
    });
  }

  async interrupt(id: string) {
    const entry = this.get(id);
    entry.epoch++;
    entry.quiet++;
    // An initialization dialog must not prevent the user from stopping the process.
    const stopStarting = entry.client && !entry.ready ? entry.client.stop() : undefined;
    try {
      if (stopStarting) await stopStarting;
      return await this.exclusive(entry, async () => {
        let cleared = { steering: [] as string[], followUp: [] as string[] };
        if (entry.client && entry.ready) {
          cleared = await entry.client.request("clear_queue");
          await entry.client.request("abort");
          const trailing = await entry.client.request<typeof cleared>("clear_queue");
          cleared.steering.push(...trailing.steering);
          cleared.followUp.push(...trailing.followUp);
        }
        entry.active = false;
        entry.info.status = "interrupted";
        entry.info.pendingInput = [];
        entry.info.queuedMessages = { steering: [], followUp: [] };
        this.record(entry, "interrupted", "Current work and queued messages stopped. Conversation retained.");
        return { session: this.view(entry), cleared };
      }, false);
    } finally { entry.quiet--; }
  }

  async close(id: string, suspend = false) {
    const entry = this.get(id);
    entry.epoch++;
    entry.quiet++;
    // Closing stdin also unblocks startup requests and makes Pi clean up its child commands.
    const stop = entry.client?.stop();
    try {
      if (stop) await stop;
      return await this.exclusive(entry, async () => {
        entry.client = undefined;
        entry.ready = false;
        entry.active = false;
        const priorStatus = entry.info.status;
        entry.info.status = suspend && ["interrupted", "closed", "error"].includes(priorStatus)
          ? priorStatus : suspend ? "suspended" : "closed";
        entry.info.pendingInput = [];
        entry.info.queuedMessages = { steering: [], followUp: [] };
        this.record(entry, entry.info.status, "Process stopped. Native conversation retained; sending a message reopens it.");
        return this.view(entry);
      }, false);
    } finally { entry.quiet--; }
  }

  async respond(id: string, requestId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const entry = this.get(id);
    const request = entry.info.pendingInput.find((item) => item.id === requestId);
    if (!request || !entry.client) throw new Error("That GPT input request is no longer pending.");
    if (request.method === "confirm" && !answer.cancelled && typeof answer.confirmed !== "boolean")
      throw new Error("A confirmation requires confirmed: true or false.");
    if (["input", "editor"].includes(request.method) && !answer.cancelled && typeof answer.value !== "string")
      throw new Error("An input response requires a string.");
    if (request.method === "select" && !answer.cancelled && !request.options?.includes(answer.value))
      throw new Error("Select one of the values in the GPT input request.");
    await entry.client.reply({ id: requestId, ...answer });
    entry.info.pendingInput = entry.info.pendingInput.filter((item) => item.id !== requestId);
    entry.info.status = entry.ready ? "running" : "starting";
    this.record(entry, "input_response", JSON.stringify(answer));
    return this.view(entry);
  }

  list(): SessionInfo[] { return [...this.entries.values()].map((entry) => this.view(entry)); }

  cleanupCandidates(): SessionInfo[] {
    const eligible = new Set(["idle", "suspended", "interrupted", "error"]);
    return [...this.entries.values()].filter((entry) => eligible.has(entry.info.status) && !entry.active && entry.pendingOperations === 0).map((entry) => this.view(entry));
  }

  async closeIfIdle(id: string) {
    const entry = this.get(id);
    if (!["idle", "suspended", "interrupted", "error"].includes(entry.info.status) || entry.active || entry.pendingOperations > 0) return undefined;
    return this.close(id);
  }

  recentEvents(name: string): ProgressEvent[] { return structuredClone(this.get(name).events); }

  hasActiveWaiter(id: string): boolean { return !!this.waiters.get(this.get(id))?.size; }

  /** Wait on state changes, without polling files or holding the command queue. */
  async wait(names: string[], timeoutMs = GPT_WAIT_TIMEOUT_SECONDS * 1_000, signal?: AbortSignal, mode: "any" | "all" = "any", startAfter?: Promise<unknown>): Promise<{
    session?: SessionInfo; sessions: SessionInfo[]; timedOut: boolean; completed: boolean;
  }> {
    if (!names.length || names.length > 8 || new Set(names.map((name) => name.trim())).size !== names.length)
      throw new Error("请提供 1–8 个不同的 GPT 会话名字。");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > GPT_WAIT_TIMEOUT_SECONDS * 1_000)
      throw new Error(`单次等待时间必须在 0–${GPT_WAIT_TIMEOUT_SECONDS} 秒之间。`);
    const entries = names.map((name) => this.get(name));
    return new Promise((resolve, reject) => {
      let finished = false;
      let armed = !startAfter;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        for (const entry of entries) {
          const listeners = this.waiters.get(entry);
          listeners?.delete(check);
          if (!listeners?.size) this.waiters.delete(entry);
        }
      };
      const finish = (entry?: ManagedSession, error?: Error, completed = false, timedOut = false) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve({ ...(entry ? { session: this.view(entry) } : {}), sessions: entries.map((item) => this.view(item)), timedOut, completed });
      };
      const abort = () => finish(undefined, new Error("等待已取消；GPT 仍可继续在后台工作。"));
      const check = () => {
        if (finished || !armed) return;
        if (signal?.aborted) return abort();
        if (this.disposed) return finish(undefined, new Error("GPT 会话管理器已关闭，等待已结束。"));
        const ready = (entry: ManagedSession) => !["starting", "running"].includes(entry.info.status) &&
          // Startup briefly reports idle before a queued prompt is accepted.
          (entry.info.status !== "idle" || entry.pendingOperations === 0);
        if (mode === "any") {
          const first = entries.find(ready);
          if (first) finish(first, undefined, true);
          return;
        }
        const needsAttention = entries.find((entry) => ["waiting_input", "error", "interrupted", "suspended", "closed"].includes(entry.info.status));
        if (needsAttention) { finish(needsAttention); return; }
        if (entries.every(ready)) finish(undefined, undefined, true);
      };
      if (signal?.aborted) return abort();
      for (const entry of entries) {
        if (!this.waiters.has(entry)) this.waiters.set(entry, new Set());
        this.waiters.get(entry)!.add(check);
      }
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { check(); finish(undefined, undefined, false, true); }, timeoutMs);
      if (startAfter) {
        void startAfter.then(() => { armed = true; check(); }, (error) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
      } else check();
    });
  }

  read(id: string, after = 0, limit = 25) {
    const entry = this.get(id);
    const events: ProgressEvent[] = [];
    let budget = 48_000;
    for (const event of entry.events.filter((item) => item.sequence > after)) {
      if (events.length >= limit || (events.length && budget < event.text.length)) break;
      events.push(structuredClone(event));
      budget -= event.text.length;
    }
    return {
      session: this.view(entry), events,
      nextCursor: events.at(-1)?.sequence ?? after,
      historyTruncated: after < (entry.events[0]?.sequence ?? 1) - 1,
      eventFile: this.eventFile(entry.info.id),
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    for (const entry of this.waiters.keys()) this.changed(entry);
    this.shutdownPromise = (async () => {
      const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id, true)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.shutdownPromise;
  }

  private handleEvent(entry: ManagedSession, event: Record<string, any>) {
    if (event.type === "agent_start") {
      entry.active = true;
      entry.roundTextSegments = [];
      entry.info.partialText = "";
      entry.info.status = "running";
      this.record(entry, "running", "GPT started working.");
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      entry.info.partialText = "";
      entry.info.error = undefined;
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type !== "text_delta") return;
      entry.info.partialText = (entry.info.partialText + update.delta).slice(-16_000);
      if (Date.now() - entry.lastPartialAt > 750) {
        entry.lastPartialAt = Date.now();
        this.record(entry, "assistant_progress", entry.info.partialText);
      }
    } else if (event.type === "message_end") {
      const message = event.message;
      if (message?.role === "assistant") {
        const text = contentText(message.content).trim();
        const previous = entry.roundTextSegments.at(-1);
        if (text && text !== previous) entry.roundTextSegments.push(text);
        entry.info.partialText = "";
        if (message.stopReason === "error") entry.info.error = message.errorMessage || "GPT provider error.";
      } else if (message?.role === "user") this.record(entry, "user", contentText(message.content));
    } else if (event.type === "tool_execution_start") {
      this.record(entry, "tool_start", JSON.stringify(event.args ?? {}), { toolName: event.toolName, toolCallId: event.toolCallId });
    } else if (event.type === "tool_execution_update") {
      const previous = entry.toolUpdateAt.get(event.toolCallId) ?? 0;
      if (Date.now() - previous < 750) return;
      entry.toolUpdateAt.set(event.toolCallId, Date.now());
      this.record(entry, "tool_progress", contentText(event.partialResult?.content), { toolName: event.toolName, toolCallId: event.toolCallId });
    } else if (event.type === "tool_execution_end") {
      entry.toolUpdateAt.delete(event.toolCallId);
      this.record(entry, "tool_end", contentText(event.result?.content), {
        toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
      });
    } else if (event.type === "queue_update") {
      entry.info.queuedMessages = { steering: event.steering ?? [], followUp: event.followUp ?? [] };
      this.persist();
    } else if (event.type === "agent_settled" || event.type === "agent_end") {
      const wasActive = entry.active;
      if (!wasActive && !entry.roundTextSegments.length) return;
      entry.active = false;
      const aggregated = entry.roundTextSegments.join("\n\n");
      if (aggregated) {
        entry.info.lastText = aggregated.slice(0, 64_000);
        entry.info.replySequence = entry.info.cursor + 1;
        this.record(entry, "assistant", entry.info.lastText);
      }
      entry.roundTextSegments = [];
      entry.info.partialText = "";
      entry.info.status = event.aborted ? "interrupted" : entry.info.error ? "error" : "idle";
      entry.info.pendingInput = [];
      this.record(entry, "settled", `GPT turn settled (${entry.info.status}).`);
      if (wasActive && !event.aborted) this.notify(entry);
    } else if (event.type === "extension_ui_request") {
      if (["confirm", "select", "input", "editor"].includes(event.method)) {
        entry.info.pendingInput.push({
          id: event.id, method: event.method, title: event.title, message: event.message,
          options: event.options, placeholder: event.placeholder,
        });
        entry.info.status = "waiting_input";
        this.record(entry, "input_required", JSON.stringify(entry.info.pendingInput.at(-1)));
        this.notify(entry);
      } else if (event.method === "notify") this.record(entry, "notice", String(event.message));
    }
  }
}
