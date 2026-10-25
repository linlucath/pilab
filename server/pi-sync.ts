import { mkdir, readdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { z } from "zod";
import { messageSchema, type Message } from "../shared/schema";
import type { PiLiveDetail, PiLiveSession } from "../shared/pi-sync";
import { fromPiMessage, toPiMessage, validateToolHistory } from "./transcript";
import { digest, type NativeMessage } from "../extensions/pi-lab-sync/state";

const agentDir =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const bridgeDir = join(agentDir, "pi-lab-sync");
const keySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,180}$/);
const file = (id: string) => join(bridgeDir, `${keySchema.parse(id)}.json`);
async function state(id: string) {
  const value = JSON.parse(await readFile(file(id), "utf8"));
  if (value.version !== 1 || value.id !== id || !Array.isArray(value.messages))
    throw new Error("Pi 同步快照无效");
  value.heartbeat = await stat(join(bridgeDir, `${id}.heartbeat`)).then(
    (s) => Math.max(s.mtimeMs, value.heartbeat),
    () => value.heartbeat,
  );
  return value;
}
const metaCache = new Map<string, { mtime: number; value: any }>();
async function sessionSummary(id: string) {
  const modified = (await stat(file(id))).mtimeMs;
  let cached = metaCache.get(id);
  if (!cached || cached.mtime !== modified) {
    const value = await state(id);
    const { messages: _messages, partial: _partial, ...meta } = value;
    cached = { mtime: modified, value: meta };
    metaCache.set(id, cached);
  }
  const heartbeat = await stat(join(bridgeDir, `${id}.heartbeat`)).then(
    (s) => Math.max(s.mtimeMs, cached!.value.heartbeat),
    () => cached!.value.heartbeat,
  );
  return summary({ ...cached.value, heartbeat });
}
function summary(value: any): PiLiveSession {
  const { messages: _messages, partial: _partial, ...meta } = value;
  return {
    ...meta,
    online: value.online && Date.now() - value.heartbeat < 8000,
  };
}
function display(messages: NativeMessage[]): Message[] {
  return messages.map((m, i) => {
    const id = `pi-${i}-${digest(m).slice(0, 20)}`;
    if (m.role === "system")
      return {
        id,
        role: "system",
        enabled: true,
        content: getSystemMessageText(m as any),
      };
    if (m.role === "user")
      return {
        id,
        role: "user",
        enabled: true,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n"),
      };
    if (["assistant", "toolResult"].includes(m.role))
      return fromPiMessage(m as any, id);
    return {
      id,
      role: "user",
      enabled: true,
      content:
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? m),
    };
  });
}
export async function syncList() {
  let names: string[] = [];
  try {
    names = await readdir(bridgeDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const results = await Promise.allSettled(
    names
      .filter((n) => n.endsWith(".json") && !n.endsWith(".command.json"))
      .map(async (name) => sessionSummary(name.slice(0, -5))),
  );
  const sessions = results
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || b.activityAt - a.activityAt,
    );
  const installed = await stat(
    join(agentDir, "extensions", "pi-lab-sync", "index.ts"),
  ).then(
    () => true,
    () => false,
  );
  return { installed, sessions };
}
export async function syncDetail(id: string): Promise<PiLiveDetail> {
  const value = await state(id);
  return {
    ...summary(value),
    messages: display(value.messages),
    ...(value.partial ? { partial: display([value.partial])[0] } : {}),
  };
}

// Each connection keeps only its selected conversation. Inspect cheap file metadata
// between changes rather than reparsing a potentially large transcript every tick.
export function piSnapshotReader(id: string) {
  const stateFile = file(id);
  let stamp = "";
  let cached: PiLiveDetail | undefined;
  return async (): Promise<PiLiveDetail | undefined> => {
    const modified = await stat(stateFile);
    const nextStamp = `${modified.mtimeMs}:${modified.ctimeMs}:${modified.size}`;
    if (!cached || nextStamp !== stamp) {
      const detail = await syncDetail(id);
      cached = detail;
      stamp = nextStamp;
      return detail;
    }
    const heartbeat = await stat(join(bridgeDir, `${id}.heartbeat`)).then(
      (s) => Math.max(s.mtimeMs, cached!.heartbeat),
      () => cached!.heartbeat,
    );
    // Heartbeats alone need not resend the transcript; do report online/offline
    // transitions, including a killed CLI which never published a shutdown.
    const online = Date.now() - heartbeat < 8000;
    if (online !== cached.online && (online ? heartbeat > cached.heartbeat : true)) {
      // A clean shutdown must remain offline even if its heartbeat is recent.
      const detail = await syncDetail(id);
      if (detail.online !== cached.online) {
        cached = detail;
        return detail;
      }
    }
    return undefined;
  };
}

export async function streamPiSnapshots(
  read: () => Promise<PiLiveDetail | undefined>,
  emit: (snapshot: PiLiveDetail) => void | Promise<void>,
  reportError: (error: string) => void | Promise<void>,
  signal: AbortSignal,
  intervalMs = 150,
) {
  let lastError = "";
  while (!signal.aborted) {
    try {
      const detail = await read();
      if (signal.aborted) return;
      if (detail) await emit(detail);
      lastError = "";
    } catch (e) {
      if (signal.aborted) return;
      const message = (e as Error).message;
      if (message !== lastError) await reportError(message);
      lastError = message;
    }
    // Serialized polling prevents overlap when disk access takes longer than a tick.
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
// Preserve every unedited native message, including images, signatures, custom roles and tool metadata.
export function mergeSyncMessages(
  original: NativeMessage[],
  edited: Message[],
  model: any,
) {
  const views = display(original);
  const byId = new Map(
    views.map((m, i) => [m.id, { view: m, raw: original[i] }]),
  );
  validateToolHistory(edited.filter((m) => m.enabled));
  const active = edited.filter((m) => m.enabled);
  if (active[0]?.role !== "system")
    throw new Error("Pi 需要保留开头的 system 消息及工具声明。");
  return active.map((m, index) => {
    if (m.role === "developer")
      throw new Error(
        "Pi 原生上下文不支持独立 developer 角色，请使用 system 或在网页实验中调试。",
      );
    const previous = byId.get(m.id);
    if (previous && digest(messageSchema.parse(previous.view)) === digest(m))
      return previous.raw;
    const native = toPiMessage(m, model) as NativeMessage;
    if (index === 0 && m.role === "system")
      native.toolsAdded = original[0]?.toolsAdded;
    if (!previous || previous.view.role !== m.role) return native;
    const merged: NativeMessage = {
      ...previous.raw,
      ...native,
      timestamp: previous.raw.timestamp,
    };
    // Changing text must not discard images or unrelated opaque content blocks.
    if (m.role === "system") merged.sections = undefined;
    if (Array.isArray(previous.raw.content)) {
      const opaque = previous.raw.content.filter(
        (b: any) => !["text", "thinking", "toolCall"].includes(b.type),
      );
      const content =
        typeof native.content === "string"
          ? [{ type: "text", text: native.content }]
          : native.content;
      merged.content = [...content, ...opaque];
    }
    if (m.content !== previous.view.content && Array.isArray(merged.content)) {
      merged.content = merged.content.map((b: any) =>
        b.type === "text"
          ? (({ textSignature: _signature, ...text }) => text)(b)
          : b,
      );
    }
    return merged;
  });
}
const editSchema = z.object({
  revision: z.string().length(64),
  messages: z.array(messageSchema).min(1).max(500),
});
export async function syncApply(id: string, body: unknown) {
  const input = editSchema.parse(body);
  const value = await state(id);
  if (!summary(value).online)
    throw new Error("Pi 已离线。请在对应终端恢复会话后提交。");
  if (value.busy) throw new Error("Pi 正在执行，请等本轮结束后提交。");
  if (input.revision !== value.revision)
    throw new Error("Pi 已有新消息。请重新同步后核对修改。");
  const messages = mergeSyncMessages(
    value.messages,
    input.messages,
    value.model
      ? { ...value.model, id: value.model.id }
      : {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "unknown",
        },
  );
  const commandId = randomUUID();
  // Exclusive creation prevents two tabs from silently overwriting each other's commands.
  const commandFile = join(bridgeDir, `${keySchema.parse(id)}.command.json`);
  await mkdir(dirname(commandFile), { recursive: true });
  try {
    await writeFile(
      commandFile,
      JSON.stringify({ id: commandId, revision: input.revision, messages }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("上一份修改仍在等待 Pi 确认，请稍后重试。");
    throw e;
  }
  return { id: commandId, status: "pending" };
}

export async function syncCancel(id: string, commandId: string) {
  const value = await state(id);
  if (summary(value).online) throw new Error("Pi 仍在线，请等待确认。");
  const pending = join(bridgeDir, `${keySchema.parse(id)}.command.json`);
  try {
    const command = JSON.parse(await readFile(pending, "utf8"));
    if (command.id !== commandId)
      throw new Error("待确认修改已改变，请刷新状态。");
    await unlink(pending);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { status: "released" };
}
