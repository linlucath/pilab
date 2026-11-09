import type { AssistantMessage, AssistantMessageEvent, Api, Model } from "@earendil-works/pi-ai";
// The package index re-exports the class as a type only; take it from its module.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { transportFailurePattern } from "./network";

/**
 * A cut SSE body ends the whole agent turn: the provider module turns the
 * transport error into an `error` event, and the agent loop stops there. The
 * request itself is pure generation — no tool has run yet — so resending it is
 * free of side effects.
 */
export function isTransportFailure(message: string | undefined): boolean {
  if (!message) return false;
  return (
    transportFailurePattern.test(message) ||
    // Provider wrappers that flatten the cause into their own wording.
    /Connection error|network error|stream ended before message_stop/i.test(message)
  );
}

/**
 * Transient server-side failures that the upstream may recover from on a
 * re-request. pi-messages formats HTTP errors as "STATUS StatusText: body",
 * so the status code is at the start of the message string.
 */
export function isTransientServerFailure(message: string | undefined): boolean {
  if (!message) return false;
  // HTTP 429 and 5xx responses from the pi-messages bridge. Excludes 400/401/403/404
  // which are deterministic — a retry would produce the same error.
  if (/^(429|5[0-9]{2})\s/.test(message)) return true;
  // Upstream model/runtime errors forwarded through the SSE stream itself
  // (e.g., "overloaded_error" from Gemini, "upstream_error" from the bridge).
  return /overloaded|upstream.{0,20}fail|service.unavailable|model.unavailable|temporarily.unavailable|internal.error/i.test(message);
}

function isRetryable(message: string | undefined): boolean {
  return isTransportFailure(message) || isTransientServerFailure(message);
}

/** Longer backoff for server errors: the backend needs some recovery time. */
const serverErrorDelayMs = (attempt: number) => Math.min(1_000 * 3 ** (attempt - 1), 10_000);

export interface StreamRetryInfo {
  attempt: number;
  message: string;
  /** Whether the failed attempt had already streamed content downstream. */
  hadContent: boolean;
}

export interface StreamRetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  onRetry?: (info: StreamRetryInfo) => void;
  /**
   * Override the backoff schedule. When omitted, transport failures use a
   * short exponential delay (400ms base) while server errors use a longer one
   * (1 s base) to give the backend recovery time.
   */
  delayMs?: (attempt: number, isServer: boolean) => number;
}

const transportDelayMs = (attempt: number) => Math.min(400 * 3 ** (attempt - 1), 3_000);

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// The agent loop awaits the stream's result on any terminal event, so a stream
// that stops without one would hang the turn. Every exit path ends with either
// a forwarded terminal event or this synthetic one.
function failureEvent(
  model: Model<Api>,
  message: string,
  aborted: boolean,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  return { type: "error", reason: error.stopReason as "error" | "aborted", error };
}

/**
 * Resend a request whose stream died mid-flight. Only the first attempt's
 * `start` reaches the consumer: the agent loop pushes a partial message on
 * `start` and replaces it on every later event, so swallowing the retry's
 * `start` makes the fresh response overwrite the truncated one instead of
 * leaving both in the transcript.
 */
export function withStreamRetry(inner: StreamFn, options: StreamRetryOptions = {}): StreamFn {
  const attempts = options.attempts ?? 3;
  const delayMs =
    options.delayMs ??
    ((attempt, isServer) => (isServer ? serverErrorDelayMs : transportDelayMs)(attempt));
  return (model, context, streamOptions) => {
    const outer = new AssistantMessageEventStream();
    const finish = (event: AssistantMessageEvent) => {
      outer.push(event);
      outer.end();
    };
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        let failure: { message: string; event?: AssistantMessageEvent } | undefined;
        let hadContent = false;
        try {
          const stream = await inner(model, context, streamOptions);
          let terminated = false;
          for await (const event of stream) {
            if (event.type === "error") {
              failure = { message: event.error.errorMessage ?? "", event };
              break;
            }
            if (event.type === "start" && attempt > 1) continue;
            if (event.type !== "start") hadContent = true;
            if (event.type === "done") terminated = true;
            outer.push(event);
          }
          if (!failure) {
            if (terminated) outer.end();
            else finish(failureEvent(model, "模型流在没有结束事件的情况下中断。", false));
            return;
          }
        } catch (error) {
          failure = { message: error instanceof Error ? error.message : String(error) };
        }
        const aborted = streamOptions?.signal?.aborted ?? false;
        const retryable = !aborted && isRetryable(failure.message);
        if (attempt >= attempts || !retryable) {
          finish(failure.event ?? failureEvent(model, failure.message, aborted));
          return;
        }
        const isServer = isTransientServerFailure(failure.message);
        options.onRetry?.({ attempt, message: failure.message, hadContent });
        await sleep(delayMs(attempt, isServer), streamOptions?.signal);
        if (streamOptions?.signal?.aborted) {
          finish(failure.event ?? failureEvent(model, failure.message, true));
          return;
        }
      }
    })();
    return outer;
  };
}
