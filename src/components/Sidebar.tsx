import { useMemo, useState } from "react";
import { Copy, Pencil, Plus, Search, Trash2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Session } from "../workspace-store";
import { folderName } from "../utils/session";

type Props = {
  sessions: Session[]; active: string; collapsed: boolean; disabled?: boolean;
  onToggle: () => void; onCreate: () => void; onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void; onDuplicate: (session: Session) => void; onDelete: (id: string) => void;
};

export function Sidebar({ sessions, active, collapsed, disabled, onToggle, onCreate, onSelect, onRename, onDuplicate, onDelete }: Props) {
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessions.filter((session) => !query || `${session.title} ${session.parentSessionTitle || ""} ${session.settings.workingDirectory}`.toLowerCase().includes(query));
  }, [sessions, search]);
  return <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="会话列表">
    <div className="sidebar-brand-row">
      <div className="brand-mark">π</div>
      {!collapsed && <strong>Pi Lab</strong>}
      <button className="icon-button sidebar-collapse" onClick={onToggle} title={collapsed ? "展开侧栏" : "收起侧栏"} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}>
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
    </div>
    <button className="new-conversation" disabled={disabled} onClick={onCreate} title="新建对话">
      <Plus size={17} />{!collapsed && <><span>新建对话</span><kbd>⌘ N</kbd></>}
    </button>
    {!collapsed && <label className="session-search"><Search size={15} /><input placeholder="搜索会话" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索会话" />{search && <button onClick={() => setSearch("")} aria-label="清除搜索">×</button>}</label>}
    <div className="session-list" aria-label="已保存会话" style={{ gap: 2 }}>
      {visible.map((session) => <article key={session.id} className={`session-row ${session.id === active ? "selected" : ""}`} style={{ border: 0, boxShadow: "none", borderRadius: 8, background: session.id === active ? "var(--surface)" : undefined }}>
        <button className="session-main" disabled={disabled} onClick={() => onSelect(session.id)} title={session.parentSessionTitle ? `${session.title} · 派生自 ${session.parentSessionTitle}` : session.title} style={{ padding: "7px 8px", gap: 8 }}>
          {collapsed ? <span className="session-initial">{session.title.slice(0, 1) || "对"}</span> : <span className="session-copy" style={{ gap: 2 }}><strong>{session.title || "未命名对话"}</strong><small title={`${folderName(session.settings.workingDirectory)} · ${session.messages.length} 条`}>📁 {folderName(session.settings.workingDirectory)} · {session.messages.length} 条</small></span>}
        </button>
        {!collapsed && <div className="session-row-actions">
          <button className="icon-button" title="重命名" aria-label={`重命名 ${session.title}`} disabled={disabled} onClick={() => { const title = window.prompt("会话名称", session.title); if (title?.trim()) onRename(session.id, title.trim()); }}><Pencil size={13} /></button>
          <button className="icon-button" title="复制会话" aria-label={`复制 ${session.title}`} disabled={disabled} onClick={() => onDuplicate(session)}><Copy size={13} /></button>
          <button className="icon-button danger" title="删除会话" aria-label={`删除 ${session.title}`} disabled={disabled} onClick={() => onDelete(session.id)}><Trash2 size={13} /></button>
        </div>}
      </article>)}
      {!visible.length && <div className="sidebar-empty">{collapsed ? "·" : "没有匹配的会话"}</div>}
    </div>
    {!collapsed && <footer className="sidebar-footer"><span className="live-dot" />本地工作区<span className="footer-spacer" />自动保存</footer>}
  </aside>;
}
