import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { isTransportFailure, isTransientServerFailure, withStreamRetry, type StreamRetryInfo } from "../server/stream-retry";

const model = {
  id: "claude-test",
  name: "claude-test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.test",
} as unknown as Model<Api>;

const context = { messages: [] } as unknown as Parameters<StreamFn>[1];

function assistantMessage(text: string, failure?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: failure ? "error" : "stop",
    ...(failure ? { errorMessage: failure } : {}),
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** One scripted attempt: emit `before` text, then either fail or finish. */
function attempt(before: string, failure: string | undefined, after = ""): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const partial = assistantMessage("");
    stream.push({ type: "start", partial });
    if (before) stream.push({ type: "text_delta", contentIndex: 0, delta: before, partial });
    if (failure) {
      const error = assistantMessage(before, failure);
      stream.push({ type: "error", reason: "error", error });
    } else {
      const message = assistantMessage(before + after);
      if (after) stream.push({ type: "text_delta", contentIndex: 0, delta: after, partial });
      stream.push({ type: "done", reason: "stop", message });
    }
    stream.end();
  })();
  return stream;
}

/** Each entry scripts one attempt; the last one repeats for further retries. */
function scripted(attempts: Array<() => AssistantMessageEventStream>) {
  let calls = 0;
  const inner: StreamFn = () => attempts[Math.min(calls++, attempts.length - 1)]();
  return { inner, calls: () => calls };
}

async function drain(stream: ReturnType<StreamFn>) {
  const resolved = await stream;
  const events: string[] = [];
  let text = "";
  for await (const event of resolved) {
    events.push(event.type);
    if (event.type === "text_delta") text += event.delta;
  }
  return { events, text, result: await resolved.result() };
}

const immediately = () => 0;
const immediatelyFn = (_attempt: number, _isServer: boolean) => 0;

test("transport failures are classified apart from provider errors", () => {
  for (const message of [
    "terminated",
    "fetch failed",
    "other side closed",
    "Connection error.",
    "Anthropic stream ended before message_stop",
    "read ECONNRESET",
  ])
    assert.equal(isTransportFailure(message), true, message);
  for (const message of [undefined, "", "Invalid API key", "overloaded_error", "500 Internal Server Error"])
    assert.equal(isTransportFailure(message), false, String(message));
});

test("transient server failures are classified by status code and known error strings", () => {
  for (const message of [
    "500 Internal Server Error: upstream model failed",
    "500 Internal Server Error: upstream_error (overloaded_error)",
    "502 Bad Gateway: timeout",
    "503 Service Unavailable: retry later",
    "504 Gateway Timeout: upstream timed out",
    "429 Too Many Requests: rate limit exceeded",
    "overloaded_error: the model is currently overloaded",
    "upstream request failed",
    "Service unavailable, please try again",
    "model unavailable",
  ])
    assert.equal(isTransientServerFailure(message), true, message);
  for (const message of [undefined, "", "Invalid API key", "400 Bad Request: bad schema", "404 Not Found", "terminated"])
    assert.equal(isTransientServerFailure(message), false, String(message));
});

test("a stream cut before the first token is resent transparently", async () => {
  const retries: StreamRetryInfo[] = [];
  const { inner, calls } = scripted([() => attempt("", "terminated"), () => attempt("", undefined, "完整回答")]);
  const stream = withStreamRetry(inner, { delayMs: immediatelyFn, onRetry: (info) => retries.push(info) })(model, context, {});
  const { events, text, result } = await drain(stream);
  assert.equal(calls(), 2);
  assert.equal(text, "完整回答");
  assert.equal(result.stopReason, "stop");
  assert.equal(events.filter((type) => type === "start").length, 1);
  assert.deepEqual(retries.map((info) => info.hadContent), [false]);
});

test("a stream cut mid-answer is resent without a second start event", async () => {
  const retries: StreamRetryInfo[] = [];
  const { inner } = scripted([() => attempt("半句", "terminated"), () => attempt("", undefined, "完整回答")]);
  const stream = withStreamRetry(inner, { delayMs: immediatelyFn, onRetry: (info) => retries.push(info) })(model, context, {});
  const { events, text, result } = await drain(stream);
  assert.equal(events.filter((type) => type === "start").length, 1);
  assert.equal(events.includes("error"), false);
  // The consumer is told to drop what it rendered, so only the resent text counts.
  assert.deepEqual(retries.map((info) => info.hadContent), [true]);
  assert.equal(text, "半句完整回答");
  assert.equal(result.content.map((block) => (block.type === "text" ? block.text : "")).join(""), "完整回答");
});

test("provider errors are surfaced unchanged without a retry", async () => {
  let retried = false;
  const { inner, calls } = scripted([() => attempt("", "Invalid API key")]);
  const stream = withStreamRetry(inner, { delayMs: immediatelyFn, onRetry: () => { retried = true; } })(model, context, {});
  const { events, result } = await drain(stream);
  assert.equal(calls(), 1);
  assert.equal(retried, false);
  assert.equal(events.at(-1), "error");
  assert.equal(result.errorMessage, "Invalid API key");
});

test("the retry budget is finite and the last failure is reported", async () => {
  const retries: StreamRetryInfo[] = [];
  const { inner, calls } = scripted([() => attempt("", "terminated")]);
  const stream = withStreamRetry(inner, { attempts: 3, delayMs: immediatelyFn, onRetry: (info) => retries.push(info) })(model, context, {});
  const { result } = await drain(stream);
  assert.equal(calls(), 3);
  assert.deepEqual(retries.map((info) => info.attempt), [1, 2]);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "terminated");
});

test("an aborted run is not resent", async () => {
  const controller = new AbortController();
  const { inner, calls } = scripted([() => attempt("", "terminated")]);
  const stream = withStreamRetry(inner, { delayMs: immediatelyFn })(model, context, { signal: controller.signal });
  controller.abort();
  const { result } = await drain(stream);
  assert.equal(calls(), 1);
  assert.equal(result.errorMessage, "terminated");
});

test("a stream function that throws still terminates the turn", async () => {
  const inner: StreamFn = () => { throw new Error("fetch failed"); };
  const stream = withStreamRetry(inner, { attempts: 2, delayMs: immediatelyFn })(model, context, {});
  const { events, result } = await drain(stream);
  assert.equal(events.at(-1), "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /fetch failed/);
});

test("Antigravity 500 error is retried with isServer=true reported to delayMs", async () => {
  const serverError = "500 Internal Server Error: upstream model failed (overloaded_error)";
  const isServerFlags: boolean[] = [];
  const { inner, calls } = scripted([
    () => attempt("", serverError),
    () => attempt("", undefined, "答案已生成"),
  ]);
  const stream = withStreamRetry(inner, {
    delayMs: (_attempt, isServer) => { isServerFlags.push(isServer); return 0; },
  })(model, context, {});
  const { text, result } = await drain(stream);
  assert.equal(calls(), 2);
  assert.equal(text, "答案已生成");
  assert.equal(result.stopReason, "stop");
  // Delay was called once for the first failed attempt, with isServer=true.
  assert.deepEqual(isServerFlags, [true]);
});

test("deterministic provider errors like 400 are not retried", async () => {
  let retried = false;
  const { inner, calls } = scripted([() => attempt("", "400 Bad Request: invalid schema")]);
  const stream = withStreamRetry(inner, { delayMs: immediatelyFn, onRetry: () => { retried = true; } })(model, context, {});
  const { result } = await drain(stream);
  assert.equal(calls(), 1);
  assert.equal(retried, false);
  assert.equal(result.stopReason, "error");
});
