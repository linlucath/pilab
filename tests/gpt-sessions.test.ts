import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, access, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { GptSessionManager, type SessionInfo } from "../extensions/pi-gpt-subagent/sessions";
import { nativeTransportFactory } from "../extensions/pi-gpt-subagent/native";
import { createSessionTools } from "../extensions/pi-gpt-subagent/tools";
import { PiRpcProcess, type RpcTransport } from "../extensions/pi-gpt-subagent/rpc";

const model = "gpt-session-fixture";
function text(content: any): string {
  return typeof content === "string" ? content : (content || []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
function begin(res: ServerResponse) { res.writeHead(200, { "Content-Type": "text/event-stream" }); }
function chunk(res: ServerResponse, delta: object, finish: string | null = null) {
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function finish(res: ServerResponse, value: string) {
  if (!res.headersSent) begin(res);
  chunk(res, { role: "assistant", content: value });
  chunk(res, {}, "stop");
  res.end("data: [DONE]\n\n");
}
function tool(res: ServerResponse, name: string, args: object) {
  begin(res);
  chunk(res, { role: "assistant", tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  chunk(res, {}, "tool_calls");
  res.end("data: [DONE]\n\n");
}
async function until(check: () => boolean, explain: () => unknown = () => "condition not reached", timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) assert.fail(JSON.stringify(explain()));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function fixture(handler: (body: any, res: ServerResponse, root: string) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gpt-sessions-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(path.join(cwd, "AGENTS.md"), "Project guidance marker: FULL_NATIVE_CONTEXT_MARKER.\n");
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    try {
      const body = JSON.parse(raw);
      requests.push(body);
      handler(body, res, root);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    "openai-codex": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
      models: [{ id: model, name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    root, agentDir, cwd, requests,
    async cleanup() {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("native GPT conversations run concurrently, accept steering, interrupt real shell work and resume durable context", { timeout: 120_000 }, async () => {
  const held = new Map<string, () => void>();
  const notices: SessionInfo[] = [];
  const f = await fixture((body, res, root) => {
    const users = body.messages.filter((message: any) => message.role === "user").map((message: any) => text(message.content));
    const first = users[0];
    const task = ["ALPHA", "BETA"].find((marker) => first.includes(marker)) || first.split("\n")[0];
    const latest = users.at(-1);
    if (users.length > 1) return finish(res, `continuity:${task}:${latest?.split("\n")[0]}`);
    if (first.startsWith("PREFLIGHT")) return; // Hold the request until an explicit abort closes it.
    const results = body.messages.filter((message: any) => message.role === "tool");
    if (first === "BLOCK" && !results.length) {
      return tool(res, "bash", { command: `node -e "setTimeout(() => require('node:fs').writeFileSync('late.txt', 'unexpected'), 10000)"` });
    }
    if (first === "DIALOG" && !results.length) return tool(res, "ask_fixture", {});
    if (first === "DIALOG") return finish(res, `dialog:${text(results.at(-1).content)}`);
    if (!results.length) return tool(res, "write", { path: path.join(root, `outside-${task}.txt`), content: `written by ${task}` });
    begin(res);
    chunk(res, { role: "assistant", content: `working:${task}\u2028` });
    held.set(task, () => finish(res, `finished:${task}`));
  });
  const extensionDir = path.join(f.agentDir, "extensions");
  await mkdir(extensionDir);
  await writeFile(path.join(extensionDir, "ask.ts"), `
    import { Type } from "typebox";
    export default function (pi) {
      pi.on("input", async (event, ctx) => {
        if (event.text !== "PREFLIGHT") return;
        const answer = await ctx.ui.input("Preflight input");
        return { action: "transform", text: "PREFLIGHT_" + (answer || "cancelled") };
      });
      pi.registerTool({ name: "ask_fixture", label: "Ask fixture", description: "Ask for a fixture marker.", parameters: Type.Object({}),
        async execute(_id, _args, signal, _onUpdate, ctx) {
          const answer = await ctx.ui.input("What is the marker?", undefined, { signal });
          return { content: [{ type: "text", text: answer || "cancelled" }], details: {} };
        } });
    }
  `);
  const storageDir = path.join(f.root, "managed");
  const options = { storageDir, cwd: f.cwd, createTransport: nativeTransportFactory(), onNotice: (session: SessionInfo) => notices.push(session) };
  let manager = new GptSessionManager(options);
  try {
    const parent = new AbortController();
    const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, "parent-fixture");
    const create = tools.find((entry) => entry.name === "gpt_session_create")!;
    const first = await create.execute("create-alpha", { name: "alpha", rolePreset: "scout", message: "ALPHA" }, parent.signal);
    const alpha = manager.list().find((session) => session.name === first.details.name)!;
    assert.equal(alpha.rolePreset, "scout");
    assert.equal(alpha.role, "探路学者");
    assert.equal(first.details.rolePreset, "scout");
    parent.abort(); // Ending the coordinator's call must not cancel an independent worker.
    const beta = await manager.create({ name: "beta", model, message: "BETA" });
    assert.equal(alpha.status, "starting");
    assert.equal(beta.status, "starting");
    await until(() => held.has("ALPHA") && held.has("BETA") && !!manager.read(beta.id).session.partialText,
      () => manager.list());
    assert.equal(manager.read(alpha.id).session.status, "running");
    assert.equal(await readFile(path.join(f.root, "outside-ALPHA.txt"), "utf8"), "written by ALPHA");
    assert.equal(await readFile(path.join(f.root, "outside-BETA.txt"), "utf8"), "written by BETA");
    const queued = await manager.send(alpha.id, "CONTINUE_ALPHA");
    assert.equal(queued.disposition, "queued");
    held.get("ALPHA")!();
    held.get("BETA")!();
    await until(() => [alpha.id, beta.id].every((id) => manager.read(id).session.status === "idle"), () => manager.list());
    assert.match(manager.read(alpha.id).session.lastText, /continuity:ALPHA:CONTINUE_ALPHA/);
    assert.match(manager.read(beta.id).session.lastText, /\u2028finished:BETA/);
    assert.equal(notices.filter((session) => session.id === alpha.id && session.status === "idle").length, 1);
    assert.ok(f.requests.every((request) => text(request.messages[0].content).includes("FULL_NATIVE_CONTEXT_MARKER")));
    assert.ok(f.requests.some((request) => JSON.stringify(request.messages).includes("费曼式探索与结构化汇报协议")), "tool-created workers receive the Feynman report format");
    assert.ok(f.requests.some((request) => JSON.stringify(request.messages).includes("探路学者")), "role presets reach the worker instruction");

    const page = manager.read(alpha.id, 0, 2);
    assert.equal(page.events.length, 2);
    const next = manager.read(alpha.id, page.nextCursor, 2);
    assert.ok(next.events.every((event) => event.sequence > page.nextCursor));
    assert.equal(manager.read(alpha.id.slice(0, 12)).eventFile, page.eventFile);
    await manager.close(alpha.id);
    await manager.send(alpha.id, "REOPENED_ALPHA");
    await until(() => manager.read(alpha.id).session.status === "idle", () => manager.read(alpha.id));
    assert.match(manager.read(alpha.id).session.lastText, /continuity:ALPHA:REOPENED_ALPHA/);

    const block = await manager.create({ name: "blocking shell", model, message: "BLOCK" });
    await until(() => manager.read(block.id).events.some((event) => event.type === "tool_start" && event.toolName === "bash"), () => manager.list());
    await manager.send(block.id, "MUST_NOT_RUN", "followUp");
    const stopped = await manager.interrupt(block.id);
    assert.equal(stopped.session.status, "interrupted");
    assert.ok(stopped.cleared.followUp.includes("MUST_NOT_RUN"));
    await assert.rejects(access(path.join(f.cwd, "late.txt")));
    await manager.send(block.id, "AFTER_ABORT");
    await until(() => manager.read(block.id).session.status === "idle", () => manager.read(block.id));
    assert.match(manager.read(block.id).session.lastText, /continuity:BLOCK:AFTER_ABORT/);
    assert.ok(!f.requests.some((request) => JSON.stringify(request.messages).includes("MUST_NOT_RUN")));

    const preflight = await manager.create({ name: "unacknowledged input", model, message: "PREFLIGHT" });
    await until(() => manager.read(preflight.id).session.status === "waiting_input", () => manager.list());
    await manager.interrupt(preflight.id);
    assert.equal(manager.read(preflight.id).session.status, "interrupted");
    assert.equal(manager.read(preflight.id).session.pendingInput.length, 0);

    const dialog = await manager.create({ name: "question", model, message: "DIALOG" });
    await until(() => manager.read(dialog.id).session.status === "waiting_input", () => manager.list());
    const question = manager.read(dialog.id).session.pendingInput[0];
    await assert.rejects(manager.respond(dialog.id, question.id, {}), /requires a string/);
    await manager.respond(dialog.id, question.id, { value: "DIALOG_REPLY" });
    await until(() => manager.read(dialog.id).session.status === "idle", () => manager.read(dialog.id));
    assert.match(manager.read(dialog.id).session.lastText, /dialog:DIALOG_REPLY/);
    assert.ok(notices.some((session) => session.id === dialog.id && session.status === "waiting_input"));

    const never = await manager.create({ name: "close during startup", model, message: "NEVER_SEND" });
    await manager.close(never.id);
    assert.equal(manager.read(never.id).session.status, "closed");
    assert.ok(!f.requests.some((request) => JSON.stringify(request.messages).includes("NEVER_SEND")));
    await manager.shutdown();
    manager = new GptSessionManager(options);
    assert.equal(manager.list().length, 6);
    assert.equal(manager.read(preflight.id).session.status, "interrupted");
    await manager.send(alpha.id, "RESTORED_ALPHA");
    await until(() => manager.read(alpha.id).session.status === "idle", () => manager.read(alpha.id));
    assert.match(manager.read(alpha.id).session.lastText, /continuity:ALPHA:RESTORED_ALPHA/);
    const nativeFile = manager.read(alpha.id).session.sessionFile!;
    assert.match(await readFile(nativeFile, "utf8"), /CONTINUE_ALPHA/);
    await assert.rejects(access(path.join(f.cwd, "late.txt")));
  } finally { await manager.shutdown(); await f.cleanup(); }
});

test("installed Pi extension keeps child completion as UI-only notice until the coordinator resumes", { timeout: 45_000 }, async () => {
  let releaseChild: (() => void) | undefined;
  const f = await fixture((body, res) => {
    const users = body.messages.filter((message: any) => message.role === "user").map((message: any) => text(message.content));
    if (users[0].includes("CHILD_AUTO")) {
      assert.ok(!body.tools.some((entry: any) => entry.function.name.startsWith("gpt_session_")));
      releaseChild = () => finish(res, "child finished successfully");
      return;
    }
    if (users.at(-1) === "USER_STILL_TALKING") return finish(res, "coordinator is still available");
    if (users.at(-1) === "USER_MANUALLY_REVIEWING") return finish(res, "coordinator manually chose to review");
    if (body.messages.some((message: any) => message.role === "tool")) return finish(res, "coordinator free while child works");
    assert.ok(body.tools.some((entry: any) => entry.function.name === "gpt_session_create"));
    tool(res, "gpt_session_create", { name: "parallel child", message: "CHILD_AUTO", model });
  });
  await cp(path.resolve("extensions/pi-gpt-subagent"), path.join(f.agentDir, "extensions/pi-gpt-subagent"), { recursive: true });
  const events: any[] = [];
  const errors: Error[] = [];
  const parent = new PiRpcProcess({
    command: process.execPath, args: [process.env.PI_LAB_TEST_PI_CLI || path.join(getPackageDir(), "dist/bundle/cli.js"), "--mode", "rpc", "--provider", "openai-codex", "--model", model],
    cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_LAB_GPT_WORKER: "0" },
    onEvent: (event) => events.push(event), onExit: (error) => { if (error) errors.push(error); },
  });
  const assistantSaid = (value: string) => events.some((event) => event.type === "message_end" && event.message?.role === "assistant" && text(event.message.content).includes(value));
  try {
    await parent.request("get_state");
    const commands = await parent.request("get_commands");
    assert.ok(commands.commands.some((command: any) => command.name === "gpt"));
    assert.equal((await parent.request("prompt", { message: "/gpt" })).disposition, "handled");
    await parent.request("prompt", { message: "COORDINATOR" });
    await until(() => assistantSaid("coordinator free while child works") && !!releaseChild, () => ({ errors, events: events.slice(-5) }));
    const creation = events.find((event) => event.type === "tool_execution_end" && event.toolName === "gpt_session_create");
    const created = JSON.parse(text(creation.result.content));
    assert.equal(created.status, "starting");
    await parent.request("prompt", { message: "USER_STILL_TALKING", streamingBehavior: "steer" });
    await until(() => assistantSaid("coordinator is still available"), () => events.slice(-5));
    const requestsBeforeCompletion = f.requests.length;
    releaseChild!();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(f.requests.length, requestsBeforeCompletion, "a child completion must not start another parent model turn");
    assert.equal(assistantSaid("coordinator received child update"), false);
    await parent.request("prompt", { message: "USER_MANUALLY_REVIEWING", streamingBehavior: "steer" });
    await until(() => assistantSaid("coordinator manually chose to review"), () => ({ errors, events: events.slice(-5) }));
    const state = await parent.request("get_state");
    assert.equal(state.model.provider, "openai-codex");
    await parent.request("prompt", { message: `/gpt stop ${created.name}` });
    const messages = await parent.request("get_messages");
    assert.match(JSON.stringify(messages), /gpt-session-control/);
    assert.equal(errors.length, 0);
  } finally { await parent.stop(); await f.cleanup(); }
});

test("session persistence recreates its parent directories before manifest and event writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gpt-mkdir-"));
  const storageDir = path.join(root, "removed", "sessions");
  const manager = new GptSessionManager({ storageDir, cwd: root,
    createTransport: () => ({
      request: async <T = any>(type: string): Promise<T> => (type === "get_state" ? { model: { provider: "openai-codex", id: model } } : {}) as T,
      reply: async () => {}, stop: async () => {},
    }) });
  try {
    const session = await manager.create({ name: "mkdir recovery", model });
    await manager.wait([session.id], 2_000);
    await rm(path.dirname(storageDir), { recursive: true, force: true });
    await manager.close(session.id);
    const persisted = JSON.parse(await readFile(path.join(storageDir, "sessions.json"), "utf8"));
    assert.ok(persisted.sessions.some((entry: SessionInfo) => entry.id === session.id && entry.status === "closed"));
    assert.match(await readFile(path.join(storageDir, `${session.id}.events.jsonl`), "utf8"), /Process stopped/);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("legacy ownerless workers are adopted by their first parent and retain readable transcript history", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gpt-adopt-"));
  const manager = new GptSessionManager({ storageDir: path.join(root, "saved"), cwd: root,
    createTransport: (_spec, onEvent): RpcTransport => ({
      async request<T = any>(type: string): Promise<T> {
        if (type === "get_state") return { model: { provider: "openai-codex", id: model }, sessionFile: "legacy-session.jsonl" } as T;
        if (type === "prompt") {
          onEvent({ type: "agent_start" });
          onEvent({ type: "message_end", message: { role: "assistant", content: "Legacy worker reply remains visible." } });
          onEvent({ type: "agent_end" });
          return { disposition: "handled" } as T;
        }
        return {} as T;
      },
      async reply() {}, async stop() {},
    }) });
  try {
    const worker = await manager.create({ name: "legacy-worker", model });
    await until(() => manager.read(worker.id).session.status === "idle");
    const scoped = manager.list("adopting-parent");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].ownerSessionId, "adopting-parent");
    await manager.send(worker.id, "continue the old conversation", "steer", undefined, "adopting-parent");
    const transcript = await manager.readTranscript(worker.id, { limit: 100 });
    assert.equal(transcript.session.lastDispatchContext, "continue the old conversation");
    assert.ok(transcript.events.some((event) => event.type === "assistant" && event.text === "Legacy worker reply remains visible."));
    const saved = JSON.parse(await readFile(path.join(root, "saved", "sessions.json"), "utf8"));
    assert.equal(saved.sessions.find((session: SessionInfo) => session.id === worker.id).ownerSessionId, "adopting-parent");

    const transcriptOnly = await manager.create({ name: "legacy-transcript-only", model });
    await until(() => manager.read(transcriptOnly.id).session.status === "idle");
    assert.equal(manager.assertOwner(transcriptOnly.id, "transcript-parent").ownerSessionId, "transcript-parent");
    const directTranscript = await manager.readTranscript(transcriptOnly.id, { limit: 100 });
    assert.ok(directTranscript.events.some((event) => event.type === "ready"));
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("worker owners are immutable across forks and transcript pages stay scoped", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gpt-owner-"));
  const manager = new GptSessionManager({ storageDir: path.join(root, "saved"), cwd: root,
    createTransport: () => ({
      async request<T = any>(type: string): Promise<T> {
        const result = type === "get_state"
          ? { model: { provider: "openai-codex", id: model }, sessionFile: "fixture-session.jsonl" }
          : { disposition: "handled" };
        return result as T;
      },
      async reply() {}, async stop() {},
    }) });
  try {
    const worker = await manager.create({ name: "owner-bound", model, ownerSessionId: "root-session" });
    await until(() => manager.read(worker.id).session.status === "idle");
    assert.deepEqual(manager.list("root-session").map((session) => session.id), [worker.id]);
    assert.deepEqual(manager.list("fork-session"), []);
    assert.equal(manager.assertOwner(worker.id, "root-session").ownerSessionId, "root-session");
    assert.throws(() => manager.assertOwner(worker.id, "fork-session"), /不属于当前会话/);
    await assert.rejects(manager.send(worker.id, "hijack", "steer", undefined, "fork-session"), /不属于当前会话/);
    await assert.rejects(manager.interrupt(worker.id, "fork-session"), /不属于当前会话/);
    await assert.rejects(manager.close(worker.id, false, "fork-session"), /不属于当前会话/);
    const firstPage = await manager.readTranscript(worker.id, { limit: 1 });
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.events[0].type, "ready");
    assert.ok(firstPage.hasMore);
    const older = await manager.readTranscript(worker.id, { before: firstPage.events[0].sequence, limit: 1 });
    assert.equal(older.events[0]?.type, "created");
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("a failed worker startup is reported without blocking create or leaving pending RPC promises", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gpt-failure-"));
  const notices: SessionInfo[] = [];
  const manager = new GptSessionManager({ storageDir: path.join(root, "saved"), cwd: root,
    createTransport: (_spec, onEvent, onExit) => new PiRpcProcess({
      command: process.execPath, args: ["-e", "process.exit(7)"], cwd: root, onEvent, onExit,
    }), onNotice: (session) => notices.push(session) });
  try {
    const session = await manager.create({ name: "failed startup", model, message: "task" });
    assert.equal(session.status, "starting");
    await until(() => manager.read(session.id).session.status === "error");
    assert.match(manager.read(session.id).session.error!, /7/);
    assert.equal(notices.length, 1);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
