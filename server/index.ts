import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, validateTranscript } from "./engine";
import { runSchema } from "../shared/schema";
import { piStatus } from "./pi-subscription";
import {
  syncList, syncDetail, syncApply, syncCancel,
  piSnapshotReader, streamPiSnapshots,
} from "./pi-sync";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
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
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    engine: "pi-agent-core",
    workingDirectory: process.cwd(),
  });
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
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: `配置无效：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    });
    return;
  }
  try {
    validateTranscript(parsed.data.settings, parsed.data.messages);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  res.status(200).set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const abort = new AbortController();
  const cancel = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on("close", cancel);
  const key = parsed.data.settings.apiKey;
  const emit = (event: Record<string, unknown>) => {
    if (res.destroyed || res.writableEnded) return;
    let line = JSON.stringify(event);
    // Provider errors may include HTTP diagnostics. Never reflect credentials back to the browser.
    for (const secret of [
      key,
      process.env.PI_LAB_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
    ]) {
      if (secret && secret.length > 3)
        line = line.replaceAll(secret, "[REDACTED]");
    }
    res.write(`${line}\n`);
  };
  try {
    await generate(parsed.data, emit, abort.signal);
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : "模型请求失败",
    });
  } finally {
    res.off("close", cancel);
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
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (!res.headersSent)
      res.status(400).json({ error: error.message || "请求解析失败" });
  },
);
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () =>
  console.log(`Pi Lab ready at http://127.0.0.1:${port}`),
);
