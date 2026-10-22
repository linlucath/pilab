// Explicit opt-in end-to-end test of HTTP streaming with the local Pi subscription.
import assert from "node:assert/strict";
import { defaults } from "../shared/schema";
if (!process.argv.includes("--live")) throw new Error("Pass --live to use the real Pi subscription.");
const base = process.env.PI_LAB_URL || "http://127.0.0.1:3000";
const status = await (await fetch(`${base}/api/pi-status`)).json();
assert.ok(status.connected && status.defaultModel, "Pi subscription must be logged in");
const started = performance.now();
const response = await fetch(`${base}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    settings: { ...defaults, protocol: "pi-subscription", model: status.defaultModel, reasoningEffort: "low", maxTokens: 1600 },
    messages: [{ id: "stream-test", role: "user", enabled: true, content: "请用中文写12条简短的上下文调试建议，每条一行，每条约20字。直接列建议，不要开场白。" }],
  }),
  signal: AbortSignal.timeout(90_000),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
const headersMs = Math.round(performance.now() - started);
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
let firstTextMs = 0;
let lastTextMs = 0;
let chunks = 0;
let text = "";
let doneMs = 0;
let usage;
while (true) {
  const chunk = await reader.read();
  buffer += decoder.decode(chunk.value, { stream: !chunk.done });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line);
    const elapsed = Math.round(performance.now() - started);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "text") {
      if (!chunks) firstTextMs = elapsed;
      lastTextMs = elapsed;
      chunks++;
      text += event.delta;
      console.log(JSON.stringify({ atMs: elapsed, type: "text", length: text.length }));
    }
    if (event.type === "done") { doneMs = elapsed; usage = event.usage; }
  }
  if (chunk.done) break;
}
assert.ok(doneMs, "must finish successfully");
assert.ok(chunks > 1, "must deliver multiple text deltas");
assert.ok(lastTextMs > firstTextMs, "text must arrive progressively, not only at completion");
console.log(JSON.stringify({ model: status.defaultModel, headersMs, firstTextMs, lastTextMs, doneMs, textEvents: chunks, characters: text.length, usage, text }, null, 2));
