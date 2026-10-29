import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSessionWorkspace } from "../server/session-workspaces";

const firstId = "2df3285f-98e3-4ced-9677-a207a5789f33";
const secondId = "54cc43d7-c875-4db0-a7e2-63cc658b341f";

test("session workspaces are stable per ID and isolated from one another", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pilab-session-workspaces-"));
  try {
    const first = await ensureSessionWorkspace(firstId, path.join(root, "workspaces"));
    const again = await ensureSessionWorkspace(firstId, path.join(root, "workspaces"));
    const second = await ensureSessionWorkspace(secondId, path.join(root, "workspaces"));
    assert.equal(first, await realpath(first));
    assert.equal(again, first);
    assert.equal(path.basename(first), firstId);
    assert.notEqual(second, first);
    assert.equal(path.dirname(first), path.dirname(second));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untrusted session IDs are hashed and existing symlinks cannot escape the root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pilab-session-workspace-safety-"));
  const workspaces = path.join(root, "workspaces");
  const outside = path.join(root, "outside");
  const directoryName = createHash("sha256").update("../../outside").digest("hex");
  try {
    const safePath = await ensureSessionWorkspace("../../outside", workspaces);
    assert.equal(path.dirname(safePath), await realpath(workspaces));
    await assert.rejects(ensureSessionWorkspace("", workspaces), /ID 无效/);
    await mkdir(outside);
    await symlink(outside, path.join(workspaces, firstId));
    await assert.rejects(ensureSessionWorkspace(firstId, workspaces), /路径不安全/);
    assert.equal(path.basename(safePath), directoryName);
  } finally { await rm(root, { recursive: true, force: true }); }
});
