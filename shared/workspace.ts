import { z } from "zod";
import { fileSchema } from "./schema";

const id = z.string().min(1).max(200);
export const savedSessionSchema = fileSchema.omit({ version: true }).extend({
  id,
  piSync: z.object({
    id, sessionId: id.optional(), revision: z.string().max(200),
    dirty: z.boolean(), pending: id.optional(),
  }).optional(),
  reviewedWorkerSignatures: z.array(z.string().max(5_000)).max(1_000).optional(),
});
// This is the persisted experiment-session model used by the current workspace store.
export const experimentSessionSchema = savedSessionSchema;
export type ExperimentSession = SavedSession;
export const workspaceDataSchema = z.object({
  sessions: z.array(savedSessionSchema).max(500), active: id,
  hiddenPiSessions: z.array(id).default([]), followPi: z.boolean().default(false),
});
export const projectWorkspaceSchema = workspaceDataSchema.extend({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  deletedSessionIds: z.array(id).default([]),
});
export const workspaceChangesSchema = z.object({
  baseRevision: z.number().int().nonnegative().optional(),
  sessions: z.array(savedSessionSchema.partial().required({ id: true })).default([]),
  removed: z.array(id).default([]),
  hidden: z.array(id).default([]), restored: z.array(id).default([]),
  active: id.optional(), followPi: z.boolean().optional(),
});
export type SavedSession = z.infer<typeof savedSessionSchema>;
export type WorkspaceData = z.infer<typeof workspaceDataSchema>;
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>;
export type WorkspaceChanges = z.infer<typeof workspaceChangesSchema>;

