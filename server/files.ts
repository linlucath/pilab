import { lstat, mkdir, open, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_WORKSPACE_FILE_BYTES } from "../shared/schema";
import { ensureSessionWorkspace } from "./session-workspaces";

export class WorkspaceFileUploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WorkspaceFileUploadError";
  }
}

async function validateWorkspaceDirectory(workingDirectory: unknown) {
  if (typeof workingDirectory !== "string" || !path.isAbsolute(workingDirectory))
    throw new WorkspaceFileUploadError("工作目录必须是存在的绝对路径目录。");
  try {
    const canonicalDirectory = await realpath(workingDirectory);
    if (!(await stat(canonicalDirectory)).isDirectory())
      throw new WorkspaceFileUploadError("工作目录必须是存在的绝对路径目录。");
    return canonicalDirectory;
  } catch (error) {
    if (error instanceof WorkspaceFileUploadError) throw error;
    throw new WorkspaceFileUploadError("工作目录必须是存在的绝对路径目录。");
  }
}

export async function resolveWorkspaceUploadDirectory(sessionId: unknown, workingDirectory?: string) {
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200)
    throw new WorkspaceFileUploadError("sessionId 必须是 1 到 200 个字符。");
  if (workingDirectory === undefined)
    return ensureSessionWorkspace(sessionId);
  return validateWorkspaceDirectory(workingDirectory);
}

function safeFileName(input: unknown) {
  if (typeof input !== "string")
    throw new WorkspaceFileUploadError("请提供要上传的文件名。");
  // Browsers may send Windows-style paths even when the server runs on POSIX.
  const name = path.basename(input.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name === "." || name === "..")
    throw new WorkspaceFileUploadError("文件名无效。");
  if (Buffer.byteLength(name, "utf8") > 255)
    throw new WorkspaceFileUploadError("文件名过长（最多 255 字节）。");
  return name;
}

function numberedName(name: string, index: number) {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  return `${stem} (${index})${extension}`;
}

async function createWorkspaceArtifactLink(workspace: string, fileName: string, destination: string) {
  const artifactsDirectory = path.join(workspace, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(artifactsDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
    throw new WorkspaceFileUploadError("工作区 artifacts 路径必须是普通目录。");

  const relativeTarget = path.relative(artifactsDirectory, destination);
  for (let index = 0; index < 10_000; index++) {
    const artifactName = index === 0 ? fileName : numberedName(fileName, index);
    const artifactPath = path.join(artifactsDirectory, artifactName);
    let existing;
    try {
      existing = await lstat(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!existing) {
      try {
        await symlink(relativeTarget, artifactPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (["EACCES", "ENOSYS", "EPERM"].includes(code || "")) {
          console.warn(`Unable to create workspace artifact symlink; uploaded file was kept: ${artifactPath}`, error);
          return true;
        }
        throw error;
      }
    }
    // Keep regular files and existing links intact; try a numbered link name instead.
    if (!existing.isSymbolicLink()) return false;
    let currentTarget: string;
    try {
      currentTarget = await readlink(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (path.resolve(artifactsDirectory, currentTarget) === destination) return true;
    // This link belongs to another file; preserve it and try the next numbered name.
    continue;
  }
  throw new Error("无法安全创建工作区 artifacts 文件链接。");
}

export async function saveWorkspaceFile(directory: string, inputName: unknown, data: unknown) {
  if (!Buffer.isBuffer(data))
    throw new WorkspaceFileUploadError("上传文件内容无效。");
  if (data.byteLength > MAX_WORKSPACE_FILE_BYTES)
    throw new WorkspaceFileUploadError("单个文件不能超过 50 MiB。", 413);

  const fileName = safeFileName(inputName);
  const canonicalDirectory = await validateWorkspaceDirectory(directory);
  for (let index = 0; index < 10_000; index++) {
    const candidateName = index === 0 ? fileName : numberedName(fileName, index);
    const destination = path.join(canonicalDirectory, candidateName);
    let handle;
    try {
      // Exclusive creation prevents overwriting files, including concurrent uploads.
      handle = await open(destination, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      throw error;
    }

    try {
      await handle.writeFile(data);
      await handle.close();
      const linked = await createWorkspaceArtifactLink(canonicalDirectory, candidateName, destination);
      if (!linked) {
        await unlink(destination);
        continue;
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    return {
      success: true as const,
      fileName: candidateName,
      relativePath: path.relative(canonicalDirectory, destination),
      size: data.byteLength,
    };
  }
  throw new WorkspaceFileUploadError("无法为文件分配不重复的名称，请检查工作目录。", 409);
}
