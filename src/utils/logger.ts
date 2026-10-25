export type ClientDiagnostic = {
  event: string;
  level?: "info" | "warning" | "error";
  message?: string;
  stack?: string;
  details?: Record<string, unknown>;
};

function sanitize(value: string) {
  return value.slice(0, 12_000).replace(/((?:api[-_ ]?key|authorization|bearer|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
function errorFields(error: unknown): Pick<ClientDiagnostic, "message" | "stack"> {
  if (error instanceof Error) return { message: sanitize(error.message), ...(error.stack ? { stack: sanitize(error.stack) } : {}) };
  if (typeof error === "string") return { message: sanitize(error) };
  try { return { message: sanitize(JSON.stringify(error) || String(error)) }; }
  catch { return { message: sanitize(String(error)) }; }
}

/** Fire-and-forget client diagnostics. Never let logging itself break the UI or run flow. */
export function reportClientDiagnostic(
  event: string,
  error?: unknown,
  details?: Record<string, unknown>,
  level: ClientDiagnostic["level"] = "error",
) {
  const body: ClientDiagnostic & { at: string; source: "web"; category: "client" } = {
    event: event.slice(0, 120), category: "client", level, at: new Date().toISOString(), source: "web",
    ...(error === undefined ? {} : errorFields(error)),
    ...(details ? { details } : {}),
  };
  try {
    void fetch("/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* The logger endpoint may be unavailable during a server restart. */ });
  } catch { /* Logging must never throw into application code. */ }
}

export function installGlobalErrorLogging() {
  const onError = (event: ErrorEvent) => {
    reportClientDiagnostic("window_error", event.error || event.message, {
      filename: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportClientDiagnostic("unhandled_rejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
