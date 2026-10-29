import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GptSessionManager } from "../extensions/pi-gpt-subagent/sessions";
import { createSessionTools, clipReply, DEFAULT_REPLY_MAX_CHARS } from "../extensions/pi-gpt-subagent/tools";
import type { RpcTransport } from "../extensions/pi-gpt-subagent/rpc";

const model = "wait-fixture";
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("session did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("reply budgets include a context-protection note", () => {
  const clipped = clipReply("x".repeat(DEFAULT_REPLY_MAX_CHARS + 100), DEFAULT_REPLY_MAX_CHARS);
  assert.equal(clipped.length, DEFAULT_REPLY_MAX_CHARS);
  assert.match(clipped, /上下文保护/);
  assert.throws(() => clipReply("reply", 200), /预算必须/);
});

test("GPT tool ownership failures return an error result instead of escaping execute", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-tool-owner-error-"));
  const manager = new GptSessionManager({ storageDir: path.join(directory, "sessions"), cwd: directory,
    createTransport: () => ({
      async request<T = any>(type: string): Promise<T> {
        return (type === "get_state" ? { model: { provider: "openai-codex", id: model } } : { disposition: "handled" }) as T;
      }, async reply() {}, async stop() {},
    }) });
  try {
    const worker = await manager.create({ name: "foreign-worker", model, ownerSessionId: "other-parent" });
    await until(() => manager.read(worker.id).session.status === "idle");
    const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, "current-parent");
    const send = tools.find((tool) => tool.name === "gpt_session_send")!;
    const result = await send.execute("send", { name: worker.name, message: "must stay isolated" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /不属于当前会话/);
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test("gpt_session_send(wait=true) registers its waiter before a fast prompt can notify the parent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-send-wait-race-"));
  let notices = 0;
  let promptSawWaiter = false;
  let manager!: GptSessionManager;
  manager = new GptSessionManager({
    storageDir: path.join(directory, "sessions"), cwd: directory, onNotice: () => { notices++; },
    createTransport: (spec, onEvent): RpcTransport => ({
      async request<T = any>(type: string): Promise<T> {
        let result: any = {};
        if (type === "get_state") result = { model: { provider: "openai-codex", id: model } };
        if (type === "prompt") {
          promptSawWaiter = manager.hasActiveWaiter(spec.id);
          onEvent({ type: "agent_start" });
          onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished immediately" }] } });
          onEvent({ type: "agent_settled" });
          result = { disposition: "accepted" };
        }
        return result as T;
      }, async reply() {}, async stop() {},
    }),
  });
  try {
    const owner = "parent-fixture";
    await manager.create({ name: "fast-worker", model, ownerSessionId: owner });
    await until(() => manager.list().some((session) => session.name === "fast-worker" && session.status === "idle"));
    const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, owner);
    const send = tools.find((tool) => tool.name === "gpt_session_send")!;
    const result = await send.execute("send", { name: "fast-worker", message: "finish immediately", wait: true, timeoutSeconds: 2 });
    const details = result.details as any;
    assert.equal(promptSawWaiter, true, "waitAndReport must claim the session before prompt dispatch begins");
    assert.equal(notices, 0, "a waited reply must not also queue a parent notification");
    assert.equal(details.completed, true);
    assert.equal(details.sessions[0].reply, "finished immediately");
    assert.equal(manager.hasActiveWaiter("fast-worker"), false);
    assert.equal(manager.read("fast-worker").session.lastDeliveredReplySequence, manager.read("fast-worker").session.replySequence);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch GPT tool starts parallel sessions and aggregates replies when wait=all is requested", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-batch-"));
  const manager = new GptSessionManager({ storageDir: path.join(directory, "sessions"), cwd: directory,
    createTransport: (spec, onEvent): RpcTransport => ({
      async request<T = any>(type: string, _fields?: Record<string, unknown>, _timeoutMs?: number): Promise<T> {
        let result: any = {};
        if (type === "get_state") result = { model: { provider: "openai-codex", id: model } };
        if (type === "prompt") {
          onEvent({ type: "agent_start" });
          onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `reply-${spec.name}` }] } });
          onEvent({ type: "agent_settled" });
          result = { disposition: "accepted" };
        }
        return result as T;
      }, async reply() {}, async stop() {},
    }) });
  try {
    const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, "parent-fixture");
    const batch = tools.find((tool) => tool.name === "gpt_session_batch")!;
    const result = await batch.execute("batch", { tasks: [
      { name: "one", rolePreset: "scout", message: "task one" }, { name: "two", rolePreset: "experimenter", message: "task two" },
    ], wait: "all" });
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.match(text, /reply-one/);
    assert.match(text, /reply-two/);
    assert.equal((result.details as any).mode, "all");
    assert.equal((result.details as any).completed, true);
    assert.equal(manager.list().find((session) => session.name === "one")?.rolePreset, "scout");
    assert.equal((result.details as any).sessions.find((session: any) => session.name === "two")?.rolePreset, "experimenter");
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch defaults to non-blocking wait=none and accepts optional role presets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-batch-none-"));
  const manager = new GptSessionManager({ storageDir: path.join(directory, "sessions"), cwd: directory,
    createTransport: () => ({ async request<T = any>(type: string): Promise<T> {
      return (type === "get_state" ? { model: { provider: "openai-codex", id: model } } : {}) as T;
    }, async reply() {}, async stop() {} }) });
  try {
    const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, "parent-fixture");
    const batch = tools.find((tool) => tool.name === "gpt_session_batch")!;
    const result = await batch.execute("batch-none", { tasks: [{ name: "scout", message: "map the code", rolePreset: "scout" }] });
    assert.equal((result.details as any).wait, "none");
    assert.equal(manager.list()[0].role, "探路学者");
    assert.equal(manager.list()[0].rolePreset, "scout");
  } finally { await manager.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test("GPT aggregation joins assistant text segments, removes adjacent duplicates, and all-mode waits for every session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-wait-"));
  const finish = new Map<string, () => void>();
  const manager = new GptSessionManager({
    storageDir: path.join(directory, "sessions"), cwd: directory,
    createTransport: (spec, onEvent): RpcTransport => ({
      async request<T = any>(type: string, _fields?: Record<string, unknown>, _timeoutMs?: number): Promise<T> {
        let result: any = {};
        if (type === "get_state") result = { model: { provider: "openai-codex", id: model }, sessionFile: path.join(directory, `${spec.name}.jsonl`) };
        if (type === "prompt") {
          onEvent({ type: "agent_start" });
          finish.set(spec.name, () => {
            for (const text of spec.name === "aggregate" ? ["Research complete.", "Research complete.", "8 screenshots saved."] : [`${spec.name} finished.`])
              onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
            onEvent({ type: "agent_settled" });
          });
          result = { disposition: "accepted" };
        }
        return result as T;
      },
      async reply() {},
      async stop() {},
    }),
  });
  try {
    await manager.create({ name: "aggregate", model, message: "run" });
    await manager.create({ name: "second", model, message: "run" });
    await until(() => finish.size === 2 && manager.list().every((session) => session.status === "running"));
    assert.equal(manager.cleanupCandidates().length, 0, "running sessions must never be offered for cleanup");
    let resolved = false;
    const all = manager.wait(["aggregate", "second"], 2_000, undefined, "all").then((result) => { resolved = true; return result; });
    finish.get("second")!();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(resolved, false, "all mode must not return on the first completed session");
    finish.get("aggregate")!();
    const result = await all;
    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.session, undefined);
    assert.equal(manager.read("aggregate").session.lastText, "Research complete.\n\n8 screenshots saved.");
    assert.equal(manager.read("aggregate").session.replySequence, manager.read("aggregate").events.find((event) => event.type === "assistant")?.sequence);
    assert.equal(result.sessions.length, 2);
    assert.ok(result.sessions.every((session) => session.status === "idle"));
    assert.equal(manager.cleanupCandidates().length, 2);
    assert.equal((await manager.closeIfIdle("aggregate"))?.status, "closed");
    assert.equal(manager.cleanupCandidates().length, 1);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
