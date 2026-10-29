import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { ToolRegistry } from "../extensions/pi-gpt-subagent/registry";
import { subagentToolUi } from "../extensions/pi-gpt-subagent/tool-ui";
import { GptSessionManager } from "../extensions/pi-gpt-subagent/sessions";
import { createSessionTools, type SessionTool } from "../extensions/pi-gpt-subagent/tools";
import type { RpcTransport } from "../extensions/pi-gpt-subagent/rpc";

const model = "subagent-tool-fixture";
const owner = "tool-registry-parent";
type ToolDetails = Record<string, unknown>;

function details(result: Awaited<ReturnType<SessionTool["execute"]>>): ToolDetails {
  assert.ok(result.details && typeof result.details === "object" && !Array.isArray(result.details));
  return result.details as ToolDetails;
}
function findTool(tools: SessionTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("worker did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(root: string) {
  const manager = new GptSessionManager({
    storageDir: path.join(root, "sessions"),
    cwd: root,
    createTransport: (spec, onEvent): RpcTransport => ({
      async request<T = unknown>(type: string, fields?: Record<string, unknown>): Promise<T> {
        if (type === "get_state") return { model: { provider: "openai-codex", id: model } } as T;
        if (type === "prompt") {
          const prompt = typeof fields?.message === "string" ? fields.message : "";
          onEvent({ type: "agent_start" });
          if (prompt.includes("ASK_FOR_INPUT")) {
            onEvent({ type: "extension_ui_request", id: `request-${spec.name}`, method: "input", title: "Need a value", message: "Choose a marker" });
            return { disposition: "accepted" } as T;
          }
          if (prompt.includes("FAIL_WORKER")) {
            onEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "failure-call", args: { command: "exit 1" } });
            onEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "failure-call", isError: true, result: { content: [{ type: "text", text: "fixture command failed" }] } });
            onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Could not finish." }], stopReason: "error", errorMessage: "fixture provider failure" } });
            onEvent({ type: "agent_settled" });
            return { disposition: "accepted" } as T;
          }
          onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Feynman report for ${spec.name}` }] } });
          onEvent({ type: "agent_settled" });
          return { disposition: "accepted" } as T;
        }
        if (type === "abort") return {} as T;
        if (type === "clear_queue") return { steering: [], followUp: [] } as T;
        return {} as T;
      },
      async reply(input) {
        setTimeout(() => {
          onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Answered: ${String(input.value ?? "")}` }] } });
          onEvent({ type: "agent_settled" });
        }, 0);
      },
      async stop() {},
    }),
  });
  const tools = createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, owner);
  return { manager, tools };
}

