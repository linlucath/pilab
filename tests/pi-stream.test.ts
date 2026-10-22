import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PiLiveDetail } from "../shared/pi-sync";
import extension from "../extensions/pi-lab-sync/index";
import { atomicJson } from "../extensions/pi-lab-sync/state";

const dir = mkdtempSync(join(tmpdir(), "pi-stream-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { piSnapshotReader, streamPiSnapshots } = await import("../server/pi-sync");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Pi stream reads partial updates, skips identical files and tracks lost heartbeat", async () => {
  const id = "stream-fixture";
  const file = join(dir, "pi-lab-sync", `${id}.json`);
  const heartbeat = join(dir, "pi-lab-sync", `${id}.heartbeat`);
  const snapshot = {
    version: 1, id, sessionId: id, online: true, heartbeat: Date.now(),
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  };
  atomicJson(file, snapshot);
  atomicJson(heartbeat, { at: Date.now() });
  const read = piSnapshotReader(id);
  assert.equal((await read())?.messages[0].content, "hello");
  assert.equal(await read(), undefined);
  await sleep(5);
  atomicJson(file, {
    ...snapshot,
    partial: {
      role: "assistant", content: [{ type: "text", text: "first chunk" }],
      api: "openai-completions", provider: "openai", model: "test", timestamp: 2,
    },
  });
  assert.equal((await read())?.partial?.content, "first chunk");
  assert.equal(await read(), undefined);
  // Simulate a killed terminal without waiting eight real seconds.
  const now = Date.now;
  try {
    Date.now = () => now() + 10_000;
    assert.equal((await read())?.online, false);
    assert.equal(await read(), undefined);
  } finally { Date.now = now; }
  const nextHeartbeat = Date.now() + 100;
  utimesSync(heartbeat, nextHeartbeat / 1000, nextHeartbeat / 1000);
  assert.equal((await read())?.online, true);
  assert.equal(await read(), undefined);
  assert.throws(() => piSnapshotReader("../../private"));
});

test("Pi stream serializes reads, deduplicates errors, recovers and stops on disconnect", async () => {
  const abort = new AbortController();
  const errors: string[] = [];
  const seen: PiLiveDetail[] = [];
  let reads = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  await streamPiSnapshots(async () => {
    reads++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(8);
    concurrent--;
    if (reads < 3) throw new Error("temporary disk failure");
    return { id: "recovered" } as PiLiveDetail;
  }, (detail) => {
    seen.push(detail);
    abort.abort();
  }, (error) => { errors.push(error); }, abort.signal, 1);
  assert.deepEqual(errors, ["temporary disk failure"]);
  assert.equal(maxConcurrent, 1);
  assert.equal(seen[0].id, "recovered");
  const stoppedAt = reads;
  await sleep(15);
  assert.equal(reads, stoppedAt);
});

test("extension flushes a trailing delta before message_end and cancels pending timers", async () => {
  const handlers = new Map<string, Function>();
  const id = `extension-stream-${process.pid}`;
  const file = join(dir, "pi-lab-sync", `${id}-${process.pid}.json`);
  extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => "low", registerCommand() {},
  } as any);
  const ctx = {
    cwd: dir, model: undefined, isIdle: () => true,
    getSystemPrompt: () => "system", ui: { setStatus() {} },
    sessionManager: {
      getSessionId: () => id, getSessionFile: () => undefined,
      getSessionName: () => "fixture", getLeafId: () => "leaf",
      getBranch: () => [], buildSessionProjection: () => ({ messages: [] }),
    },
  };
  const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  const { readFileSync } = await import("node:fs");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  try {
    fire("session_start");
    fire("message_update", { message: { role: "assistant", content: "one" } });
    fire("message_update", { message: { role: "assistant", content: "one two" } });
    await sleep(140);
    assert.equal(read().partial.content, "one two");
    fire("message_update", { message: { role: "assistant", content: "last" } });
    fire("message_end");
    await sleep(140);
    assert.equal(read().partial, undefined);
    fire("message_update", { message: { role: "assistant", content: "shutdown" } });
    fire("session_shutdown");
    await sleep(140);
    assert.equal(read().online, false);
  } finally { fire("session_shutdown"); }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
