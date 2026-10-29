import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronRight, Copy, Folder, FolderOpen, FolderPlus, MessageSquare, Pencil, Plus, Search, Trash2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Session, WorkspaceFolder } from "../workspace-store";

type DropTarget = { kind: "session"; folderId: string | null; sessionId: string; position: "before" | "after" } | { kind: "root" | "folder"; folderId: string | null };
type Props = {
  sessions: Session[]; folders: WorkspaceFolder[]; rootSessionIds: string[]; active: string; collapsed: boolean; activeRuns: Map<string, string>;
  onToggle: () => void; onCreate: () => void; onCreateFolder: (name: string) => void; onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void; onDuplicate: (session: Session) => void; onDelete: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void; onDeleteFolder: (id: string) => void; onToggleFolder: (id: string) => void;
  onMoveSession: (id: string, folderId: string | null, targetId?: string, position?: "before" | "after" | "end") => void;
};

export function Sidebar({ sessions, folders, rootSessionIds, active, collapsed, activeRuns, onToggle, onCreate, onCreateFolder, onSelect, onRename, onDuplicate, onDelete, onRenameFolder, onDeleteFolder, onToggleFolder, onMoveSession }: Props) {
  const [search, setSearch] = useState("");
  const [draggedId, setDraggedId] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const editingFolderRef = useRef<string | null>(null);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const query = search.trim().toLowerCase();
  const matchesSession = (session: Session) => !query || `${session.title} ${session.parentSessionTitle || ""} ${session.settings.workingDirectory}`.toLowerCase().includes(query);
  const rootSessions = rootSessionIds.map((id) => sessionById.get(id)).filter((session): session is Session => !!session && matchesSession(session));
  const folderSessions = (folder: WorkspaceFolder) => {
    const ids = query && folder.name.toLowerCase().includes(query) ? folder.sessionIds : folder.sessionIds.filter((id) => {
      const session = sessionById.get(id);
      return !!session && matchesSession(session);
    });
    return ids.map((id) => sessionById.get(id)).filter((session): session is Session => !!session);
  };
  const visibleFolders = folders.filter((folder) => !query || folder.name.toLowerCase().includes(query) || folderSessions(folder).length > 0);
  const hasMatches = rootSessions.length > 0 || visibleFolders.length > 0;

  const beginFolderEdit = (id: string, name: string) => {
    setSearch("");
    editingFolderRef.current = id;
    setFolderDraft(name);
    setEditingFolderId(id);
  };
  const finishFolderEdit = (id: string, value: string) => {
    if (editingFolderRef.current !== id) return;
    editingFolderRef.current = null;
    const name = value.trim();
    if (name) onRenameFolder(id, name);
    setEditingFolderId(null);
    setFolderDraft("");
  };
  const cancelFolderEdit = (id: string) => {
    if (editingFolderRef.current !== id) return;
    editingFolderRef.current = null;
    setEditingFolderId(null);
    setFolderDraft("");
  };
  useEffect(() => {
    if (collapsed || !editingFolderId) return;
    folderInputRef.current?.focus();
    folderInputRef.current?.select();
  }, [collapsed, editingFolderId]);

  const startDrag = (event: DragEvent<HTMLElement>, session: Session) => {
    if (event.target instanceof HTMLElement && event.target.closest(".session-row-actions")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", session.id);
    setDraggedId(session.id);
  };
  const dropOnSession = (event: DragEvent<HTMLElement>, sessionId: string, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const id = draggedId || event.dataTransfer.getData("text/plain");
    if (!id || id === sessionId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    onMoveSession(id, folderId, sessionId, position);
    setDraggedId("");
    setDropTarget(null);
  };
  const rowDragOver = (event: DragEvent<HTMLElement>, sessionId: string, folderId: string | null) => {
    if (!draggedId || draggedId === sessionId) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropTarget((current) => current?.kind === "session" && current.folderId === folderId && current.sessionId === sessionId && current.position === position
      ? current : { kind: "session", folderId, sessionId, position });
  };
  const dropAtEnd = (event: DragEvent<HTMLElement>, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const id = draggedId || event.dataTransfer.getData("text/plain");
    if (id) onMoveSession(id, folderId, undefined, "end");
    setDraggedId("");
    setDropTarget(null);
  };
  const sessionRow = (session: Session, folderId: string | null) => {
    const target = dropTarget?.kind === "session" && dropTarget.sessionId === session.id && dropTarget.folderId === folderId ? dropTarget.position : "";
    const running = activeRuns.has(session.id);
    return <article key={session.id} data-session-id={session.id} draggable
      onDragStart={(event) => startDrag(event, session)} onDragEnd={() => { setDraggedId(""); setDropTarget(null); }}
      onDragOver={(event) => rowDragOver(event, session.id, folderId)} onDrop={(event) => dropOnSession(event, session.id, folderId)}
      className={`session-row ${session.id === active ? "selected" : ""} ${draggedId === session.id ? "is-dragging" : ""} ${target ? `drop-${target}` : ""}`}>
      <button className="session-main" onClick={() => onSelect(session.id)} aria-label={session.title || "未命名对话"} title={[session.parentSessionTitle ? `${session.title} · 派生自 ${session.parentSessionTitle}` : session.title, session.settings.workingDirectory].filter(Boolean).join(" · ")}>
        <span className="session-initial" aria-hidden="true"><MessageSquare size={15} /></span><span className="session-copy"><strong><span className="session-title-text">{session.title || "未命名对话"}</span>{running && <span className="session-running-indicator" role="img" aria-label="后台运行中" title="后台运行中" />}</strong></span>
      </button>
      {!collapsed && <div className="session-row-actions">
        <button className="icon-button" title="重命名" aria-label={`重命名 ${session.title}`} onClick={() => { const title = window.prompt("会话名称", session.title); if (title?.trim()) onRename(session.id, title.trim()); }}><Pencil size={13} /></button>
        <button className="icon-button" title="复制会话" aria-label={`复制 ${session.title}`} onClick={() => onDuplicate(session)}><Copy size={13} /></button>
        <button className="icon-button danger" title={running ? "运行期间不能删除会话" : "删除会话"} aria-label={`删除 ${session.title}`} disabled={running} onClick={() => onDelete(session.id)}><Trash2 size={13} /></button>
      </div>}
    </article>;
  };

  return <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="会话列表">
    <div className="sidebar-brand-row">
      <div className="brand-mark">π</div>
      {!collapsed && <strong>Pi Lab</strong>}
      <button className="icon-button sidebar-collapse" onClick={onToggle} title={collapsed ? "展开侧栏" : "收起侧栏"} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}>
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
    </div>
    <div className="sidebar-create-row">
      <button className="new-conversation" onClick={onCreate} title="新建对话" aria-label="新建对话">
        <Plus size={17} />{!collapsed && <span>新建对话</span>}
      </button>
      <button className="icon-button new-folder-button" onClick={() => { setSearch(""); onCreateFolder("新建文件夹"); }} title="新建文件夹" aria-label="新建文件夹"><FolderPlus size={17} /></button>
    </div>
    {!collapsed && <label className="session-search"><Search size={15} /><input placeholder="搜索会话" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索会话" />{search && <button onClick={() => setSearch("")} aria-label="清除搜索">×</button>}</label>}
    <div className="session-list" aria-label="已保存会话">
      <section className={`session-group root-session-group ${dropTarget?.kind === "root" ? "drop-hover" : ""}`} onDragOver={(event) => { if (draggedId) { event.preventDefault(); setDropTarget((current) => current?.kind === "root" ? current : { kind: "root", folderId: null }); } }} onDrop={(event) => dropAtEnd(event, null)}>
        {rootSessions.map((session) => sessionRow(session, null))}
      </section>
      {visibleFolders.map((folder) => {
        const children = folderSessions(folder);
        const isDropTarget = dropTarget?.kind === "folder" && dropTarget.folderId === folder.id;
        const isEditing = editingFolderId === folder.id && !collapsed;
        return <section className="session-group sidebar-folder" key={folder.id} data-folder-id={folder.id}>
          <div className={`folder-heading ${isDropTarget ? "drop-hover" : ""}`} onDragOver={(event) => { if (draggedId) { event.preventDefault(); setDropTarget((current) => current?.kind === "folder" && current.folderId === folder.id ? current : { kind: "folder", folderId: folder.id }); } }} onDrop={(event) => dropAtEnd(event, folder.id)}>
            {isEditing ? <div className="folder-toggle folder-editing">
              <ChevronRight className={`folder-chevron ${folder.collapsed ? "is-collapsed" : "is-expanded"}`} size={13} />{folder.collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
              <input ref={folderInputRef} className="folder-name-input" aria-label="文件夹名称" autoComplete="off" maxLength={120} value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} onBlur={(event) => finishFolderEdit(folder.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishFolderEdit(folder.id, event.currentTarget.value); } if (event.key === "Escape") { event.preventDefault(); cancelFolderEdit(folder.id); } }} />
            </div> : <button className="folder-toggle" onClick={() => onToggleFolder(folder.id)} aria-expanded={!folder.collapsed} title={folder.name}>
              <ChevronRight className={`folder-chevron ${folder.collapsed ? "is-collapsed" : "is-expanded"}`} size={13} />{folder.collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}<span className="folder-name">{folder.name}</span><small className="folder-count">{folder.sessionIds.length}</small>
            </button>}
            {!collapsed && !isEditing && <div className="sidebar-folder-actions">
              <button className="icon-button" title={`重命名文件夹 ${folder.name}`} aria-label={`重命名文件夹 ${folder.name}`} onClick={() => beginFolderEdit(folder.id, folder.name)}><Pencil size={12} /></button>
              <button className="icon-button danger" title={`删除文件夹 ${folder.name}`} aria-label={`删除文件夹 ${folder.name}`} onClick={() => { if (window.confirm(`删除文件夹「${folder.name}」？其中的会话会移回未归类。`)) onDeleteFolder(folder.id); }}><Trash2 size={12} /></button>
            </div>}
          </div>
          {!collapsed && !folder.collapsed && <div className="folder-children">{children.map((session) => sessionRow(session, folder.id))}</div>}
        </section>;
      })}
      {!hasMatches && <div className="sidebar-empty">{collapsed ? "·" : "没有匹配的会话"}</div>}
    </div>
  </aside>;
}
