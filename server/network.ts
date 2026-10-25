import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { channel } from "node:diagnostics_channel";

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
  if (!/fetch failed|failed to fetch|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_/i.test(message)) return message;
  const provider = model.provider === "antigravity" ? "Gemini" : model.provider === "openai-codex" ? "GPT" : model.provider;
  let host = "";
  try { host = new URL(model.baseUrl).hostname; } catch {}
  const recent = lastFailure && Date.now() - lastFailure.at < 15_000 &&
    (lastFailure.host === host || (model.provider === "antigravity" && lastFailure.host.endsWith(".googleapis.com"))) ? lastFailure : undefined;
  return `${provider} 请求连接失败：${message}${recent ? `（${recent.codes.join(" / ")}）` : ""}`;
}

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
}
