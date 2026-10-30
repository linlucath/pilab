import { useCallback, useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { Message, Settings } from "../shared/schema";
import { applyWorkspaceChanges, projectWorkspaceSchema, savedSessionSchema, type ProjectWorkspace, type SavedSession, type WorkspaceChanges, type WorkspaceData } from "../shared/workspace";

export type Run = {
  id: string; at: number; status: string; output: string; thinking: string;
  request?: unknown; requests?: unknown[]; trace?: Message[]; turns?: number; cwd?: string;
  usage?: { input: number; output: number }; elapsed: number; error?: string;
  snapshot: { settings: Settings; messages: Message[] };
};
export type Session = Omit<SavedSession, "settings"> & { settings: Settings; runs: Run[] };
export type WorkspaceFolder = { id: string; name: string; collapsed: boolean; sessionIds: string[] };
export type Workspace = { sessions: Session[]; active: string; hiddenPiSessions: string[]; followPi: boolean; folders: WorkspaceFolder[]; rootSessionIds: string[] };

function saved(workspace: Workspace): WorkspaceData {
  return {
    sessions: workspace.sessions.map((session) => savedSessionSchema.parse(session)),
    active: workspace.active, hiddenPiSessions: workspace.hiddenPiSessions, followPi: workspace.followPi,
    folders: workspace.folders, rootSessionIds: workspace.rootSessionIds,
  };
}
function changes(before: WorkspaceData, after: WorkspaceData): WorkspaceChanges {
  const previous = new Map(before.sessions.map((session) => [session.id, session]));
  const ids = new Set(after.sessions.map((session) => session.id));
  return {
    sessions: after.sessions.flatMap((session) => {
      const old = previous.get(session.id);
      if (!old) return [session];
      const patch: Record<string, unknown> = { id: session.id };
      for (const key of ["title", "messages", "settings", "piSync", "reviewedWorkerSignatures"] as const)
        if (JSON.stringify(old[key]) !== JSON.stringify(session[key])) patch[key] = session[key];
      return Object.keys(patch).length > 1 ? [patch as WorkspaceChanges["sessions"][number]] : [];
    }),
    removed: before.sessions.filter((session) => !ids.has(session.id)).map((session) => session.id),
    hidden: after.hiddenPiSessions.filter((id) => !before.hiddenPiSessions.includes(id)),
    restored: before.hiddenPiSessions.filter((id) => !after.hiddenPiSessions.includes(id)),
    ...(before.active !== after.active ? { active: after.active } : {}),
    ...(before.followPi !== after.followPi ? { followPi: after.followPi } : {}),
    ...(JSON.stringify(before.folders) !== JSON.stringify(after.folders) ? { folders: after.folders } : {}),
    ...(JSON.stringify(before.rootSessionIds) !== JSON.stringify(after.rootSessionIds) ? { rootSessionIds: after.rootSessionIds } : {}),
  };
}
function changed(delta: WorkspaceChanges) {
  return delta.sessions.length || delta.removed.length || delta.hidden.length || delta.restored.length ||
    delta.active !== undefined || delta.followPi !== undefined || delta.folders !== undefined || delta.rootSessionIds !== undefined;
}

export function useProjectWorkspace(loadLegacy: () => Workspace, fresh: () => Session, notify: (message: string) => void) {
  const [workspace, setReactWorkspace] = useState(loadLegacy);
  const workspaceRef = useRef(workspace);
  const setWorkspace = useCallback((update: SetStateAction<Workspace>) => {
    const current = workspaceRef.current;
    const next = typeof update === "function" ? update(current) : update;
    if (next !== current) {
      // Keep event handlers and in-flight streams on the newest queued workspace,
      // rather than waiting for React to commit before another update reads it.
      workspaceRef.current = next;
      setReactWorkspace(next);
    }
    return next;
  }, []);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const baseline = useRef<WorkspaceData | null>(null);
  const revision = useRef(0);
  const saving = useRef(false);
  const alive = useRef(true);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function projectView(project: ProjectWorkspace, local?: Workspace): Workspace {
    const sessions = project.sessions.map((session) => ({
      ...session, settings: { ...session.settings, apiKey: "" },
      runs: local?.sessions.find((item) => item.id === session.id)?.runs || [],
    }));
    if (!sessions.length) sessions.push(fresh());
    const sessionIds = new Set(sessions.map((session) => session.id));
    const assigned = new Set<string>();
    const folders = project.folders.map((folder) => {
      const folderSessions = folder.sessionIds.filter((id) => sessionIds.has(id) && !assigned.has(id));
      folderSessions.forEach((id) => assigned.add(id));
      return { ...folder, sessionIds: folderSessions };
    });
    const rootSessionIds = project.rootSessionIds.filter((id) => sessionIds.has(id) && !assigned.has(id));
    rootSessionIds.forEach((id) => assigned.add(id));
    for (const session of sessions) if (!assigned.has(session.id)) rootSessionIds.push(session.id);
    const active = local && sessions.some((session) => session.id === local.active) ? local.active : project.active;
    return {
      sessions, active: sessions.some((session) => session.id === active) ? active : sessions[0].id,
      hiddenPiSessions: project.hiddenPiSessions, followPi: project.followPi, folders, rootSessionIds,
    };
  }
  async function request(method: string, body?: unknown) {
    const response = await fetch(method === "PATCH" ? "/api/workspace/changes" : "/api/workspace", {
      method, cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "项目会话保存失败。");
    return data.workspace ? projectWorkspaceSchema.parse(data.workspace) : null;
  }
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const project = await request("GET") || await request("POST", saved(workspaceRef.current));
        if (cancelled || !project) return;
        const next = projectView(project);
        baseline.current = { ...saved(next), sessions: project.sessions };
        revision.current = project.revision;
        setWorkspace(next);
        setReady(true);
      } catch (error) { if (!cancelled) setError((error as Error).message); }
    })();
    return () => { cancelled = true; alive.current = false; clearTimeout(retry.current); };
  }, []);

  async function flush() {
    if (!alive.current || saving.current || !baseline.current) return;
    let sent: WorkspaceData;
    let delta: WorkspaceChanges;
    try {
      sent = saved(workspaceRef.current);
      delta = { ...changes(baseline.current, sent), baseRevision: revision.current };
    } catch {
      setStatus("error");
      return;
    }
    if (!changed(delta)) return;
    saving.current = true;
    setStatus("saving");
    let succeeded = false;
    try {
      const project = await request("PATCH", delta);
      if (!alive.current || !project) return;
      const pending = changes(sent, saved(workspaceRef.current));
      const projected = applyWorkspaceChanges(project, pending);
      const next = projectView(projected, workspaceRef.current);
      baseline.current = { ...project, active: next.active };
      // A local selection made during this request must also be saved.
      if (pending.active !== undefined) baseline.current.active = project.active;
      revision.current = project.revision;
      setWorkspace(next);
      setStatus("saved");
      succeeded = true;
    } catch (error) {
      if (alive.current) { setStatus("error"); notify(`保存失败：${(error as Error).message}`); }
    } finally {
      saving.current = false;
      if (alive.current) {
        clearTimeout(retry.current);
        retry.current = setTimeout(() => void flush(), succeeded ? 0 : 5_000);
      }
    }
  }
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => void flush(), 150);
    return () => clearTimeout(timer);
  }, [workspace, ready]);

  useEffect(() => {
    if (!ready) return;
    let polling = false;
    let cancelled = false;
    const poll = async () => {
      if (polling || saving.current || !baseline.current) return;
      try {
        if (changed(changes(baseline.current, saved(workspaceRef.current)))) return;
        polling = true;
        const project = await request("GET");
        if (cancelled || !project || project.revision === revision.current || saving.current ||
          changed(changes(baseline.current!, saved(workspaceRef.current)))) return;
        const next = projectView(project, workspaceRef.current);
        baseline.current = { ...project, active: next.active };
        revision.current = project.revision;
        setWorkspace(next);
      } catch { /* Keep the local draft and retry when the server becomes available. */ }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void flush(); void poll(); }, 2_000);
    const finish = () => {
      if (!baseline.current) return;
      try {
        const delta = { ...changes(baseline.current, saved(workspaceRef.current)), baseRevision: revision.current };
        if (changed(delta)) navigator.sendBeacon("/api/workspace/changes", new Blob([JSON.stringify(delta)], { type: "application/json" }));
      } catch { /* Invalid draft parameters cannot replace the last valid saved workspace. */ }
    };
    window.addEventListener("pagehide", finish);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("pagehide", finish); };
  }, [ready]);
  return { workspace, setWorkspace, workspaceRef, ready, error, status };
}