test("ToolRegistry uses one TypeBox schema for declaration, inferred handler input, and runtime validation", async () => {
  const schema = Type.Object({ count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const registry = new ToolRegistry<{ offset: number }>().register({
    name: "typed_counter",
    description: "Count from a schema-validated integer.",
    parameters: schema,
    ui: subagentToolUi.subagent_dispatch,
    async execute(input, context) { return input.count + context.offset; },
  });
  assert.equal(registry.get("typed_counter").parameters, schema);
  assert.equal(await registry.execute("typed_counter", { count: 2 }, { offset: 3 }), 5);
  await assert.rejects(registry.execute("typed_counter", { count: "2" }, { offset: 3 }), /Invalid arguments/);
  assert.throws(() => registry.register({
    name: "typed_counter", description: "duplicate", parameters: schema,
    ui: subagentToolUi.subagent_dispatch, async execute(input) { return input.count; },
  }), /already registered/);
});

test("the model surface is exactly three active native tools; legacy names remain dormant callable aliases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-surface-"));
  const { manager, tools } = fixture(root);
  try {
    const active = tools.filter((tool) => tool.defaultActive !== false).map((tool) => tool.name).sort();
    assert.deepEqual(active, ["subagent_control", "subagent_dispatch", "subagent_query"]);
    assert.ok(findTool(tools, "gpt_session_send"), "saved transcripts/integrations retain a direct compatibility alias");
    assert.equal(findTool(tools, "gpt_session_send").defaultActive, false);
    assert.equal(typeof findTool(tools, "subagent_dispatch").parameters, "object");
    assert.match(findTool(tools, "subagent_dispatch").description, /no default timeout/i);
    assert.match(findTool(tools, "subagent_dispatch").description, /Do not call wait or query repeatedly/i);
    assert.equal(subagentToolUi.subagent_dispatch.summarizeInput({ task: { name: "scout-a" } }), "派发工兵「scout-a」任务");
    assert.match(subagentToolUi.subagent_dispatch.summarizeResult({ mode: "async", started: [{}] }), /后台派发/);
    assert.equal(manager.list(owner).length, 0);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch supports background batches and synchronous Feynman handoff; query returns one unread brief", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-dispatch-"));
  const { manager, tools } = fixture(root);
  try {
    const dispatch = findTool(tools, "subagent_dispatch");
    const asyncResult = await dispatch.execute("async", { tasks: [
      { name: "scout-a", message: "Map module A", rolePreset: "scout" },
      { name: "scout-b", message: "Map module B", rolePreset: "experimenter" },
    ] });
    const asyncDetails = details(asyncResult);
    assert.equal(asyncDetails.mode, "async");
    assert.equal((asyncDetails.started as unknown[]).length, 2);
    assert.ok((asyncDetails.started as { handle: string }[]).every((item) => item.handle.startsWith("gpt-")));
    assert.ok(manager.list(owner).every((session) => session.status === "idle"));

    const syncResult = await dispatch.execute("sync", {
      task: { name: "sync-worker", message: "Return an evidenced report.", rolePreset: "implementer" },
      mode: "sync",
    });
    const syncDetails = details(syncResult);
    assert.equal(syncDetails.completed, true);
    assert.equal("timedOut" in syncDetails, false);
    const reports = syncDetails.sessions as { name: string; reply?: string; rolePreset?: string }[];
    assert.match(reports[0].reply || "", /Feynman report for sync-worker/);
    assert.equal(reports[0].rolePreset, "implementer");

    const query = findTool(tools, "subagent_query");
    const repeated = await query.execute("query-1", { action: "status", name: "sync-worker" });
    assert.equal(details(repeated).unchanged, true, "sync delivery should not be replayed by a later status query");
    const reread = await query.execute("query-repeat", { action: "status", name: "sync-worker", repeat: true });
    assert.match(String(details(reread).reply), /Feynman report/);
    const list = await query.execute("query-list", { action: "list" });
    assert.equal((details(list).sessions as unknown[]).length, 3);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("synchronous dispatch quietly waits for its current worker turn with no default deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-sync-wait-"));
  let release!: () => void;
  let promptStarted = false;
  let notices = 0;
  const manager = new GptSessionManager({
    storageDir: path.join(root, "sessions"), cwd: root, onNotice: () => { notices++; },
    createTransport: (_spec, onEvent): RpcTransport => ({
      async request<T = unknown>(type: string): Promise<T> {
        if (type === "get_state") return { model: { provider: "openai-codex", id: model } } as T;
        if (type === "prompt") {
          promptStarted = true;
          onEvent({ type: "agent_start" });
          await new Promise<void>((resolve) => {
            release = () => {
              onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished after quiet wait" }] } });
              onEvent({ type: "agent_settled" });
              resolve();
            };
          });
          return { disposition: "accepted" } as T;
        }
        return {} as T;
      }, async reply() {}, async stop() {},
    }),
  });
  const originalWait = manager.wait.bind(manager);
  let observedTimeout: number | undefined = 0;
  manager.wait = (async (...args: Parameters<typeof manager.wait>) => {
    observedTimeout = args[1];
    return originalWait(...args);
  }) as typeof manager.wait;
  try {
    const dispatch = findTool(createSessionTools(async () => ({ manager, resolveModel: () => model }), undefined, owner), "subagent_dispatch");
    let settled = false;
    const resultPromise = dispatch.execute("sync-block", {
      task: { name: "quiet-worker", message: "Finish this turn." }, mode: "sync",
    }).then((result) => { settled = true; return result; });
    await until(() => promptStarted && manager.read("quiet-worker").session.status === "running");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, "sync dispatch must remain blocked until the worker turn finishes");
    assert.equal(observedTimeout, undefined, "omitting timeoutSeconds must pass no wait deadline");
    assert.equal(manager.hasActiveWaiter("quiet-worker"), true);
    assert.equal(notices, 0, "a synchronous handoff must not queue a duplicate parent notification");
    release();
    const result = await resultPromise;
    assert.equal(details(result).completed, true);
    assert.equal(notices, 0);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("query exposes bounded failure diagnostics and control handles respond, abort, and close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-control-"));
  const { manager, tools } = fixture(root);
  try {
    const dispatch = findTool(tools, "subagent_dispatch");
    await dispatch.execute("failed", { task: { name: "failed-worker", message: "FAIL_WORKER" } });
    await until(() => manager.read("failed-worker").session.status === "error");
    const query = findTool(tools, "subagent_query");
    const failed = await query.execute("diagnose", { action: "status", name: "failed-worker" });
    const failureDetails = details(failed);
    const report = failureDetails.diagnostics as { error?: string; failures: { tool?: string; message: string }[] };
    assert.match(report.error || "", /fixture provider failure/);
    assert.equal(report.failures[0].tool, "bash");
    assert.match(report.failures[0].message, /fixture command failed/);

    await dispatch.execute("question", { task: { name: "question-worker", message: "ASK_FOR_INPUT" } });
    await until(() => manager.read("question-worker").session.status === "waiting_input");
    const control = findTool(tools, "subagent_control");
    const answer = await control.execute("answer", { action: "respond", name: "question-worker", value: "approved" });
    assert.equal(details(answer).status, "running");
    await until(() => manager.read("question-worker").session.status === "idle");
    assert.match(manager.read("question-worker").session.lastText, /Answered: approved/);
    const aborted = await control.execute("abort", { action: "abort", name: "question-worker" });
    assert.equal(details(aborted).status, "interrupted");
    const closed = await control.execute("close", { action: "close", name: "question-worker" });
    assert.equal(details(closed).status, "closed");

    const invalid = await findTool(tools, "subagent_dispatch").execute("invalid", { task: { name: "bad", message: "invalid" }, unexpected: true });
    assert.equal(invalid.isError, true);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
