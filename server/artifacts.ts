import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ARTIFACTS_ROOT = path.join(projectRoot, "artifacts");
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

function pathTraversalError(): Error {
  return new Error("Path traversal forbidden");
}

function artifactLocations(sessionId: string | undefined, relativePath: string, artifactsRoot: string) {
  const session = sessionId?.trim() || "default";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw pathTraversalError();

  const root = path.resolve(artifactsRoot);
  const sessionDir = path.resolve(root, session);
  if (!sessionDir.startsWith(`${root}${path.sep}`)) throw pathTraversalError();

  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.includes("\0") || relativePath.includes("\\") || /^[A-Za-z]:/.test(relativePath))
    throw pathTraversalError();
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.split("/").includes(".."))
    throw pathTraversalError();

  const resolvedPath = path.resolve(sessionDir, relativePath);
  const relativeFromSession = path.relative(sessionDir, resolvedPath);
  if (
    !resolvedPath.startsWith(`${sessionDir}${path.sep}`) ||
    !relativeFromSession ||
    relativeFromSession === ".." ||
    relativeFromSession.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromSession)
  ) throw pathTraversalError();

  return { root, sessionDir, resolvedPath, relativeFromSession };
}

/** Resolve a session-relative artifact path after lexical containment checks. */
export function resolveArtifactPath(
  sessionId: string | undefined,
  relativePath: string,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
): string {
  return artifactLocations(sessionId, relativePath, artifactsRoot).resolvedPath;
}

async function lstatOrMissing(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertDirectory(target: string, allowMissing: boolean): Promise<boolean> {
  const info = await lstatOrMissing(target);
  if (!info) {
    if (allowMissing) return false;
    throw new Error("Artifact file not found.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw pathTraversalError();
  return true;
}

function assertWithin(realSessionDir: string, realTarget: string) {
  if (!realTarget.startsWith(`${realSessionDir}${path.sep}`)) throw pathTraversalError();
}

async function getExistingSessionDir(root: string, sessionDir: string): Promise<string | undefined> {
  if (!(await assertDirectory(root, true))) return undefined;
  if (!(await assertDirectory(sessionDir, true))) return undefined;
  const realRoot = await realpath(root);
  const realSessionDir = await realpath(sessionDir);
  if (!realSessionDir.startsWith(`${realRoot}${path.sep}`)) throw pathTraversalError();
  return realSessionDir;
}

async function ensureSessionDir(root: string, sessionDir: string): Promise<string> {
  await assertDirectory(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root, false);

  await assertDirectory(sessionDir, true);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await assertDirectory(sessionDir, false);

  const realRoot = await realpath(root);
  const realSessionDir = await realpath(sessionDir);
  if (!realSessionDir.startsWith(`${realRoot}${path.sep}`)) throw pathTraversalError();
  return realSessionDir;
}

async function assertExistingArtifact(sessionDir: string, filePath: string, relativePath: string) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  let current = sessionDir;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstatOrMissing(current);
    if (!info) throw new Error(`Artifact file not found: ${relativePath}`);
    if (info.isSymbolicLink()) throw pathTraversalError();
    const isFinal = index === parts.length - 1;
    if (isFinal ? !info.isFile() : !info.isDirectory())
      throw new Error(`Artifact path is not a ${isFinal ? "regular file" : "directory"}: ${relativePath}`);
  }
  const realSessionDir = await realpath(sessionDir);
  const realFilePath = await realpath(filePath);
  assertWithin(realSessionDir, realFilePath);
}

async function createSafeParents(sessionDir: string, relativeFromSession: string): Promise<string> {
  const parts = relativeFromSession.split(path.sep).filter(Boolean);
  if (!parts.length) throw pathTraversalError();
  let current = sessionDir;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    await assertDirectory(current, true);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertDirectory(current, false);
    const realDirectory = await realpath(current);
    const realSessionDir = await realpath(sessionDir);
    assertWithin(realSessionDir, realDirectory);
  }
  return path.join(sessionDir, ...parts);
}

