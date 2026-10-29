import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function sessionWorkspaceRoot() {
  return path.resolve(process.env.PI_LAB_WORKSPACES_DIR?.trim() || path.join(os.homedir(), ".pi-lab", "workspaces"));
}

const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function ensureSessionWorkspace(sessionId: unknown, root = sessionWorkspaceRoot()) {
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200)
    throw new Error("会话工作区 ID 无效。");

  const directoryName = UUID_SESSION_ID.test(sessionId) ? sessionId.toLowerCase() : createHash("sha256").update(sessionId).digest("hex");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const target = path.join(canonicalRoot, directoryName);
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const canonicalTarget = await realpath(target);
  if (path.dirname(canonicalTarget) !== canonicalRoot || path.basename(canonicalTarget) !== directoryName)
    throw new Error("会话工作区路径不安全。");
  if (!(await stat(canonicalTarget)).isDirectory())
    throw new Error("会话工作区不是目录。");
  return canonicalTarget;
}
