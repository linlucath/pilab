import { Agent, EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { channel } from "node:diagnostics_channel";

// Transport-level failures, as opposed to provider errors that carry a status.
// "terminated" is what undici's fetch throws when the socket dies after the
// response headers arrived, so it marks a cut SSE body rather than a failed
// handshake. Keep this the single source of truth; stream retry reuses it.
export const transportFailurePattern =
  /fetch failed|failed to fetch|terminated|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_/i;

// Antigravity controls its SSE inactivity watchdog separately from timeoutMs.
// Reasoning/queued turns can remain silent for over two minutes. Keep a finite
// deadline, while respecting both current and legacy user overrides (including 0).
process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS ??=
  process.env.NOAGY_STREAM_STALL_TIMEOUT_MS ?? "600000";

let lastFailure: { at: number; host: string; codes: string[] } | undefined;
function errorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error) || seen.size >= 10) return [];
  seen.add(error);
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return [...new Set([
    ...(typeof value.code === "string" ? [value.code] : []),
    ...errorCodes(value.cause, seen),
    ...(Array.isArray(value.errors) ? value.errors.flatMap((item) => errorCodes(item, seen)) : []),
  ])].filter((code) => /^[A-Z0-9_]{1,60}$/.test(code)).slice(0, 5);
}

// Retain transport causes before providers flatten them to "fetch failed".
// Never log request bodies, paths, headers, credentials or proxy URLs.
channel("undici:request:error").subscribe((event) => {
  try {
    const { request, error } = event as { request?: { origin?: unknown }; error?: unknown };
    const codes = errorCodes(error);
    if (!codes.length) return;
    const host = new URL(String(request?.origin)).hostname;
    lastFailure = { at: Date.now(), host, codes };
    console.warn(`[network] ${host} ${codes.join(", ")}`);
  } catch { /* Diagnostics must never interrupt the request itself. */ }
});

export function modelRequestError(message: string, model: { provider: string; baseUrl: string }) {
  const stalled = /stream stalled: no data for (\d+)ms/i.exec(message);
  if (stalled) {
    const seconds = Number(stalled[1]) / 1000;
    return `模型流式响应连续 ${seconds} 秒未收到数据，已中止等待。可能是上游推理、排队或网络连接停滞；已收到的内容会保留。原始错误：${message}`;
  }
  if (!transportFailurePattern.test(message)) return message;
  const provider = model.provider === "antigravity" ? "Gemini" : model.provider === "openai-codex" ? "GPT" : model.provider;
  let host = "";
  try { host = new URL(model.baseUrl).hostname; } catch {}
  const recent = lastFailure && Date.now() - lastFailure.at < 15_000 &&
    (lastFailure.host === host || (model.provider === "antigravity" && lastFailure.host.endsWith(".googleapis.com"))) ? lastFailure : undefined;
  return `${provider} 请求连接失败：${message}${recent ? `（${recent.codes.join(" / ")}）` : ""}`;
}

// Model streams idle for minutes: while a tool runs, and again while the model
// reasons before its first token. Local proxies and NAT tables reap such
// tunnels, which surfaces as a cut SSE body. Probe the socket often enough to
// keep the path alive, expire pooled connections before the far side does, and
// leave the inactivity deadline to the stream watchdogs above.
const socketKeepAlive = {
  keepAlive: true,
  keepAliveInitialDelay: Number(process.env.PI_LAB_TCP_KEEPALIVE_MS || 15_000),
};
const connectionOptions = {
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  headersTimeout: 300_000,
  bodyTimeout: 600_000,
  connect: { timeout: 20_000, ...socketKeepAlive },
};

// Node's fetch does not consistently inherit HTTP_PROXY without an explicit dispatcher.
// Honor the user's existing proxy while keeping local model endpoints on loopback.
if (
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy
) {
  // Match fetch to the proxy dispatcher so HTTP/2 headers and gzip decode correctly.
  install();
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...connectionOptions,
      // ProxyAgent builds the socket to the proxy from `proxyTls` and the
      // tunneled TLS socket from `requestTls`; neither reads `connect`.
      proxyTls: socketKeepAlive,
      requestTls: socketKeepAlive,
      noProxy: [
        process.env.NO_PROXY || process.env.no_proxy,
        "localhost",
        "127.0.0.1",
        "::1",
      ]
        .filter(Boolean)
        .join(","),
    }),
  );
} else {
  setGlobalDispatcher(new Agent(connectionOptions));
}
