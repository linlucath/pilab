import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Response } from "express";
import { defaults, initialMessages, type Message } from "../shared/schema";
import type { WorkspaceData } from "../shared/workspace";
import { ProjectWorkspaceStore } from "../server/workspace";
import { RunManager, type RunInput } from "../server/runs";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  status(code: number) { this.statusCode = code; return this; }
  set(headers: Record<string, string>) { Object.assign(this.headers, headers); return this; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; }
  disconnect() { this.destroyed = true; this.emit("close"); }
  events() { return this.chunks.flatMap((chunk) => chunk.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))); }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for run completion.");
}

const runInput: RunInput = { settings: { ...defaults }, messages: structuredClone(initialMessages) };

test("disconnecting an NDJSON subscriber does not abort the detached run", async () => {
  const entered = deferred();
  const release = deferred();
  const manager = new RunManager(async () => {}, async () => {
    entered.resolve();
    await release.promise;
    return [];
  });
  const { runId } = manager.startRun("session-a", runInput);
  await entered.promise;
  const response = new FakeResponse();
  manager.subscribe(runId, response as unknown as Response);
  response.disconnect();

  assert.equal(manager.tasks.get(runId)?.listeners.size, 0);
  assert.equal(manager.tasks.get(runId)?.abortController.signal.aborted, false);
  release.resolve();
  await waitFor(() => manager.tasks.get(runId)?.status !== "running");
  assert.equal(manager.tasks.get(runId)?.status, "completed");
});

test("a reconnect replays only events after afterSeq and receives live events", async () => {
  const entered = deferred();
  const release = deferred();
  let emit!: (event: Record<string, unknown>) => void;
  const manager = new RunManager(async () => {}, async (_input, publish) => {
    emit = publish;
    entered.resolve();
    await release.promise;
    return [];
  });
  const { runId } = manager.startRun("session-a", runInput);
  await entered.promise;
  emit({ type: "text", delta: "first" });
  emit({ type: "text", delta: "second" });

  const response = new FakeResponse();
  assert.equal(manager.subscribe(runId, response as unknown as Response, 1), true);
  emit({ type: "text", delta: "third" });
  assert.deepEqual(response.events().map((item) => item.seq), [2, 3, 4]);
  assert.deepEqual(response.events().map((item) => item.event.delta), ["first", "second", "third"]);

  release.resolve();
  await waitFor(() => manager.tasks.get(runId)?.status !== "running");
  assert.equal(response.writableEnded, true);
});

test("only an explicit abort command aborts the generator", async () => {
  const entered = deferred();
  const manager = new RunManager(async () => {}, async (_input, _emit, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [];
  });
  const { runId } = manager.startRun("session-a", runInput);
  await entered.promise;
  assert.equal(manager.abortRun(runId), true);
  await waitFor(() => manager.tasks.get(runId)?.status !== "running");
  assert.equal(manager.tasks.get(runId)?.abortController.signal.aborted, true);
  assert.equal(manager.tasks.get(runId)?.status, "aborted");
  assert.equal(manager.abortRun(runId), false);
});

test("completed run messages are atomically appended to the requested session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-runs-"));
  try {
    const store = new ProjectWorkspaceStore(path.join(directory, "workspace.json"));
    const data: WorkspaceData = {
      sessions: ["target", "other"].map((id) => ({
        id,
        title: id,
        settings: { ...defaults },
        messages: structuredClone(initialMessages),
      })),
      active: "target",
      hiddenPiSessions: [],
      followPi: false,
      folders: [],
      rootSessionIds: ["target", "other"],
    };
    await store.initialize(data);
    const generated: Message = {
      id: "generated-assistant",
      role: "assistant",
      content: "Persisted output",
      enabled: true,
    };
    const manager = new RunManager(store.appendRunMessages.bind(store), async (_input, emit) => {
      emit({ type: "assistant", message: generated });
      return [generated];
    });
    const { runId } = manager.startRun("target", runInput);
    await waitFor(() => manager.tasks.get(runId)?.status !== "running");

    const workspace = await store.get();
    const target = workspace?.sessions.find((session) => session.id === "target");
    const other = workspace?.sessions.find((session) => session.id === "other");
    assert.equal(target?.messages.at(-1)?.id, generated.id);
    assert.equal(target?.messages.at(-1)?.content, generated.content);
    assert.equal(other?.messages.length, initialMessages.length);
    assert.equal(manager.tasks.get(runId)?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
