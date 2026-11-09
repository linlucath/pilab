import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ARTIFACTS_ROOT = path.join(projectRoot, "artifacts");
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface ArtifactOptions {
  /** Workspace boundary used to validate leaf symlink targets. */
  workspaceRoot: string;
  /** The exact directory containing artifacts (not a parent keyed by session ID). */
  artifactsDir: string;
}

type ArtifactRoot = string | ArtifactOptions | undefined;

interface ArtifactLocation {
  root: string;
  sessionDir: string;
  resolvedPath: string;
  relativeFromSession: string;
  workspaceRoot?: string;
  relativeArtifactsDir?: string;
}

interface ArtifactBase {
  directory: string;
  workspaceRoot?: string;
}

function pathTraversalError(): Error {
  return new Error("Path traversal forbidden");
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isStrictlyWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function artifactLocations(sessionId: string | undefined, relativePath: string | undefined, artifactsRoot: ArtifactRoot): ArtifactLocation {
  const session = sessionId?.trim() || "default";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw pathTraversalError();

  let root: string;
  let sessionDir: string;
  let workspaceRoot: string | undefined;
  let relativeArtifactsDir: string | undefined;
  if (typeof artifactsRoot === "object" && artifactsRoot !== null) {
    if (!path.isAbsolute(artifactsRoot.workspaceRoot) || !path.isAbsolute(artifactsRoot.artifactsDir))
      throw pathTraversalError();
    workspaceRoot = path.resolve(artifactsRoot.workspaceRoot);
    root = path.resolve(artifactsRoot.artifactsDir);
    relativeArtifactsDir = path.relative(workspaceRoot, root);
    if (
      !relativeArtifactsDir || relativeArtifactsDir === ".." || relativeArtifactsDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeArtifactsDir)
    ) throw pathTraversalError();
    sessionDir = root;
  } else {
    root = path.resolve(artifactsRoot ?? DEFAULT_ARTIFACTS_ROOT);
    sessionDir = path.resolve(root, session);
    if (!isStrictlyWithin(root, sessionDir)) throw pathTraversalError();
  }

  if (relativePath === undefined)
    return { root, sessionDir, resolvedPath: sessionDir, relativeFromSession: "", workspaceRoot, relativeArtifactsDir };
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.includes("\0") || relativePath.includes("\\") || /^[A-Za-z]:/.test(relativePath))
    throw pathTraversalError();
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.split("/").includes(".."))
    throw pathTraversalError();

  const resolvedPath = path.resolve(sessionDir, relativePath);
  const relativeFromSession = path.relative(sessionDir, resolvedPath);
  if (
    !isStrictlyWithin(sessionDir, resolvedPath) ||
    !relativeFromSession ||
    relativeFromSession === ".." ||
    relativeFromSession.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromSession)
  ) throw pathTraversalError();

  return { root, sessionDir, resolvedPath, relativeFromSession, workspaceRoot, relativeArtifactsDir };
}

/** Resolve a session-relative artifact path after lexical containment checks. */
export function resolveArtifactPath(
  sessionId: string | undefined,
  relativePath: string,
  artifactsRoot: ArtifactRoot = DEFAULT_ARTIFACTS_ROOT,
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
  if (!isStrictlyWithin(realSessionDir, realTarget)) throw pathTraversalError();
}

async function getWorkspaceArtifactBase(location: ArtifactLocation, create: boolean): Promise<ArtifactBase | undefined> {
  const workspaceRoot = location.workspaceRoot!;
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await realpath(workspaceRoot);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!(await stat(realWorkspaceRoot)).isDirectory()) throw pathTraversalError();

  let current = realWorkspaceRoot;
  for (const part of location.relativeArtifactsDir!.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info = await lstatOrMissing(current);
    if (!info && !create) return undefined;
    if (!info) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      info = await lstatOrMissing(current);
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw pathTraversalError();
    current = await realpath(current);
    assertWithin(realWorkspaceRoot, current);
  }
  return { directory: current, workspaceRoot: realWorkspaceRoot };
}

async function getExistingArtifactBase(location: ArtifactLocation): Promise<ArtifactBase | undefined> {
  if (location.workspaceRoot) return getWorkspaceArtifactBase(location, false);
  const directory = await getExistingSessionDir(location.root, location.sessionDir);
  return directory ? { directory } : undefined;
}

async function ensureArtifactBase(location: ArtifactLocation): Promise<ArtifactBase> {
  if (location.workspaceRoot) return (await getWorkspaceArtifactBase(location, true))!;
  await ensureSessionDir(location.root, location.sessionDir);
  return { directory: location.sessionDir };
}

async function getExistingSessionDir(root: string, sessionDir: string): Promise<string | undefined> {
  if (!(await assertDirectory(root, true))) return undefined;
  if (!(await assertDirectory(sessionDir, true))) return undefined;
  const realRoot = await realpath(root);
  const realSessionDir = await realpath(sessionDir);
  if (!isStrictlyWithin(realRoot, realSessionDir)) throw pathTraversalError();
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
  if (!isStrictlyWithin(realRoot, realSessionDir)) throw pathTraversalError();
  return realSessionDir;
}