/** Read a UTF-8 text artifact, refusing symlinks and files larger than 1 MiB. */
export async function readArtifact(
  sessionId: string | undefined,
  relativePath: string,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<string> {
  const location = artifactLocations(sessionId, relativePath, artifactsRoot);
  const realSessionDir = await getExistingSessionDir(location.root, location.sessionDir);
  if (!realSessionDir) throw new Error(`Artifact file not found: ${relativePath}`);
  await assertExistingArtifact(location.sessionDir, location.resolvedPath, location.relativeFromSession);

  let handle;
  try {
    handle = await open(location.resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || ""))
      throw new Error(`Artifact file not found: ${relativePath}`);
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw pathTraversalError();
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Artifact path is not a regular file: ${relativePath}`);
    if (info.nlink > 1) throw pathTraversalError();
    if (info.size > MAX_ARTIFACT_BYTES)
      throw new Error(`Artifact file exceeds the ${MAX_ARTIFACT_BYTES}-byte read limit: ${relativePath}`);
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ARTIFACT_BYTES)
      throw new Error(`Artifact file exceeds the ${MAX_ARTIFACT_BYTES}-byte read limit: ${relativePath}`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new Error(`Artifact file is not valid UTF-8 text: ${relativePath}`);
    }
  } finally {
    await handle.close();
  }
}

/** Write a UTF-8 text artifact, creating safe parent directories as needed. */
function splitArtifactLines(content: string) {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Number and bound text returned by the read_artifact tool, using Pi's native truncation limits. */
export function formatArtifactRead(content: string, offset?: number, limit?: number): string {
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1))
    throw new Error("Offset must be a positive integer.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error("Limit must be a positive integer.");

  const lines = splitArtifactLines(content);
  const start = (offset ?? 1) - 1;
  if (start >= Math.max(lines.length, 1))
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total).`);

  const selected = lines.slice(start, limit === undefined ? undefined : start + limit);
  const numbered = selected.map((line, index) => `${start + index + 1} | ${line}`).join("\n");
  const truncation = truncateHead(numbered);
  const totalLines = lines.length;
  let output = truncation.content;

  if (truncation.firstLineExceedsLimit) {
    const size = Buffer.byteLength(numbered.split("\n", 1)[0] ?? "", "utf8");
    output = `[Line ${start + 1} is ${formatSize(size)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
  } else if (truncation.truncated) {
    const end = start + truncation.outputLines;
    const nextOffset = end + 1;
    output += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${start + 1}-${end} of ${totalLines}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${start + 1}-${end} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
  } else if (limit !== undefined && start + selected.length < totalLines) {
    const remaining = totalLines - (start + selected.length);
    output += `\n\n[${remaining} more lines in file. Use offset=${start + selected.length + 1} to continue.]`;
  }
  return output;
}

export async function writeArtifact(
  sessionId: string | undefined,
  relativePath: string,
  content: string,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<{ path: string; bytes: number }> {
  if (typeof content !== "string") throw new Error("Artifact content must be a string.");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES)
    throw new Error(`Artifact content exceeds the ${MAX_ARTIFACT_BYTES}-byte write limit.`);

  const location = artifactLocations(sessionId, relativePath, artifactsRoot);
  await ensureSessionDir(location.root, location.sessionDir);
  const filePath = await createSafeParents(location.sessionDir, location.relativeFromSession);
  const existing = await lstatOrMissing(filePath);
  if (existing?.isSymbolicLink()) throw pathTraversalError();
  if (existing && !existing.isFile()) throw new Error(`Artifact path is not a regular file: ${relativePath}`);
  if (existing && existing.nlink > 1) throw pathTraversalError();

  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw pathTraversalError();
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) throw pathTraversalError();
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  return { path: filePath, bytes };
}

/** List regular artifact files relative to the current session directory. */
export async function listArtifacts(
  sessionId: string | undefined,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<string[]> {
  const session = sessionId?.trim() || "default";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw pathTraversalError();
  const root = path.resolve(artifactsRoot);
  const sessionDir = path.resolve(root, session);
  if (!sessionDir.startsWith(`${root}${path.sep}`)) throw pathTraversalError();
  const realSessionDir = await getExistingSessionDir(root, sessionDir);
  if (!realSessionDir) return [];

  const files: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw pathTraversalError();
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      else throw new Error(`Unsupported artifact entry: ${relative}`);
    }
  };
  await visit(sessionDir, "");
  return files.sort();
}
