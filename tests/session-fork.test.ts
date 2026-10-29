import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildForkMessages } from "../shared/session-fork";
import { defaults, runStreamEventSchema, type Message } from "../shared/schema";
import { savedSessionSchema, experimentSessionSchema } from "../shared/workspace";
import { agentTools } from "../server/tools";

const message = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, content, enabled: true, ...extra });

test("distilled forks keep leading instructions and a bounded clean tail, not tool history", () => {
  const source = [
    message("system", "system", "Persistent persona"),
    message("developer", "developer", "Rules"),
    message("u1", "user", "Old question"),
    message("a1", "assistant", "Old answer"),
    message("call", "assistant", "", { toolCalls: [{ id: "call-1", name: "bash", arguments: "{}" }] }),
    message("result", "tool", "private tool output", { toolCallId: "call-1", toolName: "bash" }),
    message("u2", "user", "Latest question"),
    message("a2", "assistant", "Latest answer", { providerState: { api: "fixture", provider: "fixture", model: "fixture", thinking: [] } }),
  ];
  let sequence = 0;
  const fork = buildForkMessages({ messages: source, distilledMemory: "Goals, constraints and open questions", keepRecentTurns: 1, id: () => `fork-${++sequence}` });
  assert.deepEqual(fork.map((item) => item.role), ["system", "developer", "system", "user", "assistant"]);
  assert.match(fork[2].content, /Goals, constraints and open questions/);
  assert.deepEqual(fork.slice(-2).map((item) => item.content), ["Latest question", "Latest answer"]);
  assert.ok(fork.every((item) => !item.toolCalls && !item.toolCallId));
  assert.equal(fork.at(-1)?.providerState, undefined);
  assert.equal(new Set(fork.map((item) => item.id)).size, fork.length);
  assert.equal(buildForkMessages({ messages: source, distilledMemory: "memory", keepRecentTurns: 0, id: () => `empty-${++sequence}` }).length, 3);
});

test("fork lineage survives experiment/session schemas", () => {
  const values = { id: "fork", title: "new", settings: { ...defaults, apiKey: undefined }, messages: [message("one", "user", "hello")], parentSessionId: "parent", parentSessionTitle: "old", forkSummary: "distilled" };
  assert.equal(savedSessionSchema.parse(values).parentSessionTitle, "old");
  assert.equal(experimentSessionSchema.parse(values).forkSummary, "distilled");
});

test("session_fork emits a validated UI handoff with a complete fork", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilab-session-fork-"));
  try {
    const events: Record<string, unknown>[] = [];
    const { tools } = await agentTools({ ...defaults, workingDirectory: cwd }, () => [], (event) => events.push(event));
    const tool = tools.find((entry) => entry.name === "session_fork");
    assert.ok(tool);
    const result = await tool.execute("fork-1", { title: "Audit branch", distilledMemory: "Keep the user's constraints and pending review.", keepRecentTurns: 1 });
    assert.equal((result.details as any).title, "Audit branch");
    const event = events[0] as any;
    assert.equal(event.type, "session_forked");
    assert.doesNotThrow(() => runStreamEventSchema.parse(event));
    assert.match(event.fork.id, /^[a-f0-9-]{36}$/);
    assert.equal(event.fork.title, "Audit branch");
    assert.equal(event.fork.forkSummary, "Keep the user's constraints and pending review.");
    assert.equal(event.fork.keepRecentTurns, 1);
    assert.match(event.fork.messages[0].content, /Keep the user's constraints/);
    const cleanResult = await tool.execute("fork-clean", { title: "Clean", distilledMemory: "Only the distilled core." });
    assert.equal((cleanResult.details as any).keepRecentTurns, 0);
    assert.equal((events[1] as any).fork.messages.length, 1, "default fork contains only memory when there are no leading instructions");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
