import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  generate,
  validateTranscript,
  validateReasoningEffort,
  exactPayload,
} from "../server/engine";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  defaults,
  fileSchema,
  settingsSchema,
  getReasoningEffort,
  reasoningEfforts,
  runSchema,
  type Message,
} from "../shared/schema";

const message = (
  role: Message["role"],
  content: string,
  enabled = true,
): Message => ({ id: crypto.randomUUID(), role, content, enabled });
test("reasoning effort keeps legacy switch settings and rejects invalid values", () => {
  assert.equal(
    getReasoningEffort(settingsSchema.parse({ ...defaults, reasoning: true })),
    "medium",
  );
  assert.equal(getReasoningEffort(settingsSchema.parse(defaults)), "off");
  assert.equal(
    getReasoningEffort(
      settingsSchema.parse({
        ...defaults,
        reasoning: true,
        reasoningEffort: "off",
      }),
    ),
    "off",
  );
  const imported = fileSchema.parse({
    version: 1,
    title: "effort",
    settings: { ...defaults, reasoningEffort: "xhigh" },
    messages: [],
  });
  assert.equal(getReasoningEffort(imported.settings), "xhigh");
  assert.equal(
    settingsSchema.safeParse({ ...defaults, reasoningEffort: "turbo" }).success,
    false,
  );
});
test("unsupported catalog efforts fail explicitly instead of silently clamping", () => {
  const model = {
    id: "catalog-model",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  } as Model<Api>;
  assert.throws(() => validateReasoningEffort(defaults, model), /不支持.*off/);
  assert.throws(
    () =>
      validateReasoningEffort({ ...defaults, reasoningEffort: "max" }, model),
    /不支持.*max/,
  );
  assert.equal(
    validateReasoningEffort({ ...defaults, reasoningEffort: "xhigh" }, model),
    "xhigh",
  );
  assert.equal(
    validateReasoningEffort({ ...defaults, reasoningEffort: "minimal" }, model),
    "minimal",
  );
});
async function mockServer(
  handler: (
    body: Record<string, any>,
    res: import("node:http").ServerResponse,
    url: string,
  ) => void,
) {
  const server = createServer(async (req, res) => {
    let content = "";
    for await (const chunk of req) content += chunk;
    try {
      handler(JSON.parse(content), res, req.url || "");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
function completion(res: import("node:http").ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "hello " },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 },
    },
  ])
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1-mini", ...chunk })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}
test("every custom OpenAI effort reaches the wire and reasoning omits temperature", async () => {
  let sent: any;
  const mock = await mockServer((body, res) => {
    sent = body;
    completion(res);
  });
  try {
    for (const effort of reasoningEfforts) {
      const events: Record<string, any>[] = [];
      await generate(
        {
          settings: {
            ...defaults,
            baseUrl: mock.baseUrl,
            model: "custom-reasoning-model",
            reasoningEffort: effort,
          },
          messages: [message("user", "hi")],
        },
        (e) => events.push(e),
      );
      assert.equal(
        events.some((e) => e.type === "error"),
        false,
        JSON.stringify(events),
      );
      assert.equal(
        sent.reasoning_effort,
        effort === "off" ? undefined : effort,
      );
      assert.equal(
        sent.temperature,
        effort === "off" ? defaults.temperature : undefined,
      );
    }
  } finally {
    await mock.close();
  }
});
test("Pi sends exact role order, filters disabled messages, streams output and reports usage", async () => {
  let sent: Record<string, any> = {};
  const mock = await mockServer((body, res, url) => {
    sent = body;
    assert.equal(url, "/v1/chat/completions");
    completion(res);
  });
  try {
    const messages = [
      message("system", "system A"),
      message("user", "old"),
      message("developer", "edited developer"),
      message("assistant", "manual answer"),
      message("user", "excluded", false),
      message("system", "mid-conversation system"),
      message("user", "new"),
    ];
    const events: Record<string, any>[] = [];
    await generate(
      { settings: { ...defaults, baseUrl: mock.baseUrl }, messages },
      (e) => events.push(e),
    );
    assert.deepEqual(
      sent.messages,
      messages
        .filter((m) => m.enabled)
        .map(({ role, content }) => ({ role, content })),
    );
    assert.equal(sent.temperature, 0.7);
    assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 2048);
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
      "hello world",
    );
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(events.find((e) => e.type === "request")?.payload),
      ),
      sent,
    );
    assert.deepEqual(events.find((e) => e.type === "done")?.usage, {
      input: 17,
      output: 2,
    });
    assert.equal(
      events.some((e) => e.type === "error"),
      false,
    );
  } finally {
    await mock.close();
  }
});
test("assistant-only transcript runs without injecting a hidden user message", async () => {
  let sent: any;
  const mock = await mockServer((body, res) => {
    sent = body;
    completion(res);
  });
  try {
    await generate(
      {
        settings: { ...defaults, baseUrl: mock.baseUrl },
        messages: [message("assistant", "prefilled")],
      },
      () => {},
    );
    assert.deepEqual(sent.messages, [
      { role: "assistant", content: "prefilled" },
    ]);
  } finally {
    await mock.close();
  }
});
test("provider failures are surfaced as errors, not a successful empty output", async () => {
  const mock = await mockServer((_body, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "test invalid key", type: "authentication_error" },
      }),
    );
  });
  try {
    const events: any[] = [];
    await generate(
      {
        settings: { ...defaults, baseUrl: mock.baseUrl },
        messages: [message("user", "hi")],
      },
      (e) => events.push(e),
    );
    assert.equal(
      events.some((e) => e.type === "done"),
      false,
    );
    assert.match(
      events.find((e) => e.type === "error").message,
      /401|invalid key/,
    );
  } finally {
    await mock.close();
  }
});
test("Responses preserves developer and interleaved system instructions without injected instructions", () => {
  const settings = { ...defaults, protocol: "openai-responses" as const };
  const messages = [
    message("developer", "rule"),
    message("user", "question"),
    message("system", "later"),
  ];
  const payload = exactPayload(
    { instructions: "old", input: [], stream: true },
    settings,
    messages,
  );
  assert.equal("instructions" in payload, false);
  assert.deepEqual(
    payload.input,
    messages.map(({ role, content }) => ({ type: "message", role, content })),
  );
});
test("Anthropic rejects unsupported role placement instead of silently changing meaning", () => {
  const settings = { ...defaults, protocol: "anthropic-messages" as const };
  assert.throws(
    () => validateTranscript(settings, [message("developer", "test")]),
    /developer/,
  );
  assert.throws(
    () =>
      validateTranscript(settings, [
        message("user", "hi"),
        message("system", "late"),
      ]),
    /开头/,
  );
  assert.doesNotThrow(() =>
    validateTranscript(settings, [
      message("system", "rule"),
      message("user", "hi"),
    ]),
  );
});
test("empty contexts and invalid parameters are rejected, exported schema excludes secrets", () => {
  assert.throws(() =>
    validateTranscript(defaults, [message("user", "", false)]),
  );
  assert.equal(
    runSchema.safeParse({
      settings: { ...defaults, maxTokens: -1 },
      messages: [message("user", "hi")],
    }).success,
    false,
  );
  assert.equal(
    runSchema.safeParse({
      settings: { ...defaults, baseUrl: "file:///etc/passwd" },
      messages: [message("user", "hi")],
    }).success,
    false,
  );
  const imported = fileSchema.parse({
    version: 1,
    title: "test",
    settings: { ...defaults, apiKey: "secret" },
    messages: [],
  });
  assert.equal("apiKey" in imported.settings, false);
});
test("Responses transport streams a real SSE response and preserves developer role on the wire", async () => {
  let sent: any;
  const mock = await mockServer((body, res, url) => {
    sent = body;
    assert.equal(url, "/v1/responses");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const response = {
      id: "resp-test",
      status: "completed",
      model: "gpt-4.1-mini",
      output: [
        {
          type: "message",
          id: "msg-test",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "response ok", annotations: [] },
          ],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg-test",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "response ok",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: response.output[0],
      },
      { type: "response.completed", response },
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    const events: any[] = [];
    await generate(
      {
        settings: {
          ...defaults,
          protocol: "openai-responses",
          baseUrl: mock.baseUrl,
          reasoningEffort: "xhigh",
        },
        messages: [message("developer", "rule"), message("user", "hi")],
      },
      (e) => events.push(e),
    );
    assert.equal(sent.reasoning.effort, "xhigh");
    assert.equal(sent.temperature, undefined);
    assert.deepEqual(sent.input, [
      { type: "message", role: "developer", content: "rule" },
      { type: "message", role: "user", content: "hi" },
    ]);
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
      "response ok",
    );
    assert.equal(
      events.some((e) => e.type === "done"),
      true,
      JSON.stringify(events),
    );
  } finally {
    await mock.close();
  }
});
test("Anthropic transport retains leading system blocks and streams output", async () => {
  let sent: any;
  const mock = await mockServer((body, res, url) => {
    sent = body;
    assert.equal(url.split("?")[0], "/v1/messages");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "anthropic ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    const events: any[] = [];
    await generate(
      {
        settings: {
          ...defaults,
          protocol: "anthropic-messages",
          model: "claude-test",
          baseUrl: mock.baseUrl.replace("/v1", ""),
        },
        messages: [message("system", "rule"), message("user", "hi")],
      },
      (e) => events.push(e),
    );
    assert.deepEqual(sent.system, [{ type: "text", text: "rule" }]);
    assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
      "anthropic ok",
      JSON.stringify(events),
    );
    assert.equal(
      events.some((e) => e.type === "done"),
      true,
      JSON.stringify(events),
    );
  } finally {
    await mock.close();
  }
});
test("cancel aborts an active upstream stream and retains partial text", async () => {
  const mock = await mockServer((_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "gpt-4.1-mini", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
    );
  });
  try {
    const abort = new AbortController();
    const events: any[] = [];
    await generate(
      {
        settings: { ...defaults, baseUrl: mock.baseUrl },
        messages: [message("user", "hi")],
      },
      (e) => {
        events.push(e);
        if (e.type === "text") abort.abort();
      },
      abort.signal,
    );
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
      "partial",
    );
    assert.equal(
      events.some((e) => e.type === "done"),
      false,
    );
    assert.equal(
      events.some((e) => e.type === "error"),
      true,
    );
  } finally {
    await mock.close();
  }
});
test("Pi subscription maps leading system to instructions and retains developer/user/assistant order", () => {
  const settings = { ...defaults, protocol: "pi-subscription" as const };
  const messages = [
    message("system", "first"),
    message("system", "second"),
    message("developer", "rule"),
    message("user", "edited"),
    message("assistant", "manual history"),
    message("user", "continue"),
  ];
  validateTranscript(settings, messages);
  const payload = exactPayload(
    { instructions: "hidden default", input: [], stream: true },
    settings,
    messages,
  );
  assert.equal(payload.instructions, "first\n\nsecond");
  assert.deepEqual(
    payload.input,
    messages
      .slice(2)
      .map(({ role, content }) => ({ type: "message", role, content })),
  );
  assert.throws(
    () =>
      validateTranscript(settings, [
        message("user", "hi"),
        message("system", "late"),
      ]),
    /instructions/,
  );
  assert.throws(
    () => validateTranscript(settings, [message("system", "only")]),
    /至少需要/,
  );
});
test("Pi subscription without system instructions does not introduce a hidden prompt", () => {
  const settings = { ...defaults, protocol: "pi-subscription" as const };
  const payload = exactPayload(
    { instructions: "You are a helpful assistant." },
    settings,
    [message("user", "hi")],
  );
  assert.equal(payload.instructions, "");
});
