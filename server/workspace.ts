import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "../shared/schema";
import { applyWorkspaceChanges, mergeProjectWorkspace, projectWorkspaceSchema, workspaceChangesSchema, workspaceDataSchema, type ProjectWorkspace } from "../shared/workspace";

export class ProjectWorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private latest?: ProjectWorkspace;
  private snapshots = new Map<number, ProjectWorkspace>();
  constructor(private file: string) {}
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
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      const workspace = projectWorkspaceSchema.parse(stored);
      if (stored.version !== workspace.version || !Array.isArray(stored.folders) || !Array.isArray(stored.rootSessionIds))
        await this.write(workspace);
      return workspace;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("项目会话文件无法读取，请检查 .pi-lab/workspace.json。", { cause: error });
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
    } finally { await unlink(temporary).catch(() => {}); }
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
      const sessions = workspace.sessions.map((item) => item.id === sessionId
        ? { ...item, messages: [...item.messages, ...messages].slice(-500) }
        : item);
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
