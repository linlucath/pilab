// Explicit opt-in: talks to the real local Pi subscription and creates a fixture session.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { PiLiveDetail } from "../shared/pi-sync";
if (!process.argv.includes("--live"))
  throw new Error("Use --live to call the real Pi subscription.");
const cwd = await mkdtemp(join(tmpdir(), "pi-lab-sync-live-"));
await writeFile(join(cwd, "marker.txt"), "NATIVE_TOOLS_OK\n");
const pi = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--model",
    "gpt-5.6-luna",
    "--thinking",
    "low",
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "read",
    "--name",
    "Pi 双向同步 · 工具回归",
  ],
  { cwd, stdio: ["pipe", "pipe", "pipe"] },
);
let buffer = "";
let stopped = false;
let toolCount = 0;
let output = "";
let settled = 0;
let diagnostic = "";
pi.on("exit", () => {
  stopped = true;
});
pi.stderr.on("data", (chunk) => {
  diagnostic = (diagnostic + chunk.toString()).slice(-1500);
});
pi.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let line: number;
  while ((line = buffer.indexOf("\n")) >= 0) {
    const text = buffer.slice(0, line);
    buffer = buffer.slice(line + 1);
    try {
      const event = JSON.parse(text);
      if (event.type === "tool_execution_start") toolCount++;
      if (event.type === "message_end" && event.message?.role === "assistant")
        output = event.message.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      if (event.type === "agent_settled") settled++;
    } catch {}
  }
});
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 90_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    if (stopped) throw new Error(`Pi exited during ${label}: ${diagnostic}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout: ${label}: ${diagnostic}`);
}
const base = "http://127.0.0.1:3000/api/pi-sync";
let id = "";
const detail = async (): Promise<PiLiveDetail> =>
  (await fetch(`${base}/${id}`)).json();
const prompt = (message: string) =>
  pi.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
try {
  await until(async () => {
    const list = await (await fetch(base)).json();
    id = list.sessions.find((s: any) => s.pid === pi.pid)?.id || "";
    return !!id;
  }, "auto-discovery");
  prompt(
    "先用 read 读取 marker.txt。请记住测试暗号是 PISYNC_TOOL_ORIGINAL；只回复已记住。",
  );
  await until(() => settled === 1, "first real tool cycle");
  assert.ok(toolCount >= 1, "Pi used its native read tool");
  let before = await detail();
  before.messages = before.messages.map((m) =>
    m.role === "user"
      ? {
          ...m,
          content: m.content.replace(
            "PISYNC_TOOL_ORIGINAL",
            "PISYNC_TOOL_EDITED",
          ),
        }
      : m,
  );
  const response = await fetch(`${base}/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: before.revision,
      messages: before.messages,
    }),
  });
  const command = await response.json();
  assert.equal(response.status, 200, JSON.stringify(command));
  await until(
    async () => (await detail()).ack?.id === command.id,
    "Pi acknowledgement",
  );
  assert.equal((await detail()).ack?.status, "applied");
  const oldToolCount = toolCount;
  prompt(
    "再用 read 读取 marker.txt。只输出第一条 user 消息中的测试暗号，不要输出文件内容。",
  );
  await until(() => settled === 2, "edited context with native tools");
  assert.ok(
    toolCount > oldToolCount,
    "native tools remain available after applying edited context",
  );
  assert.equal(output.trim(), "PISYNC_TOOL_EDITED");
  const after = await detail();
  assert.equal(after.error, "");
  assert.ok(after.lastAppliedRequest > 0);
  console.log(
    JSON.stringify({
      ok: true,
      model: "gpt-5.6-luna",
      toolCalls: toolCount,
      output,
      fixtureDirectory: cwd,
      sessionFile: after.sessionFile,
    }),
  );
} finally {
  pi.kill("SIGTERM");
}
