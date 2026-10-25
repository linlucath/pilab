import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, validateTranscript } from "./engine";
import { runSchema } from "../shared/schema";
import { piStatus } from "./pi-subscription";
import { cleanupIdleGptSessions, closeGptSession, interruptGptSession, listGptSessions, shutdownGptSessions } from "./gpt-subagent";
import { ProjectWorkspaceStore } from "./workspace";
import { projectImages } from "./images";
import {
  syncList, syncDetail, syncApply, syncCancel,
  piSnapshotReader, streamPiSnapshots,
} from "./pi-sync";
import { clearLogs, logEvent, queryLogs, type LogCategory, type LogLevel } from "./logger";
import { isE2eMode, resetE2eMockScript, setE2eMockScript } from "./e2e-mock";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.PI_LAB_DATA_DIR || root);
const app = express();
const workspaceStore = new ProjectWorkspaceStore(path.join(dataRoot, ".pi-lab", "workspace.json"));
app.disable("x-powered-by");
app.use((req, res, next) => {
  // A local app: prevent third-party pages from making authenticated requests to the backend.
  const origin = req.get("origin");
  if (
    req.path.startsWith("/api/") &&
    origin &&
    origin !== `${req.protocol}://${req.get("host")}`
  ) {
    res.status(403).json({ error: "不允许跨站请求" });
    return;
  }
  next();
});
app.use(express.json({ limit: "5mb" }));
app.get("/api/images/file", (req, res) => {
  try {
    if (typeof req.query.file !== "string") throw new Error("图片引用无效。");
    const file = projectImages.filePath(req.query.file);
    res.set({ "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.sendFile(file, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  } catch { res.status(400).end(); }
});
app.get("/api/workspace", async (_req, res) => {
  try { res.set("Cache-Control", "no-store").json({ workspace: await workspaceStore.get() }); }
  catch (error) { res.status(503).json({ error: (error as Error).message }); }
});
app.post("/api/workspace", async (req, res) => {
  try { res.json({ workspace: await workspaceStore.initialize(req.body) }); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
for (const method of ["patch", "post"] as const)
  app[method]("/api/workspace/changes", async (req, res) => {
    try { res.json({ workspace: await workspaceStore.update(req.body) }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
app.get("/api/logs", (req, res) => {
  const categoryValue = req.query.category;
  const categories = ["server", "run", "gpt", "client"] as const;
  if (categoryValue !== undefined &&
      (typeof categoryValue !== "string" || (categoryValue !== "all" && !categories.includes(categoryValue as LogCategory)))) {
    res.status(400).json({ ok: false, error: "category 必须是 all、server、run、gpt 或 client。" });
    return;
  }
  const limitValue = req.query.limit;
  const limit = limitValue === undefined ? 200 : typeof limitValue === "string" ? Number(limitValue) : NaN;
  if (!Number.isFinite(limit) || limit < 0) {
    res.status(400).json({ ok: false, error: "limit 必须是非负数字。" });
    return;
  }
  const search = req.query.q;
  if (search !== undefined && typeof search !== "string") {
    res.status(400).json({ ok: false, error: "q 必须是单个搜索字符串。" });
    return;
  }
  const category = categoryValue && categoryValue !== "all" ? categoryValue as LogCategory : undefined;
  res.set("Cache-Control", "no-store").json({
    ok: true,
    logs: queryLogs({ category, limit, search }),
  });
});
app.post("/api/logs/client", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const level: LogLevel = body.level === "info" || body.level === "warn" || body.level === "error"
    ? body.level : "error";
  const event = typeof body.event === "string" && body.event.trim() ? body.event : "client_report";
  const message = typeof body.message === "string" ? body.message : "前端报告了一个异常或流中断。";
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown> : {};
  const entry = logEvent("client", level, event, message, data);
  res.status(201).json({ ok: true, log: entry });
});
app.delete("/api/logs", (_req, res) => {
  clearLogs();
  res.json({ ok: true });
});
app.get("/api/gpt-sessions", async (req, res) => {
  const startedAt = Date.now();
  let cwd: string | undefined;
  try {
    const value = req.query.cwd;
    if (value !== undefined && typeof value !== "string") throw new Error("cwd 必须是单个目录路径。");
    cwd = value;
    const sessions = await listGptSessions(cwd);
    logEvent("gpt", "info", "gpt_sessions_list", "已读取 GPT 会话列表。", {
      cwd, durationMs: Date.now() - startedAt, sessionCount: sessions.length,
    });
    res.set("Cache-Control", "no-store").json({ sessions });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent("gpt", "error", "gpt_sessions_list_error", "读取 GPT 会话列表失败。", {
      cwd, durationMs: Date.now() - startedAt, reason,
    });
    res.status(400).json({ error: reason });
  }
});
app.post("/api/gpt-sessions/cleanup", async (req, res) => {
  const startedAt = Date.now();
  const { cwd } = req.body || {};
  try {
    if (cwd !== undefined && typeof cwd !== "string") throw new Error("cwd 必须是目录路径。");
    const result = await cleanupIdleGptSessions(cwd);
    logEvent("gpt", "info", "gpt_sessions_cleanup", "已清理空闲 GPT 会话。", {
      cwd, durationMs: Date.now() - startedAt, closedCount: result.closed.length,
      failureCount: result.failures.length, remainingCount: result.sessions.length,
    });
    res.json(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent("gpt", "error", "gpt_sessions_cleanup_error", "清理 GPT 会话失败。", {
      cwd, durationMs: Date.now() - startedAt, reason,
    });
    res.status(400).json({ error: reason });
  }
});
app.post("/api/gpt-sessions/interrupt", async (req, res) => {
  const startedAt = Date.now();
  const { cwd, name } = req.body || {};
  try {
    if (cwd !== undefined && typeof cwd !== "string") throw new Error("cwd 必须是目录路径。");
    if (typeof name !== "string" || !name.trim()) throw new Error("name 必须是 GPT 会话名称或 ID。");
    const session = await interruptGptSession(cwd, name);
    logEvent("gpt", "info", "gpt_session_interrupt", "已中断 GPT 会话。", {
      cwd, name, durationMs: Date.now() - startedAt, sessionId: session.id,
    });
    res.json({ session });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent("gpt", "error", "gpt_session_interrupt_error", "中断 GPT 会话失败。", {
      cwd, name, durationMs: Date.now() - startedAt, reason,
    });
    res.status(400).json({ error: reason });
  }
});
app.post("/api/gpt-sessions/close", async (req, res) => {
  const startedAt = Date.now();
  const { cwd, name } = req.body || {};
  try {
    if (cwd !== undefined && typeof cwd !== "string") throw new Error("cwd 必须是目录路径。");
    if (typeof name !== "string" || !name.trim()) throw new Error("name 必须是 GPT 会话名称或 ID。");
    const session = await closeGptSession(cwd, name);
    logEvent("gpt", "info", "gpt_session_close", "已关闭 GPT 会话。", {
      cwd, name, durationMs: Date.now() - startedAt, sessionId: session.id,
    });
    res.json({ session });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent("gpt", "error", "gpt_session_close_error", "关闭 GPT 会话失败。", {
      cwd, name, durationMs: Date.now() - startedAt, reason,
    });
    res.status(400).json({ error: reason });
  }
});
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    engine: "pi-agent-core",
    workingDirectory: isE2eMode() ? process.env.PI_LAB_E2E_CWD || process.cwd() : process.cwd(),
  });
});
app.post("/api/e2e/reset", async (_req, res) => {
  if (!isE2eMode()) { res.sendStatus(404); return; }
  try {
    await workspaceStore.reset();
    resetE2eMockScript();
    clearLogs();
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.put("/api/e2e/mock", (req, res) => {
  if (!isE2eMode()) { res.sendStatus(404); return; }
  try {
    setE2eMockScript(req.body?.script);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
app.get("/api/pi-status", async (_req, res) => {
  try {
    res.json(await piStatus());
  } catch {
    res.status(503).json({
      connected: false,
      error: "无法读取 Pi 登录状态，请检查本机 Pi 配置。",
    });
  }
});
app.get("/api/pi-sync", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await syncList());
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});
app.get("/api/pi-sync/:id", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await syncDetail(req.params.id));
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});
app.get("/api/pi-sync/:id/events", async (req, res) => {
  const abort = new AbortController();
  const close = () => abort.abort();
  res.on("close", close);
  try {
    const read = piSnapshotReader(req.params.id);
    const initial = await read();
    if (res.destroyed) return;
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const emit = async (event: string, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            res.off("close", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
          if (res.destroyed) finish();
        });
    };
    await emit("snapshot", initial);
    await streamPiSnapshots(
      read,
      (detail) => emit("snapshot", detail),
      (error) => emit("sync_error", { error }),
      abort.signal,
    );
  } catch (e) {
    if (!res.headersSent && !res.destroyed)
      res.status(404).json({ error: (e as Error).message });
  } finally {
    res.off("close", close);
    if (!res.writableEnded) res.end();
  }
});
app.post("/api/pi-sync/:id/apply", async (req, res) => {
  try {
    res.json(await syncApply(req.params.id, req.body));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});
app.post("/api/pi-sync/:id/cancel", async (req, res) => {
  try {
    res.json(await syncCancel(req.params.id, req.body?.commandId));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});
app.post("/api/run", async (req, res) => {
  const startedAt = Date.now();
  const runId = randomUUID();
  const submitted = req.body && typeof req.body === "object" ? req.body : {};
  const submittedSettings = submitted.settings && typeof submitted.settings === "object" ? submitted.settings : {};
  const submittedMessages = Array.isArray(submitted.messages) ? submitted.messages : [];
  const submittedChars = submittedMessages.reduce((total: number, message: any) =>
    total + (typeof message?.content === "string" ? message.content.length : 0), 0);
  logEvent("run", "info", "run_started", "收到模型运行请求。", {
    runId,
    protocol: typeof submittedSettings.protocol === "string" ? submittedSettings.protocol : undefined,
    model: typeof submittedSettings.model === "string" ? submittedSettings.model : undefined,
    messageCount: submittedMessages.length,
    inputChars: submittedChars,
  });
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    const reason = `配置无效：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
    logEvent("run", "error", "run_validation_error", "模型运行配置校验失败。", {
      runId, durationMs: Date.now() - startedAt, reason,
      messageCount: submittedMessages.length, inputChars: submittedChars,
    });
    res.status(400).json({ error: reason });
    return;
  }
  const { settings, messages } = parsed.data;
  const inputChars = messages.filter((message) => message.enabled)
    .reduce((total, message) => total + message.content.length, 0);
  const messageCount = messages.filter((message) => message.enabled).length;
  try {
    validateTranscript(settings, messages);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logEvent("run", "error", "run_validation_error", "模型运行对话校验失败。", {
      runId, durationMs: Date.now() - startedAt, reason, messageCount, inputChars,
      protocol: settings.protocol, model: settings.model,
    });
    res.status(400).json({ error: reason });
    return;
  }
  res.status(200).set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const abort = new AbortController();
  let normalDone = false;
  let clientDisconnected = false;
  let errorLogged = false;
  let outputChars = 0;
  const secrets = [
    settings.apiKey,
    process.env.PI_LAB_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.CODEX_API_KEY,
  ];
  const redact = (value: string) => {
    let safe = value;
    for (const secret of secrets)
      if (secret && secret.length > 3) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe;
  };
  const logRunError = (message: string) => {
    if (errorLogged || clientDisconnected) return;
    errorLogged = true;
    const reason = redact(message);
    logEvent("run", "error", "run_error", "模型运行发生错误。", {
      runId, durationMs: Date.now() - startedAt, inputChars, outputChars,
      messageCount, protocol: settings.protocol, model: settings.model, reason,
    });
  };
  const onClientClose = () => {
    if (normalDone || res.writableEnded || clientDisconnected || (!req.aborted && !res.destroyed)) return;
    clientDisconnected = true;
    abort.abort();
    logEvent("run", "warn", "run_unexpected_close", "客户端在模型运行正常完成前断开连接。", {
      runId, durationMs: Date.now() - startedAt, inputChars, outputChars,
      messageCount, protocol: settings.protocol, model: settings.model,
    });
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  const emit = (event: Record<string, unknown>) => {
    if (event.type === "text" && typeof event.delta === "string") outputChars += event.delta.length;
    if (event.type === "done") {
      normalDone = true;
      logEvent("run", "info", "run_done", "模型流式运行正常完成。", {
        runId, durationMs: Date.now() - startedAt, inputChars, outputChars, messageCount,
        protocol: settings.protocol, model: settings.model,
        reason: event.reason, turns: event.turns, usage: event.usage,
      });
    } else if (event.type === "error") {
      logRunError(typeof event.message === "string" ? event.message : "模型请求失败");
    }
    if (res.destroyed || res.writableEnded) return;
    let line = JSON.stringify(event);
    // Provider errors may include HTTP diagnostics. Never reflect credentials back to the browser.
    for (const secret of secrets) {
      if (secret && secret.length > 3)
        line = line.replaceAll(secret, "[REDACTED]");
    }
    res.write(`${line}\n`);
  };
  try {
    await generate(parsed.data, emit, abort.signal);
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "模型请求失败");
    logRunError(reason);
    emit({ type: "error", message: reason });
  } finally {
    req.off("close", onClientClose);
    res.off("close", onClientClose);
    res.end();
  }
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logEvent("server", "error", "request_error", "请求处理失败。", {
      method: req.method, path: req.path, reason: error.message || "请求解析失败",
    });
    if (!res.headersSent)
      res.status(400).json({ error: error.message || "请求解析失败" });
  },
);
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "127.0.0.1", () => {
  logEvent("server", "info", "server_started", "Pi Lab 服务已启动。", {
    port, host: "127.0.0.1", pid: process.pid, nodeEnv: process.env.NODE_ENV || "development",
  });
  console.log(`Pi Lab ready at http://127.0.0.1:${port}`);
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    logEvent("server", "warn", "shutdown_signal", "服务收到退出信号。", {
      signal, pid: process.pid,
    });
    server.close();
    void Promise.all([shutdownGptSessions(), workspaceStore.flush()]).then(
      () => {
        logEvent("server", "info", "server_stopped", "服务资源清理完成。", { signal });
        process.exit(0);
      },
      (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        logEvent("server", "error", "shutdown_error", "服务退出清理失败。", { signal, reason });
        console.error(error);
        process.exit(1);
      },
    );
  });
