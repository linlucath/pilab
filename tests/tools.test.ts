import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generate, validateTranscript, exactPayload } from "../server/engine";
import { defaults, fileSchema, runStreamEventSchema, settingsSchema, type Message } from "../shared/schema";

const user: Message = {
  id: "user",
  role: "user",
  content: "Complete the fixture task.",
  enabled: true,
};
function reply(
  res: ServerResponse,
  call?: { name: string; arguments: object; id?: string },
) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunks = call
    ? [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.id || "call_test",
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: JSON.stringify(call.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
        { delta: {}, finish_reason: "tool_calls" },
      ]
    : [
        {
          delta: { role: "assistant", content: "AGENT_COMPLETE" },
          finish_reason: "stop",
        },
      ];
  for (const chunk of chunks)
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1-mini", choices: [{ index: 0, ...chunk }], ...(chunk.finish_reason ? { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } : {}) })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}
async function provider(handler: (body: any, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    try {
      handler(JSON.parse(text), res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
test("context_compact streams a UI event and feeds dehydrated summaries back into later model requests", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-context-compact-"));
  const sent: any[] = [];
  const mock = await provider((body, res) => {
    sent.push(body);
    if (sent.length === 1) reply(res, { id: "call_compact", name: "context_compact", arguments: {
      toolCallIds: ["call_prior|0"], modelSummary: "Reviewed five sources; the latest release adds export and search support.",
    } });
    else reply(res);
  });
  const longTask = `Review the full release notes and compare every section. ${"Detailed instructions. ".repeat(160)}`;
  const messages: Message[] = [user, {
    id: "prior-call", role: "assistant", content: "", enabled: true,
    toolCalls: [{ id: "call_prior|0", name: "gpt_session_send", arguments: JSON.stringify({ name: "research", message: longTask, mode: "steer" }) }],
  }, {
    id: "prior-result", role: "tool", content: "Raw research output. ".repeat(500), enabled: true,
    toolCallId: "call_prior", toolName: "gpt_session_send",
  }];
  try {
    const events: Record<string, any>[] = [];
    await generate({ settings: { ...defaults, baseUrl: mock.baseUrl, toolMode: "agent", workingDirectory: cwd }, messages }, (event) => events.push(event));
    assert.equal(sent.length, 2);
    const before = sent[0].messages.find((item: any) => item.role === "assistant" && item.tool_calls?.some((call: any) => call.id === "call_prior"));
    const after = sent[1].messages.find((item: any) => item.role === "assistant" && item.tool_calls?.some((call: any) => call.id === "call_prior"));
    const result = sent[1].messages.find((item: any) => item.role === "tool" && item.tool_call_id === "call_prior");
    assert.match(JSON.parse(before.tool_calls[0].function.arguments).message, /Detailed instructions/);
    assert.match(JSON.parse(after.tool_calls[0].function.arguments).message, /任务摘要/);
    assert.ok(JSON.parse(after.tool_calls[0].function.arguments).message.length < longTask.length);
    assert.match(result.content, /^\[已脱水归档\] Reviewed five sources/);
    assert.ok(events.some((event) => event.type === "context_compacted" && event.messageIds.includes("prior-call") && event.messageIds.includes("prior-result")));
    assert.ok(events.some((event) => event.type === "context_compacted" && event.toolCallIds.some((id: string) => id.split("|")[0] === "call_prior")));
    assert.equal(messages[2].content.startsWith("Raw research output."), true);
  } finally {
    await mock.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Agent exposes GPT and image tools, feeds tool results back, and replays edited history", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-tools-"));
  const sent: any[] = [];
  const mock = await provider((body, res) => {
    sent.push(body);
    if (sent.length === 1)
      reply(res, { id: "call_list", name: "subagent_query", arguments: { action: "list" } });
    else reply(res);
  });
  try {
    const events: Record<string, any>[] = [];
    await generate(
      {
        settings: {
          ...defaults,
          baseUrl: mock.baseUrl,
          toolMode: "agent",
          workingDirectory: cwd,
        },
        messages: [{ id: "system", role: "system", content: "Original system text.", enabled: true }, user],
      },
      (e) => events.push(e),
    );
    assert.equal(
      events.some((e) => e.type === "error"),
      false,
      JSON.stringify(events),
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].tools.map((t: any) => t.function.name).sort(), [
      "context_compact",
      "list_images",
      "session_fork",
      "subagent_control",
      "subagent_dispatch",
      "subagent_query",
      "view_images",
    ]);
    assert.equal(sent[0].messages[0].content, "Original system text.");
    assert.equal(sent[1].messages[2].tool_calls[0].function.name, "subagent_query");
    assert.equal(sent[1].messages[3].role, "tool");
    assert.equal(sent[1].messages[3].tool_call_id, "call_list");
    assert.equal(sent[1].messages.filter((m: any) => m.role === "user").length, 1);
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.deepEqual(events.find((e) => e.type === "done")?.usage, {
      input: 14,
      output: 6,
    });
    assert.equal(events.find((e) => e.type === "done")?.turns, 2);
    const trace = new Map<string, Message>();
    for (const e of events)
      if (e.type === "assistant" || e.type === "message")
        trace.set(e.message.id, e.message);
    assert.equal(
      [...trace.values()].filter((m) => m.role === "tool").length,
      1,
    );
    const messages = [user, ...trace.values()];
    messages.find((m) => m.role === "tool" && m.toolName === "subagent_query")!.content =
      "edited tool result";
    const imported = fileSchema.parse({
      version: 1,
      title: "replay",
      settings: defaults,
      messages,
    });
    const replay: Record<string, any>[] = [];
    await generate(
      {
        settings: { ...defaults, baseUrl: mock.baseUrl },
        messages: imported.messages,
      },
      (e) => replay.push(e),
    );
    assert.equal(
      replay.some((e) => e.type === "error"),
      false,
      JSON.stringify(replay),
    );
    assert.ok(
      sent
        .at(-1)
        .messages.some(
          (m: any) => m.role === "tool" && m.content === "edited tool result",
        ),
    );
  } finally {
    mock.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("Agent is the default and exposes the full tool set", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-agent-default-"));
  const sent: any[] = [];
  const mock = await provider((body, res) => {
    sent.push(body);
    if (sent.length === 1)
      reply(res, { name: "subagent_query", arguments: { action: "list" } });
    else reply(res);
  });
  try {
    assert.equal(defaults.toolMode, "agent");
    assert.equal(settingsSchema.parse({ ...defaults, toolMode: undefined }).toolMode, "agent");
    const events: Record<string, any>[] = [];
    await generate(
      { settings: { ...defaults, baseUrl: mock.baseUrl, workingDirectory: cwd }, messages: [user] },
      (event) => events.push(event),
    );
    const names = sent[0].tools.map((tool: any) => tool.function.name).sort();
    assert.deepEqual(names, [
      "context_compact",
      "list_images",
      "session_fork",
      "subagent_control",
      "subagent_dispatch",
      "subagent_query",
      "view_images",
    ]);
    assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events));
    assert.equal(sent.length, 2);
    assert.equal(events.at(-1)?.type, "done");
  } finally {
    mock.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("session_fork broadcasts the complete nested fork payload", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-fork-event-"));
  const sent: any[] = [];
  const mock = await provider((body, res) => {
    sent.push(body);
    if (sent.length === 1)
      reply(res, { name: "session_fork", arguments: { title: "Audit branch", distilledMemory: "Keep the validated findings." } });
    else reply(res);
  });
  try {
    const events: Record<string, any>[] = [];
    await generate(
      { settings: { ...defaults, baseUrl: mock.baseUrl, workingDirectory: cwd }, messages: [user] },
      (event) => events.push(event),
    );
    const event = events.find((item) => item.type === "session_forked");
    assert.ok(event);
    assert.doesNotThrow(() => runStreamEventSchema.parse(event));
    assert.equal(event.fork.title, "Audit branch");
    assert.equal(event.fork.forkSummary, "Keep the validated findings.");
    assert.equal(event.fork.keepRecentTurns, 0);
    assert.equal(event.fork.messages.length, 1);
    assert.match(event.fork.messages[0].content, /Keep the validated findings/);
  } finally {
    mock.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("turn limit stops after a completed tool batch and leaves resumable history", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-limit-"));
  await writeFile(path.join(cwd, "seed.txt"), "seed");
  let count = 0;
  const mock = await provider((_body, res) => {
    count++;
    reply(res, { name: "read", arguments: { path: "seed.txt" } });
  });
  try {
    const events: Record<string, any>[] = [];
    await generate(
      {
        settings: {
          ...defaults,
          baseUrl: mock.baseUrl,
          toolMode: "agent",
          workingDirectory: cwd,
          maxTurns: 1,
        },
        messages: [user],
      },
      (e) => events.push(e),
    );
    assert.equal(count, 1);
    assert.equal(events.at(-1)?.reason, "turn_limit");
    const trace = new Map<string, Message>();
    for (const e of events)
      if (e.type === "assistant" || e.type === "message")
        trace.set(e.message.id, e.message);
    assert.doesNotThrow(() =>
      validateTranscript(defaults, [user, ...trace.values()]),
    );
  } finally {
    mock.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("stop aborts an active model stream without a successful done event", async () => {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mock = await provider((_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1-mini", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`);
  });
  const started = Date.now();
  try {
    const events: Record<string, any>[] = [];
    await generate(
      {
        settings: { ...defaults, baseUrl: mock.baseUrl, toolMode: "agent" },
        messages: [user],
      },
      (e) => {
        events.push(e);
        if (e.type === "text")
          timer ??= setTimeout(() => abort.abort(), 150);
      },
      abort.signal,
    );
    assert.ok(Date.now() - started < 5000);
    assert.equal(
      events.some((e) => e.type === "done"),
      false,
    );
    assert.equal(events.some((e) => e.type === "text" && e.delta === "partial"), true);
    assert.equal(events.some((e) => e.type === "message" && e.message.role === "tool"), false);
  } finally {
    if (timer) clearTimeout(timer);
    mock.close();
  }
});
test("tool history validates pairs, excluded results, duplicate ids, and JSON arguments", () => {
  const call: Message = {
    id: "a",
    role: "assistant",
    content: "",
    enabled: true,
    toolCalls: [
      { id: "call_a|fc_a", name: "read", arguments: '{"path":"seed.txt"}' },
    ],
  };
  const result: Message = {
    id: "t",
    role: "tool",
    content: "seed",
    enabled: true,
    toolCallId: "call_a|fc_a",
    toolName: "read",
  };
  assert.doesNotThrow(() => validateTranscript(defaults, [call, result]));
  assert.throws(
    () => validateTranscript(defaults, [call, { ...result, enabled: false }]),
    /添加工具结果/,
  );
  assert.throws(() => validateTranscript(defaults, [result]), /对应的调用/);
  assert.throws(
    () => validateTranscript(defaults, [call, user, result]),
    /补齐/,
  );
  assert.throws(
    () => validateTranscript(defaults, [call, result, call, result]),
    /重复/,
  );
  assert.throws(
    () =>
      validateTranscript(defaults, [
        { ...call, toolCalls: [{ ...call.toolCalls![0], arguments: "[1]" }] },
        result,
      ]),
    /JSON 对象/,
  );
});
test("Responses and Anthropic preserve native tool pairs and signed reasoning", () => {
  const call: Message = {
    id: "a",
    role: "assistant",
    enabled: true,
    content: "",
    toolCalls: [
      { id: "call_a|fc_a", name: "read", arguments: '{"path":"seed.txt"}' },
    ],
    providerState: {
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "test",
      thinking: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_test",
            encrypted_content: "opaque",
            summary: [],
          }),
        },
      ],
    },
  };
  const result: Message = {
    id: "t",
    role: "tool",
    enabled: true,
    content: "edited result",
    toolCallId: "call_a|fc_a",
    toolName: "read",
    isError: true,
  };
  const responses = exactPayload(
    {},
    { ...defaults, protocol: "pi-subscription", model: "test" },
    [call, result],
  );
  const input = responses.input as any[];
  assert.equal(input[0].encrypted_content, "opaque");
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_a",
    id: "fc_a",
    name: "read",
    arguments: '{"path":"seed.txt"}',
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_a",
    output: "edited result",
  });
  const switched = exactPayload(
    {},
    { ...defaults, protocol: "pi-subscription", model: "other" },
    [call, result],
  ).input as any[];
  assert.equal(switched.length, 2);
  assert.equal(switched[0].id, undefined);
  const anthropic = exactPayload(
    {},
    { ...defaults, protocol: "anthropic-messages" },
    [call, result],
  ).messages as any[];
  assert.equal(anthropic[0].content[0].type, "tool_use");
  assert.equal(anthropic[0].content[0].id, "call_a");
  assert.equal(anthropic[1].content[0].type, "tool_result");
  assert.equal(anthropic[1].content[0].is_error, true);
});
