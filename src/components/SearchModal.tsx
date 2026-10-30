import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Search } from "lucide-react";
import type { Message } from "../../shared/schema";
import type { Session } from "../workspace-store";

type SearchEntry =
  | { key: string; kind: "chat"; session: Session; title: string }
  | { key: string; kind: "message"; session: Session; message: Message; title: string; preview: string; role: string };
type Props = {
  sessions: Session[];
  activeSessionId: string;
  onClose: () => void;
  onSelectSession: (id: string) => void;
  onJumpToMessage: (sessionId: string, messageId: string, query: string) => void;
};

type CompactedMessage = Message & { modelSummary?: string };
type SearchableSession = Session & { parentSessionTitle?: string };
const roleLabels: Record<Message["role"], string> = { user: "用户", assistant: "助手", system: "系统", developer: "开发者", tool: "工具" };

function snippet(text: string, query: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return normalized.slice(0, 90);
  const start = Math.max(0, index - 38);
  const end = Math.min(normalized.length, index + query.length + 48);
  return `${start ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
    part.toLocaleLowerCase() === query.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part,
  );
}

export function SearchModal({ sessions, activeSessionId, onClose, onSelectSession, onJumpToMessage }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const normalizedQuery = query.trim();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const recentSessions = useMemo(() => {
    const active = sessions.find((session) => session.id === activeSessionId);
    return [active, ...sessions.filter((session) => session.id !== activeSessionId).slice().reverse()]
      .filter((session): session is Session => !!session)
      .slice(0, 5);
  }, [sessions, activeSessionId]);

  const entries = useMemo<SearchEntry[]>(() => {
    if (!lowerQuery) return recentSessions.map((session) => ({ key: `chat:${session.id}`, kind: "chat", session, title: session.title || "未命名对话" }));

    const chatEntries: SearchEntry[] = sessions.flatMap((session) => {
      const title = session.title || "未命名对话";
      const searchable = `${title} ${(session as SearchableSession).parentSessionTitle || ""} ${session.settings.workingDirectory}`.toLocaleLowerCase();
      return searchable.includes(lowerQuery) ? [{ key: `chat:${session.id}`, kind: "chat", session, title }] : [];
    });
    const messageEntries: SearchEntry[] = sessions.flatMap((session) => session.messages.flatMap((message) => {
      const compacted = message as CompactedMessage;
      const content = message.content || "";
      const summary = compacted.modelSummary || "";
      const searchable = `${content}\n${summary}`.toLocaleLowerCase();
      if (!searchable.includes(lowerQuery)) return [];
      const source = content.toLocaleLowerCase().includes(lowerQuery) ? content : summary;
      return [{ key: `message:${session.id}:${message.id}`, kind: "message" as const, session, message, title: session.title || "未命名对话", preview: snippet(source, normalizedQuery), role: roleLabels[message.role] }];
    }));
    return [...chatEntries, ...messageEntries].slice(0, 80);
  }, [lowerQuery, normalizedQuery, recentSessions, sessions]);

  useEffect(() => { setSelectedIndex(0); }, [normalizedQuery]);
  useEffect(() => { setSelectedIndex((current) => Math.min(current, Math.max(0, entries.length - 1))); }, [entries.length]);

  const activate = (entry: SearchEntry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === "chat") onSelectSession(entry.session.id);
    else onJumpToMessage(entry.session.id, entry.message.id, normalizedQuery);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown" && entries.length) { event.preventDefault(); setSelectedIndex((index) => (index + 1) % entries.length); }
    else if (event.key === "ArrowUp" && entries.length) { event.preventDefault(); setSelectedIndex((index) => (index - 1 + entries.length) % entries.length); }
    else if (event.key === "Enter") { event.preventDefault(); activate(entries[selectedIndex]); }
  };

  const overlay = <div className="search-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="search-modal" role="dialog" aria-modal="true" aria-label="搜索聊天或消息" onKeyDown={handleKeyDown}>
      <label className="search-modal-input">
        <Search size={16} aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话或消息正文…" aria-label="搜索聊天或消息正文" />
      </label>
      <div className="search-modal-results" role="listbox" aria-label="搜索结果" aria-activedescendant={entries[selectedIndex] ? `search-result-${selectedIndex}` : undefined}>
        {!lowerQuery && <>
          <div className="search-modal-hint">输入关键词搜索会话或消息正文</div>
          {entries.length > 0 && <section className="search-modal-group" aria-label="最近会话">
            <div className="search-modal-section-label">最近会话</div>
            {entries.map((entry, index) => <button id={`search-result-${index}`} key={entry.key} type="button" role="option" aria-selected={selectedIndex === index} className={`search-modal-item search-modal-chat search-modal-recent ${selectedIndex === index ? "is-selected" : ""}`} onMouseEnter={() => setSelectedIndex(index)} onClick={() => activate(entry)}>
              <span className="search-modal-item-copy"><strong>{entry.title}</strong></span>
            </button>)}
          </section>}
        </>}
        {lowerQuery && entries.length > 0 && <>
          {entries.some((entry) => entry.kind === "chat") && <section className="search-modal-group" aria-label="会话">
            <div className="search-modal-section-label">会话</div>
            {entries.map((entry, index) => entry.kind === "chat" ? <button id={`search-result-${index}`} key={entry.key} type="button" role="option" aria-selected={selectedIndex === index} className={`search-modal-item search-modal-chat ${selectedIndex === index ? "is-selected" : ""}`} onMouseEnter={() => setSelectedIndex(index)} onClick={() => activate(entry)}>
              <span className="search-modal-item-icon"><MessageSquare size={16} /></span><span className="search-modal-item-copy"><strong><Highlight text={entry.title} query={normalizedQuery} /></strong></span>
            </button> : null)}
          </section>}
          {entries.some((entry) => entry.kind === "message") && <section className="search-modal-group" aria-label="消息">
            <div className="search-modal-section-label">消息</div>
            {entries.map((entry, index) => entry.kind === "message" ? <button id={`search-result-${index}`} key={entry.key} type="button" role="option" aria-selected={selectedIndex === index} className={`search-modal-item search-modal-message ${selectedIndex === index ? "is-selected" : ""}`} onMouseEnter={() => setSelectedIndex(index)} onClick={() => activate(entry)}>
              <span className="search-modal-item-icon"><MessageSquare size={16} /></span><span className="search-modal-item-copy"><strong><span className="search-modal-message-title">{entry.title}</span><span className="search-modal-message-separator" aria-hidden="true">·</span><small className="search-modal-message-role">{entry.role}</small></strong><small className="search-modal-preview"><Highlight text={entry.preview} query={normalizedQuery} /></small></span>
            </button> : null)}
          </section>}
        </>}
        {lowerQuery && !entries.length && <div className="search-modal-empty">没有匹配结果</div>}
      </div>
      {lowerQuery && <footer className="search-modal-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span><small>{entries.length} 个结果</small></footer>}
    </section>
  </div>;

  return createPortal(overlay, document.body);
}
