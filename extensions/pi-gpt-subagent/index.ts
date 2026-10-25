import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { GptSessionManager, type SessionInfo } from "./sessions.ts";
import { nativeTransportFactory, sessionStorageDir } from "./native.ts";
import { answerConversation, conversationSummary, createSessionTools, formatConversationRead, readConversation, type SessionAccess } from "./tools.ts";
import { createImageTools, latestImageContext, LocalImageStore, retainToolImages } from "./images.ts";

function resolveModel(ctx: ExtensionContext, requested?: string) {
  const id = requested || process.env.PI_LAB_GPT_SUBAGENT_MODEL?.trim() || "gpt-6-luna";
  const model = id ? ctx.modelRegistry.find("openai-codex", id) : undefined;
  if (!model) throw new Error(`Pi 中找不到 GPT 模型：${id || "模型目录为空"}`);
  if (!ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured)
    throw new Error("请先在 Pi 中通过 /login 登录 OpenAI Codex。");
  return model.id;
}

export default function piGptSessions(pi: ExtensionAPI) {
  const worker = process.env.PI_LAB_GPT_WORKER === "1";
  const coordinatorTools = new Set<string>();
  const stores = new Map<string, LocalImageStore>();
  const imageStore = (ctx?: ExtensionContext) => {
    const root = process.env.PI_LAB_IMAGE_ROOT || ctx?.cwd || process.cwd();
    if (!stores.has(root)) stores.set(root, new LocalImageStore(root));
    return stores.get(root)!;
  };
  for (const tool of createImageTools(imageStore, worker ? "publisher" : "viewer")) {
    coordinatorTools.add(tool.name);
    pi.registerTool({ ...tool, defaultActive: true });
  }
  // A worker is a normal Pi session, but does not recursively install its own session manager.
  if (worker) return;
  pi.on("context", (event) => ({ messages: latestImageContext(event.messages) }));
  pi.on("tool_result", (event, ctx) => retainToolImages(imageStore(ctx), event, event.toolName));
  let manager: GptSessionManager | undefined;
  let owner = "";
  let context: ExtensionContext | undefined;
  let switching: Promise<void> = Promise.resolve();

  function footer() {
    if (!context || !manager) return;
    const sessions = manager.list();
    const running = sessions.filter((session) => ["starting", "running", "waiting_input"].includes(session.status)).length;
    context.ui.setStatus("gpt-sessions", `GPT · ${running} 运行 / ${sessions.length} 会话`);
  }
  function notice(session: SessionInfo) {
    footer();
    pi.sendMessage({
      customType: "gpt-session-update", display: true,
      content: JSON.stringify({
        source: "GPT conversation", ...conversationSummary(session),
        instruction: "This is a status update from another conversation. Use its name with gpt_session_read for unread replies or gpt_session_send to continue. A settled turn does not prove task success. Do not resume user-interrupted work without instruction.",
      }),
      details: { name: session.name, status: session.status },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }
  async function access(ctx?: ExtensionContext): Promise<SessionAccess> {
    if (!ctx) throw new Error("Pi session context is unavailable.");
    const id = ctx.sessionManager.getSessionId();
    // Serialize parent replacements while allowing all worker processes to run concurrently.
    switching = switching.catch(() => {}).then(async () => {
      if (owner !== id || !manager) {
        await manager?.shutdown();
        owner = id;
        manager = new GptSessionManager({
          storageDir: sessionStorageDir(`pi:${id}`), cwd: ctx.cwd,
          createTransport: nativeTransportFactory(process.env.PI_LAB_IMAGE_ROOT || ctx.cwd), onNotice: notice,
        });
      }
      context = ctx;
    });
    await switching;
    return { manager: manager!, resolveModel: (requested) => resolveModel(ctx, requested) };
  }

  for (const tool of createSessionTools((ctx?: ExtensionToolContext) => access(ctx))) {
    coordinatorTools.add(tool.name);
    pi.registerTool({
      ...tool, defaultActive: true,
      execute: async (id, args, signal, onUpdate, ctx) => {
        const result = await tool.execute(id, args, signal, onUpdate, ctx);
        footer();
        return result;
      },
    });
  }
  function restrictCoordinatorTools() {
    // Apply to restored transcripts and reloads as well as new conversations.
    const active = pi.getActiveTools();
    const selected = active.filter((name) => coordinatorTools.has(name));
    if (selected.includes("gpt_session_read") && !selected.includes("gpt_session_wait"))
      selected.push("gpt_session_wait");
    if (selected.length !== active.length || selected.some((name, index) => name !== active[index]))
      pi.setActiveTools(selected);
  }
  pi.on("before_agent_start", () => { restrictCoordinatorTools(); });
  pi.on("session_start", async (_event, ctx) => {
    restrictCoordinatorTools();
    await access(ctx); footer();
  });
  pi.on("session_shutdown", async () => { await manager?.shutdown(); manager = undefined; owner = ""; });

  pi.registerCommand("gpt", {
    description: "管理并行 GPT 会话：list / new / read / send / after / replace / stop / close / reply",
    handler: async (args, ctx) => {
      try {
        const { manager: sessions, resolveModel: model } = await access(ctx);
        const verb = args.trim().split(/\s+/)[0] || "list";
        const rest = args.trim().replace(/^\S+\s*/, "");
        const separator = rest.indexOf("|");
        const name = (separator < 0 ? rest.split(/\s+/)[0] : rest.slice(0, separator)).trim();
        const tail = separator < 0 ? rest.replace(/^\S+\s*/, "") : rest.slice(separator + 1).trim();
        let output: unknown;
        if (verb === "list") output = sessions.list().map((session) => conversationSummary(session));
        else if (verb === "new") {
          if (!rest) throw new Error("用法：/gpt new 会话名字 | 任务");
          const created = await sessions.create({
            name: separator < 0 ? rest.slice(0, 80) : name,
            message: separator < 0 ? rest : tail || undefined, model: await model(),
          });
          output = { ...conversationSummary(created), model: created.model };
        } else if (verb === "read") {
          output = formatConversationRead(readConversation(sessions, rest));
        } else if (["send", "steer", "after", "replace"].includes(verb)) {
          if (!tail) throw new Error("用法：/gpt send 会话名字 | 消息");
          const sent = await sessions.send(name, tail, verb === "after" ? "followUp" : verb === "replace" ? "interrupt" : "steer");
          output = { ...conversationSummary(sent.session), delivery: sent.disposition ?? "accepted" };
        } else if (verb === "stop" || verb === "close") {
          const names = rest === "all" ? sessions.list().map((session) => session.name) : [rest];
          output = await Promise.all(names.map(async (target) => conversationSummary(verb === "stop"
            ? (await sessions.interrupt(target)).session : await sessions.close(target))));
        } else if (verb === "reply") {
          if (!tail) throw new Error("用法：/gpt reply 会话名字 | 回答（多个问题：名字 | 问题序号 | 回答）");
          const numbered = /^(\d+)\s*\|\s*([\s\S]+)$/.exec(tail);
          const question = numbered ? Number(numbered[1]) : undefined;
          const answer = numbered ? numbered[2] : tail;
          const pending = sessions.read(name).session.pendingInput;
          if (question === undefined && pending.length > 1) throw new Error("有多个问题，请指定问题序号。");
          const request = pending[(question ?? 1) - 1];
          if (!request) throw new Error("该输入请求已不存在。");
          if (request.method === "confirm" && !/^(yes|no|true|false|是|否)$/i.test(answer))
            throw new Error("确认问题请回答 yes 或 no。");
          output = await answerConversation(sessions, { name, question, ...(request.method === "confirm"
            ? { confirmed: /^(yes|true|是)$/i.test(answer) } : { value: answer }) });
        } else throw new Error("用法：/gpt list | new 名字 | 任务 | read 名字 | send 名字 | 消息 | after 名字 | 消息 | replace 名字 | 新指令 | stop 名字/all | close 名字/all | reply 名字 | 回答");
        footer();
        if (!["list", "read"].includes(verb))
          pi.sendMessage({
            customType: "gpt-session-control", display: false,
            content: `The user ran /gpt ${verb}. Treat this as a user control action, and do not restart stopped work without a user instruction.\n${JSON.stringify(output).slice(0, 12_000)}`,
          }, { triggerTurn: false, deliverAs: "steer" });
        ctx.ui.notify((typeof output === "string" ? output : JSON.stringify(output, null, 2)).slice(0, 32_000), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
