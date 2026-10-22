// Explicit opt-in CLI -> extension -> HTTP SSE smoke test using the real subscription.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
if (!process.argv.includes("--live")) throw new Error("Pass --live to use the Pi subscription.");
const pi = spawn("pi", ["--mode", "rpc", "--model", "gpt-5.6-luna", "--thinking", "low", "--offline", "--no-mcp", "--no-skills", "--no-context-files", "--tools", "", "--name", "Pi 流式同步 · 真实验证"], { stdio: ["pipe", "pipe", "pipe"] });
pi.stdout.resume(); pi.stderr.resume();
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 90_000);
const base = "http://127.0.0.1:3000/api/pi-sync";
try {
  let id = "";
  for (let i = 0; i < 100 && !id; i++) {
    const list = await (await fetch(base, { signal: abort.signal })).json();
    id = list.sessions.find((s: any) => s.pid === pi.pid)?.id || "";
    if (!id) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(id, "new Pi session auto-discovered");
  const response = await fetch(`${base}/${id}/events`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  pi.stdin.write(JSON.stringify({ type: "prompt", message: "请用中文列出15条上下文调试建议，每条约25字。每条单独一行，不要开场白。" }) + "\n");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  let buffer = "";
  const partialLengths = new Set<number>();
  let final = "";
  while (!final) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.startsWith("event: snapshot\n")) continue;
      const snapshot = JSON.parse(frame.split("\ndata: ")[1]);
      if (snapshot.busy && snapshot.partial?.content) {
        partialLengths.add(snapshot.partial.content.length);
        console.log(JSON.stringify({ atMs: Date.now() - started, partialCharacters: snapshot.partial.content.length }));
      }
      if (!snapshot.busy && snapshot.requestCount > 0) final = snapshot.messages.filter((m: any) => m.role === "assistant").at(-1)?.content || "";
    }
  }
  assert.ok(partialLengths.size > 1, "must receive growing CLI text before completion");
  assert.ok(final.length > Math.min(...partialLengths), "final text extends first streamed text");
  console.log(JSON.stringify({ ok: true, partialUpdates: partialLengths.size, characters: final.length, elapsedMs: Date.now() - started }));
} finally { clearTimeout(timeout); abort.abort(); pi.kill("SIGTERM"); }
