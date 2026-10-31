import { open, realpath, stat, unlink } from "node:fs/promises";
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
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return {
      success: true as const,
      fileName: candidateName,
      relativePath: path.relative(canonicalDirectory, destination),
      size: data.byteLength,
    };
  }
  throw new WorkspaceFileUploadError("无法为文件分配不重复的名称，请检查工作目录。", 409);
}
