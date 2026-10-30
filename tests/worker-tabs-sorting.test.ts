import assert from "node:assert/strict";
import test from "node:test";
import type { GptSessionSummary } from "../shared/gpt-sessions";
import { filterClosedWorkerTabs, getWorkerPriority, sortWorkerTabs } from "../src/utils/worker-tabs";

function worker(id: string, overrides: Partial<Omit<GptSessionSummary, "id">> = {}): GptSessionSummary {
  return {
    id,
    name: id,
    status: "idle",
    model: "test-model",
    updatedAt: 0,
    hasUnreadReply: false,
    pendingQuestionCount: 0,
    recentTools: [],
    lastReplyPreview: "",
    ...overrides,
  };
}

test("worker priorities put input requests before active, unread, idle and inactive workers", () => {
  assert.equal(getWorkerPriority(worker("waiting", { status: "waiting_input" })), 0);
  assert.equal(getWorkerPriority(worker("question", { pendingQuestionCount: 1 })), 0);
  assert.equal(getWorkerPriority(worker("running", { status: "running" })), 1);
  assert.equal(getWorkerPriority(worker("starting", { status: "starting" })), 1);
  assert.equal(getWorkerPriority(worker("unread", { hasUnreadReply: true })), 2);
  assert.equal(getWorkerPriority(worker("idle", { status: "idle" })), 3);
  for (const status of ["interrupted", "suspended", "closed", "error"] as const) {
    assert.equal(getWorkerPriority(worker(status, { status })), 4);
  }
});

test("running and starting workers sort ahead of idle workers regardless of update time", () => {
  const workers = [
    worker("idle", { updatedAt: 100 }),
    worker("running", { status: "running", updatedAt: 1 }),
    worker("starting", { status: "starting", updatedAt: 2 }),
  ];

  assert.deepEqual(sortWorkerTabs(workers).map(({ id }) => id), ["starting", "running", "idle"]);
});

test("waiting_input and pending questions both take the urgent top tier", () => {
  const workers = [
    worker("active", { status: "running", updatedAt: 20 }),
    worker("waiting", { status: "waiting_input", updatedAt: 10 }),
    worker("question", { status: "idle", pendingQuestionCount: 2, updatedAt: 15 }),
  ];

  assert.deepEqual(sortWorkerTabs(workers).map(({ id }) => id), ["question", "waiting", "active"]);
});

test("unread non-running results sort ahead of ordinary idle workers", () => {
  const workers = [
    worker("idle", { updatedAt: 100 }),
    worker("unread", { hasUnreadReply: true, updatedAt: 1 }),
    worker("running", { status: "running", hasUnreadReply: true, updatedAt: 0 }),
  ];

  assert.deepEqual(sortWorkerTabs(workers).map(({ id }) => id), ["running", "unread", "idle"]);
});

test("workers in the same priority tier sort by updatedAt descending", () => {
  const workers = [
    worker("old", { updatedAt: 1 }),
    worker("newest", { updatedAt: 30 }),
    worker("middle", { updatedAt: 12 }),
  ];

  assert.deepEqual(sortWorkerTabs(workers).map(({ id }) => id), ["newest", "middle", "old"]);
});

test("equal timestamps use name and then ID as deterministic tie-breakers", () => {
  const workers = [
    worker("z-id", { name: "same", updatedAt: 5 }),
    worker("x-id", { name: "alpha", updatedAt: 5 }),
    worker("b-id", { name: "same", updatedAt: 5 }),
  ];

  assert.deepEqual(sortWorkerTabs(workers).map(({ id }) => id), ["x-id", "b-id", "z-id"]);
  assert.deepEqual(sortWorkerTabs([...workers].reverse()).map(({ id }) => id), ["x-id", "b-id", "z-id"]);
});

test("empty input returns an empty list and sorting does not mutate its input", () => {
  assert.deepEqual(sortWorkerTabs([]), []);

  const workers = [worker("z", { updatedAt: 1 }), worker("a", { updatedAt: 2 })];
  const originalOrder = workers.map(({ id }) => id);
  const sorted = sortWorkerTabs(workers);

  assert.deepEqual(sorted.map(({ id }) => id), ["a", "z"]);
  assert.deepEqual(workers.map(({ id }) => id), originalOrder);
  assert.notEqual(sorted, workers);
});

test("locally closed tabs are filtered while backend-closed workers remain in the inactive tier", () => {
  const workers = [
    worker("dismissed", { status: "running" }),
    worker("backend-closed", { status: "closed" }),
  ];

  const visible = filterClosedWorkerTabs(workers, new Set(["dismissed"]));
  assert.deepEqual(visible.map(({ id }) => id), ["backend-closed"]);
  assert.deepEqual(sortWorkerTabs(visible).map(({ id }) => id), ["backend-closed"]);
  assert.equal(getWorkerPriority(visible[0]), 4);
});
