import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
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

test("read_artifact numbers lines, supports pagination, and uses Pi truncation limits", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    await writeArtifact("session-a", "pages.txt", "one\ntwo\nthree\nfour", root);
    const readTool = createArtifactTools("session-a", root).find((tool) => tool.name === "read_artifact")!;
    const page = await readTool.execute("page", { path: "pages.txt", offset: 2, limit: 1 });
    assert.equal(page.content[0].type === "text" ? page.content[0].text : "", "2 | two\n\n[2 more lines in file. Use offset=3 to continue.]");
    const lastPage = await readTool.execute("last-page", { path: "pages.txt", offset: 3, limit: 2 });
    assert.equal(lastPage.content[0].type === "text" ? lastPage.content[0].text : "", "3 | three\n4 | four");
    await assert.rejects(readTool.execute("bad-offset", { path: "pages.txt", offset: 5 }), /beyond end of file/);

    const manyLines = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, index) => `line-${index + 1}`).join("\n");
    await writeArtifact("session-a", "many-lines.txt", manyLines, root);
    const lineResult = await readTool.execute("many-lines", { path: "many-lines.txt" });
    const lineText = lineResult.content[0].type === "text" ? lineResult.content[0].text : "";
    assert.match(lineText, new RegExp(`\\[Showing lines 1-${DEFAULT_MAX_LINES} of ${DEFAULT_MAX_LINES + 5}\\.`));
    assert.doesNotMatch(lineText, new RegExp(`${DEFAULT_MAX_LINES + 1} \\| line-${DEFAULT_MAX_LINES + 1}`));

    const manyBytes = Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(9_000)}`).join("\n");
    await writeArtifact("session-a", "many-bytes.txt", manyBytes, root);
    const byteResult = await readTool.execute("many-bytes", { path: "many-bytes.txt" });
    const byteText = byteResult.content[0].type === "text" ? byteResult.content[0].text : "";
    const body = byteText.split("\n\n[Showing lines", 1)[0];
    assert.ok(Buffer.byteLength(body, "utf8") <= DEFAULT_MAX_BYTES);
    assert.match(byteText, /50\.0KB limit/);

    await writeArtifact("session-a", "huge-line.txt", `${"x".repeat(DEFAULT_MAX_BYTES + 10)}\nnext`, root);
    const hugeResult = await readTool.execute("huge-line", { path: "huge-line.txt" });
    const hugeText = hugeResult.content[0].type === "text" ? hugeResult.content[0].text : "";
    assert.match(hugeText, /^\[Line 1 is .* exceeds 50\.0KB limit\.\]$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("read_artifact handles empty files and rejects invalid page bounds", async () => {
  const { temp, root } = await tempArtifactsRoot();
  try {
    const readTool = createArtifactTools("session-a", root).find((tool) => tool.name === "read_artifact")!;
    await writeArtifact("session-a", "empty.txt", "", root);
    const empty = await readTool.execute("empty", { path: "empty.txt", offset: 1 });
    assert.equal(empty.content[0].type === "text" ? empty.content[0].text : "", "");
    await assert.rejects(readTool.execute("empty-oob", { path: "empty.txt", offset: 2 }), /beyond end of file/);

    await writeArtifact("session-a", "one-line.txt", "line", root);
    await assert.rejects(readTool.execute("zero-offset", { path: "one-line.txt", offset: 0 }), /Offset must be a positive integer/);
    await assert.rejects(readTool.execute("zero-limit", { path: "one-line.txt", limit: 0 }), /Limit must be a positive integer/);
    await assert.rejects(readTool.execute("fractional-offset", { path: "one-line.txt", offset: 1.5 }), /Offset must be a positive integer/);
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
    assert.equal(readResult.content[0].type === "text" ? readResult.content[0].text : "", "1 | Owner-only finding");

    const otherSessionRead = createArtifactTools("other-session", root).find((tool) => tool.name === "read_artifact")!;
    await assert.rejects(otherSessionRead.execute("other-call", { path: "research/summary.md" }), /Artifact file not found/);

    for (const ownerSessionId of [undefined, "", "   "]) {
      const fallbackTools = createArtifactTools(ownerSessionId, root);
      const fallbackWrite = fallbackTools.find((tool) => tool.name === "write_artifact")!;
      const fallbackRead = fallbackTools.find((tool) => tool.name === "read_artifact")!;
      await fallbackWrite.execute("default-write", { path: "fallback.md", content: "Default-isolated result" });
      const fallbackResult = await fallbackRead.execute("default-read", { path: "fallback.md" });
      assert.equal(fallbackResult.content[0].type === "text" ? fallbackResult.content[0].text : "", "1 | Default-isolated result");
    }
    const namedSessionRead = createArtifactTools("owner-session", root).find((tool) => tool.name === "read_artifact")!;
    await assert.rejects(namedSessionRead.execute("named-read", { path: "fallback.md" }), /Artifact file not found/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
