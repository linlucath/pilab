import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "../shared/schema";
import { applyWorkspaceChanges, mergeProjectWorkspace, projectWorkspaceSchema, workspaceChangesSchema, workspaceDataSchema, type ProjectWorkspace } from "../shared/workspace";

type FileSignature = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };

function sameSignature(left: FileSignature | null, right: FileSignature | null) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export class ProjectWorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private latest?: ProjectWorkspace;
  private diskSignature: FileSignature | null = null;
  private snapshots = new Map<number, ProjectWorkspace>();
  constructor(private file: string) {}
  private async signature(): Promise<FileSignature | null> {
    try {
      const file = await stat(this.file, { bigint: true });
      return {
        dev: String(file.dev), ino: String(file.ino), size: String(file.size),
        mtimeNs: String(file.mtimeNs), ctimeNs: String(file.ctimeNs),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private remember(workspace: ProjectWorkspace) {
    this.latest = workspace;
    this.snapshots.set(workspace.revision, workspace);
    while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private async read(): Promise<ProjectWorkspace | null> {
    while (true) {
      const before = await this.signature();
      let contents: string;
      try { contents = await readFile(this.file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const after = await this.signature();
          if (after) continue;
          this.diskSignature = null;
          return null;
        }
        throw new Error("项目会话文件无法读取，请检查 .pi-lab/workspace.json。", { cause: error });
      }
      const after = await this.signature();
      if (!sameSignature(before, after)) continue;
      try {
        const stored = JSON.parse(contents) as Record<string, unknown>;
        const workspace = projectWorkspaceSchema.parse(stored);
        this.diskSignature = after;
        if (stored.version !== workspace.version || !Array.isArray(stored.folders) || !Array.isArray(stored.rootSessionIds))
          await this.write(workspace);
        return workspace;
      } catch (error) {
        throw new Error("项目会话文件无法读取，请检查 .pi-lab/workspace.json。", { cause: error });
      }
    }
  }
  private async write(workspace: ProjectWorkspace) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(workspace, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      this.diskSignature = await this.signature();
    } finally { await unlink(temporary).catch(() => {}); }
  }
  getRevision() {
    return this.exclusive(async () => {
      const signature = await this.signature();
      if (!signature) {
        this.latest = undefined;
        this.snapshots.clear();
        this.diskSignature = null;
        return null;
      }
      if (this.latest && sameSignature(signature, this.diskSignature)) return this.latest.revision;
      const workspace = await this.read();
      if (!workspace) return null;
      this.remember(workspace);
      return workspace.revision;
    });
  }
  get() {
    return this.exclusive(async () => {
      const workspace = await this.read();
      if (workspace) this.remember(workspace);
      return workspace;
    });
  }
  flush() { return this.queue.then(() => {}); }
  reset() {
    return this.exclusive(async () => {
      await unlink(this.file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      this.latest = undefined;
      this.diskSignature = null;
      this.snapshots.clear();
    });
  }
  initialize(input: unknown) {
    return this.exclusive(async () => {
      const existing = await this.read();
      if (existing) { this.remember(existing); return existing; }
      const workspace = projectWorkspaceSchema.parse({
        ...workspaceDataSchema.parse(input), version: 2, revision: 1, deletedSessionIds: [],
      });
      await this.write(workspace);
      this.remember(workspace);
      return workspace;
    });
  }
  appendRunMessages(sessionId: string, messages: Message[]) {
    return this.exclusive(async () => {
      const workspace = await this.read();
      if (!workspace) throw new Error("项目会话尚未初始化。");
      const session = workspace.sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error(`目标会话不存在：${sessionId}`);
      if (!messages.length) { this.remember(workspace); return workspace; }
      const sessions = workspace.sessions.map((item) => {
        if (item.id !== sessionId) return item;
        // The browser streams partial assistant messages into workspace storage too;
        // final generated messages must upsert by ID rather than create duplicates.
        const merged = new Map(item.messages.map((message) => [message.id, message]));
        for (const message of messages)
          merged.set(message.id, { ...merged.get(message.id), ...message });
        return { ...item, messages: [...merged.values()].slice(-500) };
      });
      const updated = projectWorkspaceSchema.parse({
        ...workspace, revision: workspace.revision + 1, sessions,
      });
      await this.write(updated);
      this.remember(updated);
      return updated;
    });
  }
  update(input: unknown) {
    return this.exclusive(async () => {
      const disk = await this.read();
      if (!disk) throw new Error("项目会话尚未初始化。");
      const changes = workspaceChangesSchema.parse(input);
      const cached = changes.baseRevision === undefined
        ? this.latest
        : this.snapshots.get(changes.baseRevision);
      const base = cached && cached.revision <= disk.revision ? cached : disk;
      const local = applyWorkspaceChanges(base, changes);
      const updated = disk.revision > base.revision
        ? mergeProjectWorkspace(base, local, disk)
        : local;
      await this.write(updated);
      this.remember(updated);
      return updated;
    });
  }
}
