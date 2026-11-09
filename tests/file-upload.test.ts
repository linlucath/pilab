import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_WORKSPACE_FILE_BYTES } from "../shared/schema";
import { resolveWorkspaceUploadDirectory, saveWorkspaceFile, WorkspaceFileUploadError } from "../server/files";

async function withTempDirectory(run: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pilab-file-upload-"));
  const directory = path.join(root, "workspace");
  await mkdir(directory);
  try { await run(root, directory); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("workspace file upload writes bytes and creates a relative artifacts symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  await withTempDirectory(async (_root, directory) => {
    const content = Buffer.from("first line\nsecond line\n");
    const result = await saveWorkspaceFile(directory, "notes.txt", content);
    assert.deepEqual(result, { success: true, fileName: "notes.txt", relativePath: "notes.txt", size: content.length });
    const destination = path.join(directory, result.fileName);
    const artifactLink = path.join(directory, "artifacts", result.fileName);
    assert.deepEqual(await readFile(destination), content);
    assert.deepEqual(await readFile(artifactLink), content);
    assert.equal(await readlink(artifactLink), path.relative(path.dirname(artifactLink), destination));
  });
});

test("workspace file upload increments duplicate names without overwriting", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  await withTempDirectory(async (_root, directory) => {
    await writeFile(path.join(directory, "data.csv"), "keep original");
    const first = await saveWorkspaceFile(directory, "data.csv", Buffer.from("one"));
    const second = await saveWorkspaceFile(directory, "data.csv", Buffer.from("two"));
    assert.equal(first.fileName, "data (1).csv");
    assert.equal(second.fileName, "data (2).csv");
    assert.equal(await readFile(path.join(directory, "data.csv"), "utf8"), "keep original");
    assert.equal(await readFile(path.join(directory, first.fileName), "utf8"), "one");
    assert.equal(await readFile(path.join(directory, second.fileName), "utf8"), "two");
  });
});

test("workspace file upload preserves an existing artifacts file and chooses a free linked name", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  await withTempDirectory(async (_root, directory) => {
    const artifactsDirectory = path.join(directory, "artifacts");
    await mkdir(artifactsDirectory);
    await writeFile(path.join(artifactsDirectory, "report.txt"), "existing artifact");
    const result = await saveWorkspaceFile(directory, "report.txt", Buffer.from("uploaded"));
    assert.equal(result.fileName, "report (1).txt");
    assert.equal(await readFile(path.join(artifactsDirectory, "report.txt"), "utf8"), "existing artifact");
    assert.equal(await readFile(path.join(artifactsDirectory, result.fileName), "utf8"), "uploaded");
  });
});

test("workspace upload keeps a conflicting artifacts symlink and creates a numbered link", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  await withTempDirectory(async (_root, directory) => {
    const artifactsDirectory = path.join(directory, "artifacts");
    await mkdir(artifactsDirectory);
    await writeFile(path.join(directory, "existing-target.txt"), "keep linked target");
    await symlink("../existing-target.txt", path.join(artifactsDirectory, "report.txt"));

    const result = await saveWorkspaceFile(directory, "report.txt", Buffer.from("uploaded"));
    assert.equal(result.fileName, "report.txt");
    assert.equal(await readlink(path.join(artifactsDirectory, "report.txt")), "../existing-target.txt");
    assert.equal(await readFile(path.join(artifactsDirectory, "report.txt"), "utf8"), "keep linked target");
    assert.equal(await readlink(path.join(artifactsDirectory, "report (1).txt")), "../report.txt");
    assert.equal(await readFile(path.join(artifactsDirectory, "report (1).txt"), "utf8"), "uploaded");
  });
});

test("workspace file upload rejects files over 50 MiB before writing", async () => {
  await withTempDirectory(async (_root, directory) => {
    const oversized = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1);
    await assert.rejects(
      saveWorkspaceFile(directory, "large.bin", oversized),
      (error: unknown) => error instanceof WorkspaceFileUploadError && error.status === 413 && /50 MiB/.test(error.message),
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test("workspace file upload strips traversal components from POSIX and Windows names", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symlink creation may require elevated privileges on Windows.");
    return;
  }
  await withTempDirectory(async (root, directory) => {
    const result = await saveWorkspaceFile(directory, "../../escape.txt", Buffer.from("safe"));
    const windowsResult = await saveWorkspaceFile(directory, "..\\..\\windows-escape.txt", Buffer.from("safe too"));
    assert.equal(result.fileName, "escape.txt");
    assert.equal(windowsResult.fileName, "windows-escape.txt");
    assert.deepEqual((await readdir(directory)).sort(), ["artifacts", "escape.txt", "windows-escape.txt"]);
    await assert.rejects(readFile(path.join(root, "escape.txt")));
    assert.equal(await readFile(path.join(directory, result.relativePath), "utf8"), "safe");
  });
});

test("workspace upload directories must be absolute existing directories; missing targets bind to isolated session workspaces", async () => {
  await withTempDirectory(async (root, directory) => {
    assert.equal(await resolveWorkspaceUploadDirectory("test-session", directory), await realpath(directory));
    await assert.rejects(resolveWorkspaceUploadDirectory("test-session", "relative/path"), /绝对路径目录/);
    await assert.rejects(resolveWorkspaceUploadDirectory("test-session", path.join(root, "missing")), /绝对路径目录/);

    const previous = process.env.PI_LAB_WORKSPACES_DIR;
    process.env.PI_LAB_WORKSPACES_DIR = path.join(root, "session-workspaces");
    try {
      const first = await resolveWorkspaceUploadDirectory("test-session");
      const second = await resolveWorkspaceUploadDirectory("test-session");
      assert.equal(first, second);
      assert.equal(path.dirname(first), await realpath(path.join(root, "session-workspaces")));
    } finally {
      if (previous === undefined) delete process.env.PI_LAB_WORKSPACES_DIR;
      else process.env.PI_LAB_WORKSPACES_DIR = previous;
    }
  });
});
