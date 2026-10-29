import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("A: disconnecting an NDJSON subscriber lets the run finish and persist its final message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-detached-runtime-"));
  try {
    const workspacePath = path.join(directory, "workspace.json");
    const store = new ProjectWorkspaceStore(workspacePath);
    await store.initialize({
      sessions: [{ id: "session-a", title: "Session A", settings: { ...defaults }, messages: structuredClone(initialMessages) }],
      active: "session-a", hiddenPiSessions: [], followPi: false, folders: [], rootSessionIds: ["session-a"],
    });
    const entered = deferred();
    const release = deferred();
    const generated: Message = { id: "detached-assistant", role: "assistant", content: "finished after disconnect", enabled: true };
    const manager = new RunManager(store.appendRunMessages.bind(store), async (_input, emit) => {
      emit({ type: "assistant_start", id: generated.id });
      emit({ type: "text", id: generated.id, delta: "partial output" });
      entered.resolve();
      await release.promise;
      emit({ type: "assistant", message: generated });
      return [generated];
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
    const persisted = JSON.parse(await readFile(workspacePath, "utf8")) as { sessions: { id: string; messages: Message[] }[] };
    const messages = persisted.sessions.find((session) => session.id === "session-a")?.messages || [];
    assert.equal(messages.filter((message) => message.id === generated.id).length, 1);
    assert.equal(messages.find((message) => message.id === generated.id)?.content, generated.content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("B: a reconnect replays only events after afterSeq and receives live events", async () => {
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

test("C: explicit abort stops the generator and atomically persists its partial assistant output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-detached-abort-"));
  try {
    const workspacePath = path.join(directory, "workspace.json");
    const store = new ProjectWorkspaceStore(workspacePath);
    await store.initialize({
      sessions: [{ id: "session-a", title: "Session A", settings: { ...defaults }, messages: structuredClone(initialMessages) }],
      active: "session-a", hiddenPiSessions: [], followPi: false, folders: [], rootSessionIds: ["session-a"],
    });
    const entered = deferred();
    const partial: Message = { id: "partial-assistant", role: "assistant", content: "keep this partial output", enabled: true };
    const manager = new RunManager(store.appendRunMessages.bind(store), async (_input, emit, signal) => {
      emit({ type: "assistant", message: partial });
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return [partial];
    });
    const { runId } = manager.startRun("session-a", runInput);
    await entered.promise;
    assert.equal(manager.abortRun(runId), true);
    await waitFor(() => manager.tasks.get(runId)?.status !== "running");
    assert.equal(manager.tasks.get(runId)?.abortController.signal.aborted, true);
    assert.equal(manager.tasks.get(runId)?.status, "aborted");
    assert.equal(manager.abortRun(runId), false);
    const persisted = JSON.parse(await readFile(workspacePath, "utf8")) as { sessions: { id: string; messages: Message[] }[] };
    const saved = persisted.sessions.find((session) => session.id === "session-a")?.messages.find((message) => message.id === partial.id);
    assert.equal(saved?.content, partial.content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RunManager contains an unexpected execution rejection and reports a failed run", async () => {
  const manager = new RunManager(async () => {});
  Object.defineProperty(manager, "execute", { value: async () => { throw new Error("unexpected execution failure"); } });
  const { runId } = manager.startRun("session-failure", runInput);
  await waitFor(() => manager.tasks.get(runId)?.status !== "running");
  const task = manager.tasks.get(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(manager.activeBySession.has("session-failure"), false);
  assert.ok(task.eventBuffer.some(({ event }) => event.type === "error" && event.message === "unexpected execution failure"));
  assert.ok(task.eventBuffer.some(({ event }) => event.type === "run_status" && event.status === "failed"));
});

test("RunManager binds GPT tools to the authoritative run session, not client input", async () => {
  let receivedOwner = "";
  const manager = new RunManager(async () => {}, async (input) => {
    receivedOwner = input.ownerSessionId || "";
    return [];
  });
  const { runId } = manager.startRun("authoritative-parent", { ...runInput, ownerSessionId: "spoofed-fork" });
  await waitFor(() => manager.tasks.get(runId)?.status !== "running");
  assert.equal(receivedOwner, "authoritative-parent");
});

test("A: completed run messages are atomically upserted into only the requested session", async () => {
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
    const beforeRun = (await store.get())!;
    await store.update({ baseRevision: beforeRun.revision, sessions: [{
      id: "target", messages: [...structuredClone(initialMessages), { ...generated, content: "Partial streamed output" }],
    }] });
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
    assert.equal(target?.messages.filter((message) => message.id === generated.id).length, 1);
    assert.equal(other?.messages.length, initialMessages.length);
    assert.equal(manager.tasks.get(runId)?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