export function piSessionIdentity(sync: { id: string; sessionId?: string }) {
  return sync.sessionId || sync.id.replace(/-\d+$/, "");
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
type DataRecord = Record<string, unknown>;
function mergeField<T>(base: T, local: T, remote: T): T {
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;
  // On a same-field conflict keep the value written most recently to disk.
  return remote;
}
function mergeRecord(base: DataRecord = {}, local: DataRecord, remote: DataRecord): DataRecord {
  const merged: DataRecord = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const before = base[key], left = local[key], right = remote[key];
    let value: unknown;
    if (key === "messages" && Array.isArray(left) && Array.isArray(right))
      value = mergeMessages(Array.isArray(before) ? before as SavedSession["messages"] : [], left as SavedSession["messages"], right as SavedSession["messages"]);
    else if (key === "reviewedWorkerSignatures" && Array.isArray(left) && Array.isArray(right))
      value = [...new Set([...right, ...left])].slice(-1_000);
    else if (["settings", "piSync"].includes(key) && left && right && typeof left === "object" && typeof right === "object")
      value = mergeRecord(before && typeof before === "object" ? before as DataRecord : {}, left as DataRecord, right as DataRecord);
    else value = mergeField(before, left, right);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
function mergeMessages(base: SavedSession["messages"], local: SavedSession["messages"], remote: SavedSession["messages"]): SavedSession["messages"] {
  const before = new Map(base.map((message) => [message.id, message]));
  const left = new Map(local.map((message) => [message.id, message]));
  const right = new Map(remote.map((message) => [message.id, message]));
  const baseOrder = base.map((message) => message.id);
  const localOrder = local.map((message) => message.id);
  const remoteOrder = remote.map((message) => message.id);
  // Keep a one-sided reorder; concurrent reorder conflicts prefer the latest remote order.
  const localReordered = !equal(baseOrder.filter((id) => left.has(id)), localOrder.filter((id) => before.has(id)));
  const remoteReordered = !equal(baseOrder.filter((id) => right.has(id)), remoteOrder.filter((id) => before.has(id)));
  const primary = localReordered && !remoteReordered ? localOrder : remoteOrder;
  const secondary = primary === localOrder ? remoteOrder : localOrder;
  const primaryIds = new Set(primary);
  const order = [...primary, ...secondary.filter((id) => !primaryIds.has(id))];
  const merged: SavedSession["messages"] = [];
  for (const id of order) {
    const b = before.get(id), l = left.get(id), r = right.get(id);
    if (!b) {
      const item = l && r ? mergeRecord({}, l as DataRecord, r as DataRecord) : l || r;
      if (item) merged.push(item as SavedSession["messages"][number]);
    } else if (!l && r) {
      if (!equal(r, b)) merged.push(r);
    } else if (!r && l) {
      if (!equal(l, b)) merged.push(l);
    } else if (l && r) merged.push(mergeRecord(b as DataRecord, l as DataRecord, r as DataRecord) as SavedSession["messages"][number]);
  }
  return merged;
}
function mergeSession(base: SavedSession | undefined, local: SavedSession, remote: SavedSession): SavedSession {
  return savedSessionSchema.parse(mergeRecord(base as DataRecord | undefined, local as DataRecord, remote as DataRecord));
}
function mergeMembership(base: string[], local: string[], remote: string[]) {
  const before = new Set(base), left = new Set(local), right = new Set(remote);
  return [...new Set([...base, ...local, ...remote])].filter((id) => mergeField(before.has(id), left.has(id), right.has(id)));
}

/** Three-way merge a stale local workspace onto the newest on-disk revision. */
export function mergeProjectWorkspace(base: ProjectWorkspace, local: ProjectWorkspace, remote: ProjectWorkspace): ProjectWorkspace {
  const deletedSessionIds = [...new Set([...local.deletedSessionIds, ...remote.deletedSessionIds])];
  const deleted = new Set(deletedSessionIds);
  const before = new Map(base.sessions.map((session) => [session.id, session]));
  const left = new Map(local.sessions.map((session) => [session.id, session]));
  const right = new Map(remote.sessions.map((session) => [session.id, session]));
  const ids = [...remote.sessions.map((session) => session.id), ...local.sessions.map((session) => session.id).filter((id) => !right.has(id))];
  const sessions: SavedSession[] = [];
  for (const id of ids) {
    if (deleted.has(id)) continue;
    const b = before.get(id), l = left.get(id), r = right.get(id);
    if (!b && l && r) sessions.push(mergeSession(undefined, l, r));
    else if (!b && (l || r)) sessions.push((l || r)!);
    else if (b && !l && r) { if (!equal(r, b)) sessions.push(r); }
    else if (b && !r && l) { if (!equal(l, b)) sessions.push(l); }
    else if (l && r) sessions.push(mergeSession(b, l, r));
  }
  const hiddenPiSessions = mergeMembership(base.hiddenPiSessions, local.hiddenPiSessions, remote.hiddenPiSessions);
  const hidden = new Set(hiddenPiSessions);
  const visibleSessions = sessions.filter((session) => !session.piSync || !hidden.has(piSessionIdentity(session.piSync)));
  const selected = mergeField(base.active, local.active, remote.active);
  const active = visibleSessions.some((session) => session.id === selected)
    ? selected
    : visibleSessions.some((session) => session.id === remote.active) ? remote.active : visibleSessions[0]?.id || selected;
  return projectWorkspaceSchema.parse({
    ...remote, revision: Math.max(local.revision, remote.revision) + 1,
    sessions: visibleSessions, active, hiddenPiSessions, deletedSessionIds,
    followPi: mergeField(base.followPi, local.followPi, remote.followPi),
  });
}

export function applyWorkspaceChanges(workspace: ProjectWorkspace, changes: WorkspaceChanges): ProjectWorkspace {
  const deleted = new Set([...workspace.deletedSessionIds, ...changes.removed]);
  const hidden = new Set([...workspace.hiddenPiSessions, ...changes.hidden]);
  for (const session of workspace.sessions)
    if (deleted.has(session.id) && session.piSync) hidden.add(piSessionIdentity(session.piSync));
  for (const restored of changes.restored) hidden.delete(restored);
  const sessions = new Map(workspace.sessions.map((session) => [session.id, session]));
  for (const patch of changes.sessions) {
    if (deleted.has(patch.id)) continue;
    const candidate = savedSessionSchema.parse({ ...sessions.get(patch.id), ...patch });
    if (candidate.piSync && hidden.has(piSessionIdentity(candidate.piSync))) continue;
    sessions.set(candidate.id, candidate);
  }
  for (const [id, session] of sessions)
    if (deleted.has(id) || (session.piSync && hidden.has(piSessionIdentity(session.piSync)))) sessions.delete(id);
  const active = changes.active ?? workspace.active;
  return projectWorkspaceSchema.parse({
    ...workspace, revision: workspace.revision + 1,
    sessions: [...sessions.values()], active: sessions.has(active) ? active : sessions.keys().next().value || active,
    hiddenPiSessions: [...hidden], deletedSessionIds: [...deleted],
    followPi: changes.followPi ?? workspace.followPi,
  });
}
