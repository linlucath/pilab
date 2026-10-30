import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaults, initialMessages } from "../shared/schema";
import { mergeProjectWorkspace, projectWorkspaceSchema, type ProjectWorkspace, type WorkspaceData } from "../shared/workspace";
import { ProjectWorkspaceStore } from "../server/workspace";

function workspace(): WorkspaceData {
  const settings = { ...defaults };
  delete (settings as Partial<typeof settings>).apiKey;
  return {
    sessions: ["a", "b"].map((id) => ({ id, title: `Session ${id}`, settings, messages: structuredClone(initialMessages) })),
    active: "a", hiddenPiSessions: [], followPi: false, folders: [], rootSessionIds: ["b", "a"],
  };
}

test("v1 workspace migration places newest sessions first and persists schema v2", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-workspace-migration-"));
  try {
    const file = path.join(directory, "workspace.json");
    const legacy = { ...workspace(), version: 1, revision: 7, deletedSessionIds: [] } as Record<string, unknown>;
    delete legacy.folders;
    delete legacy.rootSessionIds;
    await writeFile(file, JSON.stringify(legacy));
    const migrated = await new ProjectWorkspaceStore(file).get();
    assert.equal(migrated?.version, 2);
    assert.deepEqual(migrated?.folders, []);
    assert.deepEqual(migrated?.rootSessionIds, ["b", "a"]);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.rootSessionIds, ["b", "a"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("revision lookup reuses the cached file version and detects writes from another store", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-workspace-revision-"));
  try {
    const file = path.join(directory, "workspace.json");
    const writer = new ProjectWorkspaceStore(file);
    const reader = new ProjectWorkspaceStore(file);
    const initial = await writer.initialize(workspace());
    assert.equal(await writer.getRevision(), initial.revision);
    assert.equal(await reader.getRevision(), initial.revision);
    const next = await writer.update({ baseRevision: initial.revision, sessions: [{ id: "a", title: "updated externally" }] });
    assert.equal(await reader.getRevision(), next.revision);
    assert.equal(await reader.getRevision(), next.revision);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stale server updates are rebased onto the newest on-disk workspace revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pilab-workspace-"));
  try {
    const file = path.join(directory, "workspace.json");
    const first = new ProjectWorkspaceStore(file);
    const second = new ProjectWorkspaceStore(file);
    const initial = await first.initialize(workspace());
    assert.equal((await first.get())?.revision, 1);
    assert.equal((await second.get())?.revision, 1);
    const firstMessages = structuredClone(initial.sessions.find((session) => session.id === "a")!.messages);
    firstMessages[0].content = "edit from first server";
    await first.update({ baseRevision: initial.revision, sessions: [{ id: "a", title: "A updated", messages: firstMessages }] });
    const secondMessages = structuredClone(initial.sessions.find((session) => session.id === "a")!.messages);
    secondMessages[1].content = "edit from stale second server";
    const merged = await second.update({ baseRevision: initial.revision, sessions: [
      { id: "a", messages: secondMessages }, { id: "b", title: "B updated" },
    ] });
    assert.equal(merged.revision, 3);
    assert.equal(merged.sessions.find((session) => session.id === "a")?.title, "A updated");
    assert.equal(merged.sessions.find((session) => session.id === "a")?.messages[0].content, "edit from first server");
    assert.equal(merged.sessions.find((session) => session.id === "a")?.messages[1].content, "edit from stale second server");
    assert.equal(merged.sessions.find((session) => session.id === "b")?.title, "B updated");
    const compacted = structuredClone(merged.sessions.find((session) => session.id === "a")!.messages);
    compacted[0].compactedByModel = true;
    compacted[0].modelSummary = "保留最重要的上下文摘要。";
    await first.update({ baseRevision: merged.revision, sessions: [{ id: "a", messages: compacted }] });
    const persisted = (await second.get())!.sessions.find((session) => session.id === "a")!.messages[0];
    assert.equal(persisted.compactedByModel, true);
    assert.equal(persisted.modelSummary, "保留最重要的上下文摘要。");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("three-way workspace merge unions worker completion signatures across tabs", () => {
  const base = projectWorkspaceSchema.parse({ ...workspace(), version: 1, revision: 2, deletedSessionIds: [] });
  const local: ProjectWorkspace = structuredClone(base);
  const remote: ProjectWorkspace = structuredClone(base);
  local.sessions[0].reviewedWorkerSignatures = ["previous", "local-worker-turn"];
  remote.sessions[0].reviewedWorkerSignatures = ["previous", "remote-worker-turn"];
  const merged = mergeProjectWorkspace(base, local, remote);
  assert.deepEqual(merged.sessions[0].reviewedWorkerSignatures, ["previous", "remote-worker-turn", "local-worker-turn"]);
});

test("three-way workspace merge preserves disjoint edits and favors disk on same-field conflicts", () => {
  const base = projectWorkspaceSchema.parse({ ...workspace(), version: 1, revision: 4, deletedSessionIds: [] });
  const local: ProjectWorkspace = structuredClone(base);
  const remote: ProjectWorkspace = structuredClone(base);
  const localA = local.sessions[0];
  const remoteA = remote.sessions[0];
  localA.messages[0].content = "local edit to first message";
  remoteA.messages[1].content = "disk edit to second message";
  localA.title = "Local title";
  remoteA.title = "Disk title";
  local.revision = 5;
  remote.revision = 6;
  const merged = mergeProjectWorkspace(base, local, remote);
  assert.equal(merged.sessions[0].messages[0].content, "local edit to first message");
  assert.equal(merged.sessions[0].messages[1].content, "disk edit to second message");
  assert.equal(merged.sessions[0].title, "Disk title");
  assert.equal(merged.revision, 7);
});
