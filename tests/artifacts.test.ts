import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listArtifacts,
  MAX_ARTIFACT_BYTES,
  readArtifact,
  resolveArtifactPath,
  writeArtifact,
} from "../server/artifacts";
import { createArtifactTools } from "../server/tools";

async function tempArtifactsRoot() {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-lab-artifacts-"));
  return { temp, root: path.join(temp, "artifacts") };
}

test("artifacts write and read UTF-8 Markdown and JSON, creating nested parents", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    const markdown = "# Research summary\n\n结论：安全隔离。\n";
    const result = await writeArtifact("session-a", "research/summary.md", markdown, root);
    assert.equal(result.bytes, Buffer.byteLength(markdown, "utf8"));
    assert.equal(result.path, path.join(root, "session-a", "research", "summary.md"));
    assert.equal(await readArtifact("session-a", "research/summary.md", root), markdown);
    await writeArtifact("session-a", "research/summary.md", "Updated summary", root);
    assert.equal(await readArtifact("session-a", "research/summary.md", root), "Updated summary");

    const json = JSON.stringify({ answer: 42, verified: true }, null, 2);
    const jsonResult = await writeArtifact("session-a", "data/result.json", json, root);
    assert.equal(jsonResult.bytes, Buffer.byteLength(json, "utf8"));
    assert.equal(await readArtifact("session-a", "data/result.json", root), json);
    assert.deepEqual(await listArtifacts("session-a", root), ["data/result.json", "research/summary.md"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("artifact sessions are isolated and missing files return a friendly error", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    await writeArtifact("session-a", "private/notes.md", "Session A only", root);
    await assert.rejects(
      readArtifact("session-b", "private/notes.md", root),
      /Artifact file not found: private\/notes\.md/,
    );
    await assert.rejects(
      readArtifact("session-b", "../session-a/private/notes.md", root),
      /Path traversal forbidden/,
    );
    assert.deepEqual(await listArtifacts("session-b", root), []);

    await writeArtifact(undefined, "default.txt", "default session", root);
    assert.equal(await readArtifact(undefined, "default.txt", root), "default session");
    await assert.rejects(readArtifact("session-a", "default.txt", root), /Artifact file not found/);
    await assert.rejects(readArtifact("session-a", "missing.txt", root), /Artifact file not found: missing\.txt/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("artifact paths reject traversal, absolute paths, and unsafe session identifiers", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    assert.throws(() => resolveArtifactPath("session-a", "../package.json", root), /Path traversal forbidden/);
    assert.throws(() => resolveArtifactPath("session-a", "/etc/passwd", root), /Path traversal forbidden/);
    assert.throws(() => resolveArtifactPath("session-a", "nested/../../package.json", root), /Path traversal forbidden/);
    assert.throws(() => resolveArtifactPath("../session-a", "safe.txt", root), /Path traversal forbidden/);
    await assert.rejects(writeArtifact("session-a", "/etc/passwd", "no", root), /Path traversal forbidden/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("artifact reads enforce the 1 MiB limit and reject oversized writes", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    await writeArtifact("large", "seed.txt", "seed", root);
    const largePath = resolveArtifactPath("large", "large.txt", root);
    await writeFile(largePath, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
    await assert.rejects(readArtifact("large", "large.txt", root), /exceeds the .* read limit/);
    await assert.rejects(
      writeArtifact("large", "too-large.txt", "x".repeat(MAX_ARTIFACT_BYTES + 1), root),
      /exceeds the .* write limit/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("artifact reads and writes reject symlinks that point outside the session", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  const { temp, root } = await tempArtifactsRoot();
  try {
    const outside = path.join(temp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside secret");
    await writeArtifact("session-a", "seed.txt", "safe", root);
    const sessionDir = path.join(root, "session-a");
    await symlink(path.join(outside, "secret.txt"), path.join(sessionDir, "secret-link.txt"));
    await symlink(outside, path.join(sessionDir, "directory-link"), "dir");

    await assert.rejects(readArtifact("session-a", "secret-link.txt", root), /Path traversal forbidden/);
    await assert.rejects(readArtifact("session-a", "directory-link/secret.txt", root), /Path traversal forbidden/);
    await assert.rejects(writeArtifact("session-a", "secret-link.txt", "overwrite", root), /Path traversal forbidden/);
    await assert.rejects(writeArtifact("session-a", "directory-link/new.txt", "escape", root), /Path traversal forbidden/);
    assert.equal(await readArtifact("session-a", "seed.txt", root), "safe");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("read_artifact and write_artifact tools are bound to their owning session", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    const ownerTools = createArtifactTools("owner-session", root);
    assert.deepEqual(ownerTools.map((tool) => tool.name), ["read_artifact", "write_artifact"]);
    const writeTool = ownerTools.find((tool) => tool.name === "write_artifact")!;
    const readTool = ownerTools.find((tool) => tool.name === "read_artifact")!;
    const writeResult = await writeTool.execute("write-call", { path: "research/summary.md", content: "Owner-only finding" });
    assert.match(writeResult.content[0].type === "text" ? writeResult.content[0].text : "", /18 bytes/);
    const readResult = await readTool.execute("read-call", { path: "research/summary.md" });
    assert.equal(readResult.content[0].type === "text" ? readResult.content[0].text : "", "Owner-only finding");

    const otherSessionRead = createArtifactTools("other-session", root).find((tool) => tool.name === "read_artifact")!;
    await assert.rejects(otherSessionRead.execute("other-call", { path: "research/summary.md" }), /Artifact file not found/);

    for (const ownerSessionId of [undefined, "", "   "]) {
      const fallbackTools = createArtifactTools(ownerSessionId, root);
      const fallbackWrite = fallbackTools.find((tool) => tool.name === "write_artifact")!;
      const fallbackRead = fallbackTools.find((tool) => tool.name === "read_artifact")!;
      await fallbackWrite.execute("default-write", { path: "fallback.md", content: "Default-isolated result" });
      const fallbackResult = await fallbackRead.execute("default-read", { path: "fallback.md" });
      assert.equal(fallbackResult.content[0].type === "text" ? fallbackResult.content[0].text : "", "Default-isolated result");
    }
    const namedSessionRead = createArtifactTools("owner-session", root).find((tool) => tool.name === "read_artifact")!;
    await assert.rejects(namedSessionRead.execute("named-read", { path: "fallback.md" }), /Artifact file not found/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
