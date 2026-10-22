import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyOverride,
  atomicJson,
  makeOverride,
  nativeRevision,
  type NativeMessage,
  type Override,
} from "./state.ts";

const entryType = "pi-lab-context-v1";
export default function piLabSync(pi: ExtensionAPI) {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const bridgeDir = join(agentDir, "pi-lab-sync");
  let ctx: ExtensionContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let partialTimer: ReturnType<typeof setTimeout> | undefined;
  let key = "";
  let overlay: Override | undefined;
  let error = "";
  let ack: { id: string; status: string; error?: string } | undefined;
  let requestCount = 0;
  let lastAppliedRequest = 0;
  let active = false;
  let lastPublish = 0;
  let lastRevision = "";
  let requestMessages: NativeMessage[] | undefined;
  let requestRaw: NativeMessage[] | undefined;
  let requestLeaf: string | null = null;
  let partial: NativeMessage | undefined;
  let activityAt = Date.now();
  const statePath = () => join(bridgeDir, `${key}.json`);
  const commandPath = () => join(bridgeDir, `${key}.command.json`);
  function rawContext(): NativeMessage[] {
    // Use the exact request context until the canonical projection advances.
    if (requestRaw && requestLeaf === ctx.sessionManager.getLeafId())
      return requestRaw;
    const messages = ctx.sessionManager.buildSessionProjection()
      .messages as NativeMessage[];
    return messages.some((m) => m.role === "system")
      ? messages
      : [
          { role: "system", content: ctx.getSystemPrompt(), timestamp: 0 },
          ...messages,
        ];
  }
  function effective(raw: NativeMessage[]) {
    try {
      return applyOverride(raw, overlay);
    } catch (e) {
      error = (e as Error).message;
      return raw;
    }
  }
  function snapshot() {
    const raw = rawContext();
    const messages = effective(raw);
    const model = ctx.model
      ? { id: ctx.model.id, provider: ctx.model.provider, api: ctx.model.api }
      : null;
    const thinking = pi.getThinkingLevel();
    return {
      raw,
      messages,
      model,
      thinking,
      revision: nativeRevision(messages, model, thinking),
    };
  }
  function publish(force = false, online = true) {
    if (!ctx || !key) return;
    if (force && partialTimer) {
      clearTimeout(partialTimer);
      partialTimer = undefined;
    }
    const state = snapshot();
    if (
      !force &&
      state.revision === lastRevision &&
      Date.now() - lastPublish < 2500
    )
      return;
    atomicJson(join(bridgeDir, `${key}.heartbeat`), { at: Date.now() });
    if (!force && state.revision === lastRevision) {
      lastPublish = Date.now();
      return;
    }
    if (state.revision !== lastRevision) activityAt = Date.now();
    atomicJson(statePath(), {
      version: 1,
      id: key,
      sessionId: ctx.sessionManager.getSessionId(),
      pid: process.pid,
      name:
        ctx.sessionManager.getSessionName() ||
        `Pi · ${ctx.cwd.split("/").filter(Boolean).pop() || "会话"}`,
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      messages: state.messages,
      model: state.model,
      thinking: state.thinking,
      revision: state.revision,
      busy: active || !ctx.isIdle(),
      online,
      heartbeat: Date.now(),
      activityAt,
      ack,
      error,
      requestCount,
      applied: !!overlay && !error,
      lastAppliedRequest,
      ...(partial ? { partial } : {}),
    });
    lastPublish = Date.now();
    lastRevision = state.revision;
  }
  function receive() {
    if (!existsSync(commandPath())) return;
    const command = JSON.parse(readFileSync(commandPath(), "utf8"));
    // Consume once. The server serializes writers with an exclusive command-file create.
    unlinkSync(commandPath());
    try {
      if (active || !ctx.isIdle())
        throw new Error("Pi 正在执行，请等本轮结束后重新提交。");
      const state = snapshot();
      if (command.revision !== state.revision)
        throw new Error("Pi 上下文已有新变化。请重新同步，核对后再提交。");
      if (!Array.isArray(command.messages)) throw new Error("修改格式无效");
      const next = makeOverride(state.raw, command.messages);
      pi.appendEntry(entryType, next);
      overlay = next;
      error = "";
      ack = { id: command.id, status: "applied" };
      ctx.ui.setStatus("pi-lab-sync", "Pi Lab · 网页上下文已应用");
      ctx.ui.notify(
        "Pi Lab：网页修改已应用，将用于后续模型请求。原始记录保留。",
        "info",
      );
    } catch (e) {
      ack = { id: command.id, status: "rejected", error: (e as Error).message };
    }
    publish(true);
  }
  function restore() {
    overlay = undefined;
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === entryType)
        overlay = entry.data as Override;
    requestRaw = undefined;
    requestMessages = undefined;
    partial = undefined;
    error = "";
  }
  function tick() {
    try {
      receive();
      publish();
    } catch {
      /* A failed mirror must never interrupt a Pi conversation. */
    }
  }
  pi.on("session_start", (_event, context) => {
    if (timer) clearInterval(timer);
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = undefined;
    if (ctx && key) publish(true, false);
    ctx = context;
    key = `${ctx.sessionManager.getSessionId()}-${process.pid}`;
    active = false;
    ack = undefined;
    requestCount = 0;
    lastAppliedRequest = 0;
    lastRevision = "";
    lastPublish = 0;
    activityAt = Date.now();
    restore();
    tick();
    timer = setInterval(tick, 750);
    timer.unref();
    ctx.ui.setStatus("pi-lab-sync", "Pi Lab · 实时同步");
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = undefined;
    try {
      publish(true, false);
    } catch {}
  });
  pi.on("session_tree", (_e, context) => {
    ctx = context;
    restore();
    tick();
  });
  pi.on("session_info_changed", () => publish(true));
  pi.on("model_select", () => publish(true));
  pi.on("thinking_level_select", () => publish(true));
  pi.on("agent_start", () => {
    active = true;
    activityAt = Date.now();
    publish(true);
  });
  pi.on("agent_settled", () => {
    active = false;
    partial = undefined;
    tick();
    publish(true);
  });
  pi.on("message_update", (event) => {
    partial = event.message as NativeMessage;
    // Coalesce rapid deltas, but flush the trailing delta even if generation
    // pauses without a message_end event (e.g. while waiting on the network).
    const delay = Math.max(0, 100 - (Date.now() - lastPublish));
    if (!delay) publish(true);
    else if (!partialTimer) {
      partialTimer = setTimeout(() => {
        partialTimer = undefined;
        try { publish(true); } catch { /* Never interrupt a Pi conversation. */ }
      }, delay);
      partialTimer.unref();
    }
  });
  pi.on("message_end", () => {
    partial = undefined;
    requestRaw = undefined;
    publish(true);
  });
  pi.on("context_with_system", (event) => {
    requestRaw = structuredClone(event.messages) as NativeMessage[];
    requestLeaf = ctx.sessionManager.getLeafId();
    requestMessages = effective(requestRaw);
    requestCount++;
    if (overlay && !error) lastAppliedRequest = requestCount;
    publish(true);
    return { messages: requestMessages as typeof event.messages };
  });
  pi.registerCommand("pi-lab", {
    description: "显示 Pi Lab 同步状态和网页地址",
    handler: async (_args, context) => {
      ctx = context;
      tick();
      ctx.ui.notify(
        `Pi Lab：http://127.0.0.1:3000 · ${error || (overlay ? "网页上下文已应用" : "实时同步中")}`,
        "info",
      );
    },
  });
}