async function assertExistingArtifact(
  sessionDir: string,
  filePath: string,
  relativePath: string,
  workspaceRoot?: string,
): Promise<string> {
  const parts = relativePath.split(path.sep).filter(Boolean);
  let current = sessionDir;
  let leafSymlink = false;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstatOrMissing(current);
    if (!info) throw new Error(`Artifact file not found: ${relativePath}`);
    const isFinal = index === parts.length - 1;
    if (info.isSymbolicLink()) {
      if (!isFinal || !workspaceRoot) throw pathTraversalError();
      leafSymlink = true;
      try {
        const realTarget = await realpath(current);
        assertWithin(workspaceRoot, realTarget);
        if (!(await stat(realTarget)).isFile())
          throw new Error(`Artifact path is not a regular file: ${relativePath}`);
      } catch (error) {
        if (isMissingPathError(error)) throw new Error(`Artifact file not found: ${relativePath}`);
        throw error;
      }
    } else if (isFinal ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`Artifact path is not a ${isFinal ? "regular file" : "directory"}: ${relativePath}`);
    }
  }
  const realSessionDir = await realpath(sessionDir);
  let realFilePath: string;
  try {
    realFilePath = await realpath(filePath);
  } catch (error) {
    if (isMissingPathError(error)) throw new Error(`Artifact file not found: ${relativePath}`);
    throw error;
  }
  assertWithin(leafSymlink ? workspaceRoot! : realSessionDir, realFilePath);
  return realFilePath;
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

/** Read a UTF-8 text artifact, allowing only leaf symlinks that resolve inside the configured workspace. */
export async function readArtifact(
  sessionId: string | undefined,
  relativePath: string,
  artifactsRoot: ArtifactRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<string> {
  const location = artifactLocations(sessionId, relativePath, artifactsRoot);
  const base = await getExistingArtifactBase(location);
  if (!base) throw new Error(`Artifact file not found: ${relativePath}`);
  const filePath = path.join(base.directory, location.relativeFromSession);
  const realFilePath = await assertExistingArtifact(base.directory, filePath, location.relativeFromSession, base.workspaceRoot);

  let handle;
  try {
    handle = await open(realFilePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
  artifactsRoot: ArtifactRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<{ path: string; bytes: number }> {
  if (typeof content !== "string") throw new Error("Artifact content must be a string.");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES)
    throw new Error(`Artifact content exceeds the ${MAX_ARTIFACT_BYTES}-byte write limit.`);

  const location = artifactLocations(sessionId, relativePath, artifactsRoot);
  const base = await ensureArtifactBase(location);
  const filePath = await createSafeParents(base.directory, location.relativeFromSession);
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

/** A direct child returned by listArtifactEntries. */
export interface ArtifactEntry {
  name: string;
  type: "file" | "directory" | "link";
  size?: number;
}

/** List direct children of an artifact directory without following directory symlinks. */
export async function listArtifactEntries(
  directoryPath?: string,
  ownerSessionId?: string,
  artifactsRoot: string | ArtifactOptions = DEFAULT_ARTIFACTS_ROOT,
): Promise<ArtifactEntry[]> {
  const relativePath = directoryPath === undefined || directoryPath === "" ? undefined : directoryPath;
  const location = artifactLocations(ownerSessionId, relativePath, artifactsRoot);
  const base = await getExistingArtifactBase(location);
  if (!base) {
    if (!location.relativeFromSession) return [];
    throw new Error(`Artifact directory not found: ${directoryPath}`);
  }

  let directory = base.directory;
  if (location.relativeFromSession) {
    for (const part of location.relativeFromSession.split(path.sep)) {
      directory = path.join(directory, part);
      const info = await lstatOrMissing(directory);
      if (!info) throw new Error(`Artifact directory not found: ${directoryPath}`);
      if (info.isSymbolicLink() || !info.isDirectory()) throw pathTraversalError();
    }
    const realDirectory = await realpath(directory);
    assertWithin(base.directory, realDirectory);
    directory = realDirectory;
  }

  const entries: ArtifactEntry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, type: "directory" });
    } else if (entry.isFile()) {
      const info = await lstat(absolute);
      entries.push({ name: entry.name, type: "file", size: info.size });
    } else if (entry.isSymbolicLink()) {
      if (!base.workspaceRoot) throw pathTraversalError();
      try {
        const realTarget = await realpath(absolute);
        assertWithin(base.workspaceRoot, realTarget);
        const info = await stat(realTarget);
        if (!info.isFile()) throw pathTraversalError();
        entries.push({ name: entry.name, type: "link", size: info.size });
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
    } else {
      throw new Error(`Unsupported artifact entry: ${entry.name}`);
    }
  }
  return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

/** Recursively list regular artifact files relative to the current session artifacts directory. */
export async function listArtifacts(
  sessionId: string | undefined,
  artifactsRoot: ArtifactRoot = DEFAULT_ARTIFACTS_ROOT,
): Promise<string[]> {
  const location = artifactLocations(sessionId, undefined, artifactsRoot);
  const base = await getExistingArtifactBase(location);
  if (!base) return [];

  const files: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        if (!base.workspaceRoot) throw pathTraversalError();
        try {
          const realTarget = await realpath(absolute);
          assertWithin(base.workspaceRoot, realTarget);
          if (!(await stat(realTarget)).isFile()) throw pathTraversalError();
          files.push(relative.split(path.sep).join("/"));
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
      } else if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      else throw new Error(`Unsupported artifact entry: ${relative}`);
    }
  };
  await visit(base.directory, "");
  return files.sort();
}
