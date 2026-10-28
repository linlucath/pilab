import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowUp, BookOpen, Brain, ChevronDown, Clock, Copy, Cpu, Dna, Eye, EyeOff, GitBranch, Image as ImageIcon, MessageSquarePlus, Pencil, Plus, Search, Send, Sparkles, Terminal, Trash2, UserRound, Wrench, X } from "lucide-react";
import { roles, type Message, type ToolCall } from "../../shared/schema";
import type { GptSessionSummary } from "../../shared/gpt-sessions";
import { Markdown } from "./Markdown";
import { parseToolArguments, toolTitle } from "../utils/session";
import { wireToolCallId } from "../../shared/tool-history";

type Props = {
  sessionId: string; scrollRequest: number;
  messages: Message[]; busy: boolean; compactTools: boolean; streamingId?: string;
  streamingThinking?: string; toolActivity?: { name: string; arguments: unknown; output: string } | null;
  gptWorkers?: GptSessionSummary[];
  lineage?: { parentSessionId: string; parentSessionTitle?: string; forkSummary?: string };
  forkNotice?: { forkId: string; title: string };
  onSwitchFork?: (id: string) => void;
  onJumpToSession?: (id: string) => void; onFork: () => void;
  onMessage: (id: string, patch: Partial<Message>) => void; onCopy: (text: string) => void;
  onCall: (message: Message, index: number, patch: Partial<ToolCall>) => void;
  onAdd: (after?: number, role?: Message["role"]) => void;
  onMove: (index: number, delta: number) => void; onDelete: (id: string) => void;
  onDeleteCall: (assistantId: string, callId: string) => void;
  onBranch: (message: Message, index: number) => void;
  directoryOpen?: boolean; onDirectoryOpenChange?: (open: boolean) => void;
  archiveRequest?: number; onArchiveableGroupsChange?: (count: number) => void;
};

type CompactedMessage = Message & { compactedByModel?: boolean; modelSummary?: string };
const activeWorkerStatuses = new Set(["starting", "running", "waiting_input"]);
const imageUrl = (file: string) => `/api/images/file?file=${encodeURIComponent(file)}`;
function roleName(role: Message["role"]) { return ({ system: "System", developer: "Developer", user: "You", assistant: "Gemini", tool: "Tool result" })[role]; }
function systemWakeNotice(content: string) {
  const match = /^后台 GPT 工兵已交卷：(.+?)。请使用 gpt_session_read/.exec(content.trim());
  return match ? `📬 系统通知：工兵${match[1]}已交卷` : undefined;
}
function roleIcon(role: Message["role"]) { return role === "system" ? <Cpu size={14} /> : role === "assistant" ? <Sparkles size={14} /> : role === "tool" ? <Terminal size={14} /> : <UserRound size={14} />; }
function toolIcon(name: string) {
  if (name === "session_fork") return <Dna size={13} />;
  if (name === "gpt_session_create") return <Sparkles size={13} />;
  if (name === "gpt_session_send") return <Send size={13} />;
  if (name === "gpt_session_wait") return <Clock size={13} />;
  if (name === "gpt_session_read") return <BookOpen size={13} />;
  if (name === "view_images" || name === "list_images") return <ImageIcon size={13} />;
  return <Wrench size={13} />;
}

function SystemPromptBanner({ messages, startIndex, onMessage, onAdd, onDelete, disabled }: { messages: Message[]; startIndex: number; onMessage: Props["onMessage"]; onAdd: Props["onAdd"]; onDelete: Props["onDelete"]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const editors = useRef<HTMLTextAreaElement[]>([]);
  const preview = messages.map((message) => message.content.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
  const beginEdit = () => {
    if (disabled) return;
    setDrafts(Object.fromEntries(messages.map((message) => [message.id, message.content])));
    setEditing(true);
    requestAnimationFrame(() => editors.current[0]?.focus());
  };
  const cancelEdit = () => { setEditing(false); setDrafts({}); };
  const saveEdit = () => {
    for (const message of messages) if (drafts[message.id] !== undefined && drafts[message.id] !== message.content)
      onMessage(message.id, { content: drafts[message.id] });
    setEditing(false); setDrafts({});
  };
  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); saveEdit(); }
  };
  return <section className={`system-banner ${open ? "expanded" : ""}`}>
    <div className="system-banner-head">
      <span className="system-sparkle">✦</span>
      <div className="system-banner-copy"><strong>系统人设 · Gemini 最佳伙伴 &amp; GPT 调度模式</strong><small>{open ? "System / Developer 指令" : preview.slice(0, 145) || "尚未设置系统指令"}</small></div>
      <button className="text-button" disabled={editing} onClick={() => setOpen((value) => !value)}>{open ? "收起" : "展开 / 编辑"}<ChevronDown size={14} /></button>
    </div>
    {open && <div className="system-message-list">{messages.map((message, offset) => <div className="system-message-edit" key={message.id} data-message-id={message.id}>
      <div className="system-message-meta"><span>{roleIcon(message.role)}{message.role}</span><button className="icon-button" disabled={disabled || editing} title={message.enabled ? "排除上下文" : "包含上下文"} onClick={() => onMessage(message.id, { enabled: !message.enabled })}>{message.enabled ? <Eye size={14} /> : <EyeOff size={14} />}</button><button className="icon-button danger" title="删除人设消息" disabled={disabled || editing} onClick={() => onDelete(message.id)}><Trash2 size={14} /></button></div>
      <textarea ref={(element) => { if (element) editors.current[offset] = element; }} aria-label={`${message.role} 人设内容`} disabled={disabled} value={editing ? drafts[message.id] ?? message.content : message.content} readOnly={!editing} onChange={(event) => setDrafts((current) => ({ ...current, [message.id]: event.target.value }))} onKeyDown={editing ? onEditorKeyDown : undefined} />
    </div>)}
      <div className="system-banner-actions">{editing ? <><button className="text-button" disabled={disabled} onClick={saveEdit}>保存 <kbd>⌘/Ctrl+Enter</kbd></button><button className="text-button" disabled={disabled} onClick={cancelEdit}>取消 <kbd>Esc</kbd></button></> : <button className="text-button" disabled={disabled} onClick={beginEdit}><Pencil size={13} />编辑指令</button>}<button className="text-button" disabled={disabled || editing} onClick={() => onAdd(startIndex + messages.length - 1, "system")}><Plus size={13} />添加 System</button><button className="text-button" disabled={disabled || editing} onClick={() => onAdd(startIndex + messages.length - 1, "developer")}><Plus size={13} />添加 Developer</button></div>
    </div>}
  </section>;
}

function MessageCard({ message, index, total, busy, streaming, onMessage, onCopy, onAdd, onMove, onDelete, onBranch, children, onImage, searchTerm }: {
  message: Message; index: number; total: number; busy: boolean; streaming: boolean; onMessage: Props["onMessage"]; onCopy: Props["onCopy"]; onAdd: Props["onAdd"]; onMove: Props["onMove"]; onDelete: Props["onDelete"]; onBranch: Props["onBranch"]; children?: React.ReactNode; onImage: (file: string, name: string) => void; searchTerm?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const editor = useRef<HTMLTextAreaElement>(null);
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const startEdit = () => { if (busy) return; setDraftContent(message.content); setEditing(true); requestAnimationFrame(() => editor.current?.focus()); };
  const cancelEdit = () => { setDraftContent(message.content); setEditing(false); };
  const saveEdit = () => { onMessage(message.id, { content: draftContent }); setEditing(false); };
  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); saveEdit(); }
  };
  const roleLocked = busy || editing || message.role === "tool" || !!message.toolCalls?.length;
  const compacted = message as CompactedMessage;
  const isSearchHit = !!searchTerm && `${message.content} ${compacted.modelSummary || ""}`.toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase());
  const toolbarStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 3, padding: "3px 5px", border: "1px solid var(--border)",
    marginLeft: "auto", borderRadius: 9, background: "color-mix(in srgb, var(--surface) 94%, transparent)", boxShadow: "0 5px 16px rgba(20,20,20,.08)",
    opacity: hovered || editing ? 1 : 0, pointerEvents: hovered || editing ? "auto" : "none", transition: "opacity .14s ease",
  };
  const actionButtonStyle: React.CSSProperties = { display: "grid", width: 27, height: 25, placeItems: "center", padding: 0, border: 0, borderRadius: 6, color: "var(--text-muted)", background: "transparent", cursor: "pointer" };
  const roleSelector = <select aria-label={`消息 ${index + 1} 角色`} title={roleLocked && (message.role === "tool" || !!message.toolCalls?.length) ? "工具调用及其结果不能直接更改角色，以免破坏工具配对。" : undefined} disabled={roleLocked} value={message.role} onChange={(event) => onMessage(message.id, { role: event.target.value as Message["role"], toolCalls: undefined, toolCallId: undefined, toolName: undefined, isError: undefined, images: undefined, providerState: undefined })} style={{ maxWidth: 69, height: 25, padding: "0 3px", border: 0, borderRadius: 5, color: "var(--text-subtle)", background: "transparent", fontSize: 9 }}>
    {roles.filter((role) => role !== "tool" || message.role === "tool").map((role) => <option key={role} value={role}>{roleName(role)}</option>)}
  </select>;
  const toolbar = <div className="message-actions message-actions--floating" style={isUser ? { ...toolbarStyle, position: "absolute", top: 0, right: 9, zIndex: 3 } : toolbarStyle}>
    {editing ? <><button style={actionButtonStyle} disabled={busy} aria-label="保存消息" title="保存 · ⌘/Ctrl+Enter" onClick={saveEdit}><span>✓</span></button><button style={actionButtonStyle} disabled={busy} aria-label="取消编辑" title="取消 · Esc" onClick={cancelEdit}><X size={13} /></button></> : <>
      {roleSelector}
      <button style={actionButtonStyle} disabled={busy} aria-label="复制消息" title="复制完整消息文本" onClick={() => onCopy(message.content)}><Copy size={13} /></button>
      <button style={actionButtonStyle} disabled={busy} aria-label="编辑消息" title="编辑消息" onClick={startEdit}><Pencil size={13} /></button>
      <button style={actionButtonStyle} disabled={busy} aria-label="从此处分支" title="从此处分支" onClick={() => onBranch(message, index)}><GitBranch size={13} /></button>
      <button style={actionButtonStyle} disabled={busy} aria-label={message.enabled ? "排除上下文" : "包含上下文"} title={message.enabled ? "排除上下文" : "包含上下文"} onClick={() => onMessage(message.id, { enabled: !message.enabled })}>{message.enabled ? <Eye size={13} /> : <EyeOff size={13} />}</button>
      <button style={actionButtonStyle} disabled={busy} aria-label="在下方插入消息" title="在下方插入消息" onClick={() => onAdd(index, "user")}><MessageSquarePlus size={13} /></button>
      <button style={actionButtonStyle} disabled={busy || index === 0} aria-label="上移消息" title="上移消息" onClick={() => onMove(index, -1)}><ArrowUp size={13} /></button>
      <button style={actionButtonStyle} disabled={busy || index === total - 1} aria-label="下移消息" title="下移消息" onClick={() => onMove(index, 1)}><ArrowDown size={13} /></button>
      <button style={{ ...actionButtonStyle, color: "var(--danger)" }} disabled={busy} aria-label="删除消息" title="删除消息" onClick={() => onDelete(message.id)}><Trash2 size={13} /></button>
    </>}
  </div>;
  const rowStyle: React.CSSProperties = isUser
    ? { position: "relative", display: "flex", width: "100%", justifyContent: "flex-end", margin: "13px 0 22px", paddingTop: 15 }
    : { position: "relative", display: "flex", width: "100%", justifyContent: "flex-start", margin: "14px 0 25px" };
  const cardStyle: React.CSSProperties = isUser
    ? { position: "relative", width: "fit-content", minHeight: 0, maxWidth: "min(88%, 760px)", padding: "7px 16px", overflow: "visible", border: `1px solid ${isSearchHit ? "color-mix(in srgb, var(--warning) 50%, var(--border))" : "var(--border)"}`, borderRadius: "19px 19px 5px 19px", color: "var(--text)", background: "color-mix(in srgb, var(--surface-hover) 84%, var(--accent-soft))", boxShadow: "0 2px 8px rgba(28,30,35,.035)" }
    : isAssistant
      ? { position: "relative", width: "100%", overflow: "visible", border: 0, borderRadius: 0, color: "var(--text)", background: "transparent", boxShadow: "none" }
      : {};
  return <div className={`message-row ${isUser ? "message-row--user-bubble" : ""} ${isAssistant ? "message-row--assistant-editorial" : ""} ${isSearchHit ? "search-hit" : ""}`} data-message-id={message.id} style={rowStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setHovered(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false); }}>
    {isUser && toolbar}
    <article className={`chat-message ${message.role} ${message.enabled ? "" : "excluded"}`} style={cardStyle}>
      {isUser ? null : <header className="message-head" style={{ display: "flex", minHeight: isAssistant ? 27 : 32, alignItems: "center", gap: 8, padding: isAssistant ? "2px 0 0" : "5px 10px 0", border: 0, background: "transparent" }}>
        {isAssistant ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-subtle)", fontSize: 10, fontWeight: 600 }}><Sparkles size={13} style={{ color: "var(--accent)" }} />Gemini</span> : <span className={`message-role ${message.role}`}>{roleIcon(message.role)}{roleName(message.role)}</span>}
        {toolbar}
      </header>}
      {(editing || !!message.content.trim() || streaming) && <div className="message-content" style={{ padding: isUser ? 0 : "5px 0 10px", maxHeight: "none", overflow: "visible" }}>{editing ? <textarea ref={editor} aria-label={`编辑 ${roleName(message.role)} 消息`} disabled={busy} value={draftContent} onChange={(event) => setDraftContent(event.target.value)} onKeyDown={onEditorKeyDown} /> : message.content.trim() ? <Markdown content={message.content} highlight={searchTerm} trailing={streaming ? <span className="streaming-cursor" aria-hidden="true" /> : undefined} /> : streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}</div>}
      {!!message.images?.length && <div className="image-gallery message-images" style={{ padding: isUser ? "0 14px 12px" : "0 0 12px" }}>{message.images.map((image) => <button key={image.file} title={image.name} onClick={() => onImage(image.file, image.name)}><img src={imageUrl(image.file)} alt={image.name} loading="lazy" /></button>)}</div>}
      {message.role === "assistant" && message.providerState?.thinking.some((item) => item.thinking) && <details className="thinking-accordion" style={{ display: "inline-block", width: "fit-content", maxWidth: "100%", margin: "0 0 8px", border: 0, borderRadius: 0, background: "transparent" }}><summary style={{ display: "flex", width: "max-content", maxWidth: "100%", alignItems: "center", gap: 7, padding: "4px 9px", color: "var(--text-subtle)", fontSize: 9 }}><Brain size={13} />思考过程 <small>{message.providerState.thinking.reduce((n, item) => n + item.thinking.length, 0).toLocaleString()} 字符</small></summary><pre>{message.providerState.thinking.map((item) => item.thinking).join("\n")}</pre></details>}
      {children}
    </article>
    <button className="insert-after" disabled={busy || editing} title="在此处插入消息" onClick={() => onAdd(index, "user")}><Plus size={13} /></button>
  </div>;
}

function readGptReply(content: string) {
  try {
    const value = JSON.parse(content);
    const findReply = (item: unknown): string => {
      if (Array.isArray(item)) return item.map(findReply).find(Boolean) || "";
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.reply === "string" && record.reply.trim()) return record.reply.trim();
      for (const child of Object.values(record)) { const reply = findReply(child); if (reply) return reply; }
      return "";
    };
    const reply = findReply(value);
    if (reply) return reply;
  } catch { /* GPT read/wait output is often formatted text rather than JSON. */ }
  const section = /(?:最近|最新)回复\s*\n+([\s\S]*?)(?=\n{2,}(?:正在回复|需要回答|最近操作|最近工具活动)(?:\s|$)|$)/.exec(content);
  return (section?.[1] || content).trim();
}

function ToolStep({ assistant, call, callIndex, result, stepNumber, onCall, onResult, onImage, onDeleteCall, disabled, searchTerm, jumpedId }: { assistant: Message; call: ToolCall; callIndex: number; result?: Message; stepNumber?: number; onCall: Props["onCall"]; onResult: Props["onMessage"]; onImage: (file: string, name: string) => void; onDeleteCall: Props["onDeleteCall"]; disabled?: boolean; searchTerm?: string; jumpedId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => { if (jumpedId && jumpedId === result?.id) setExpanded(true); }, [jumpedId, result?.id]);
  const args = parseToolArguments(call.arguments);
  const dispatchesToGpt = call.name === "gpt_session_create" || call.name === "gpt_session_send";
  const readsFromGpt = call.name === "gpt_session_wait" || call.name === "gpt_session_read";
  const thinking = assistant.providerState?.thinking.map((item) => item.thinking).filter(Boolean).join("\n") || "";
  const status = result ? result.isError ? "失败" : "完成" : "待返回";
  const reply = result?.content ? readGptReply(result.content) : "";
  const hasGptReport = readsFromGpt && !!reply && !/暂无新回复|暂时还没有发来回复|还没有发来回复/.test(reply);
  return <details className={`tool-step tool-step-row ${result?.isError ? "failed" : ""}`} title="工具调用及其结果不能直接更改角色，以免破坏工具配对。" data-tool-name={call.name} data-message-id={assistant.id} data-result-id={result?.id} data-has-report={hasGptReport ? "true" : undefined} data-has-thinking={thinking ? "true" : undefined} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{typeof stepNumber === "number" && <span className="tool-step-number">{String(stepNumber).padStart(2, "0")}</span>}<span className="tool-step-icon">{toolIcon(call.name)}</span><strong>{toolTitle(call.name, call.arguments)}</strong><span className={`tool-state ${result ? result.isError ? "error" : "complete" : "pending"}`}>{status}</span><ChevronDown size={14} /></summary>
    {expanded && <div className="tool-step-body">
      {dispatchesToGpt && typeof args.message === "string" && args.message.trim() && <section className="tool-readable-block tool-dispatch-block"><strong>派发给 GPT 的指令{args.name ? ` · ${args.name}` : ""}</strong><Markdown content={args.message} highlight={searchTerm} /></section>}
      {readsFromGpt && result?.content && <section className="tool-readable-block tool-reply-block"><strong>GPT 返回的汇报</strong><Markdown content={reply || result.content} highlight={searchTerm} /></section>}
      {!dispatchesToGpt && !readsFromGpt && result?.content && <section className={`tool-readable-block ${result.isError ? "error" : ""}`}><strong>工具结果</strong><Markdown content={result.content} highlight={searchTerm} /></section>}
      {thinking && <details className="tool-step-thinking"><summary><Brain size={13} />Gemini 思考过程</summary><div className="tool-readable-block"><Markdown content={thinking} /></div></details>}
      {!!result?.images?.length && <div className="image-gallery tool-image-gallery">{result.images.map((image) => <button key={image.file} title={image.name} onClick={() => onImage(image.file, image.name)}><img src={imageUrl(image.file)} alt={image.name} loading="lazy" /></button>)}</div>}
      <div className="tool-step-actions"><button className="raw-toggle" disabled={disabled} onClick={() => setRaw((value) => !value)}>{raw ? "收起原始参数" : "查看/编辑原始参数"}</button><button className="raw-toggle danger" disabled={disabled} onClick={() => onDeleteCall(assistant.id, call.id)}>删除此步骤及配对结果</button></div>
      {raw && <div className="tool-raw-fields">
        <label>工具名称<input disabled={disabled} value={call.name} onChange={(event) => onCall(assistant, callIndex, { name: event.target.value })} /></label>
        <label>Call ID<input disabled={disabled} value={call.id} onChange={(event) => onCall(assistant, callIndex, { id: event.target.value })} /></label>
        <label className="wide">参数 JSON<textarea disabled={disabled} spellCheck={false} value={call.arguments} onChange={(event) => onCall(assistant, callIndex, { arguments: event.target.value })} /></label>
        {result && <><label>结果 Call ID<input disabled={disabled} value={result.toolCallId || ""} onChange={(event) => onResult(result.id, { toolCallId: event.target.value })} /></label><label className="check-label"><input disabled={disabled} type="checkbox" checked={!!result.isError} onChange={(event) => onResult(result.id, { isError: event.target.checked })} />错误结果</label><label className="wide">工具结果<textarea disabled={disabled} value={result.content} onChange={(event) => onResult(result.id, { content: event.target.value })} /></label></>}
      </div>}
    </div>}
  </details>;
}

function toolGroupSummary(steps: { call: ToolCall }[]) {
  const create = steps.find((step) => step.call.name === "gpt_session_create");
  if (create) {
    const name = parseToolArguments(create.call.arguments).name;
    return `调度 GPT${name ? `「${String(name)}」` : ""}${steps.length > 1 ? " 等" : ""}`;
  }
  const titles = [...new Set(steps.slice(0, 3).map((step) => toolTitle(step.call.name, step.call.arguments)))];
  return `${titles.join(" · ")}${steps.length > titles.length ? " 等" : ""}`;
}

function toolGroupDehydrationSummary(steps: { assistant: Message; call: ToolCall; result?: Message }[]) {
  const titles = [...new Set(steps.map((step) => toolTitle(step.call.name, step.call.arguments)))].slice(0, 4);
  const notes = [...new Set(steps.map((step) => step.assistant.content.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 2).map((note) => note.slice(0, 120));
  const results = steps.filter((step) => step.result).slice(0, 3).map((step) => {
    const output = step.result!.content.replace(/\s+/g, " ").trim();
    return `${step.call.name}: ${output.slice(0, 96)}${output.length > 96 ? "…" : ""}`;
  });
  const remaining = Math.max(0, steps.filter((step) => step.result).length - results.length);
  return `已完成 ${steps.length} 个工具步骤（${titles.join("、")}）。${notes.length ? ` Gemini 说明：${notes.join("；")}` : ""}${results.length ? ` 要点：${results.join("；")}` : ""}${remaining ? `；另有 ${remaining} 个已完成步骤` : ""}`.slice(0, 720);
}

function collectToolGroups(messages: Message[], start: number, byCallId: Map<string, Message>, matched: Set<string>) {
  const groups: { steps: { assistant: Message; call: ToolCall; callIndex: number; result?: Message }[]; messages: Message[] }[] = [];
  for (let index = start; index < messages.length;) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls?.length || message.images?.length) { index++; continue; }
    const steps = message.toolCalls.map((call, callIndex) => ({ assistant: message, call, callIndex, result: byCallId.get(wireToolCallId(call.id)) }));
    let cursor = index + 1;
    while (cursor < messages.length) {
      const next = messages[cursor];
      if (next.role === "tool" && next.toolCallId && matched.has(wireToolCallId(next.toolCallId))) { cursor++; continue; }
      if (next.role === "assistant" && next.toolCalls?.length && !next.images?.length) {
        next.toolCalls.forEach((call, callIndex) => steps.push({ assistant: next, call, callIndex, result: byCallId.get(wireToolCallId(call.id)) })); cursor++; continue;
      }
      break;
    }
    const related = [...new Map(steps.flatMap((step) => [step.assistant, ...(step.result ? [step.result] : [])]).map((item) => [item.id, item] as const)).values()];
    groups.push({ steps, messages: related });
    index = cursor;
  }
  return groups;
}

function ToolStepGroup({ steps, compact, onCall, onMessage, onImage, onDeleteCall, live = false, disabled, searchTerm, jumpedId }: { steps: { assistant: Message; call: ToolCall; callIndex: number; result?: Message }[]; compact: boolean; onCall: Props["onCall"]; onMessage: Props["onMessage"]; onImage: (file: string, name: string) => void; onDeleteCall: Props["onDeleteCall"]; live?: boolean; disabled?: boolean; searchTerm?: string; jumpedId?: string }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  useEffect(() => { setManualOpen(null); }, [compact]);
  const open = live || (manualOpen ?? !compact);
  const images = steps.flatMap((step) => step.result?.images || []);
  const groupMessages = [...new Map(steps.flatMap((step) => [step.assistant, ...(step.result ? [step.result] : [])]).map((message) => [message.id, message] as const)).values()];
  const compactedMessages = groupMessages.map((message) => message as CompactedMessage);
  const compacted = compactedMessages.some((message) => message.compactedByModel);
  const modelSummary = compactedMessages.find((message) => message.modelSummary?.trim())?.modelSummary?.trim() || "";
  const archived = groupMessages.length > 0 && groupMessages.every((message) => !message.enabled);
  const partialArchive = groupMessages.some((message) => !message.enabled) && !archived;
  const summaryText = modelSummary || toolGroupDehydrationSummary(steps);
  useEffect(() => { setSummaryDraft(modelSummary); setEditingSummary(false); }, [modelSummary]);
  useEffect(() => { if (!compacted) setSummaryOpen(false); }, [compacted]);
  const toggleArchive = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (archived) {
      for (const message of groupMessages) onMessage(message.id, { enabled: true });
      return;
    }
    if (compacted) {
      for (const message of groupMessages) onMessage(message.id, { compactedByModel: false, modelSummary: undefined });
      setSummaryOpen(false); return;
    }
    for (const message of groupMessages) onMessage(message.id, { compactedByModel: true, modelSummary: summaryText });
  };
  const revealSummary = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    setSummaryDraft(summaryText); setSummaryOpen((value) => !value); setEditingSummary(false);
  };
  const saveSummary = () => {
    const summary = summaryDraft.trim();
    if (summary) for (const message of groupMessages) onMessage(message.id, { compactedByModel: true, modelSummary: summary });
    setEditingSummary(false);
  };
  const actionStyle: React.CSSProperties = {
    display: "inline-flex", minHeight: 24, alignItems: "center", justifyContent: "center", gap: 5, padding: "0 8px",
    border: "1px solid var(--border)", borderRadius: 99, color: "var(--text-subtle)", background: "var(--surface)",
    fontSize: 8, whiteSpace: "nowrap", cursor: "pointer", opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity .14s ease",
  };
  const quietPill: React.CSSProperties = { display: "inline-flex", minHeight: 23, alignItems: "center", gap: 4, padding: "0 8px", border: "1px solid color-mix(in srgb, var(--success) 25%, var(--border))", borderRadius: 99, color: "var(--success)", background: "color-mix(in srgb, var(--success-soft) 70%, var(--surface))", fontSize: 8, whiteSpace: "nowrap", cursor: "pointer" };
  return <section className={`tool-group tool-group--quiet ${live ? "is-live" : ""} ${archived ? "is-archived" : ""}`} data-step-count={steps.length} data-message-id={steps[0]?.assistant.id} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setHovered(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false); }} style={{ margin: "6px 0 13px", overflow: "visible", border: 0, borderRadius: 0, background: "transparent", boxShadow: "none" }}>
    <details open={open} onToggle={(event) => { const nextOpen = event.currentTarget.open; if (live) { if (!nextOpen) event.currentTarget.open = true; return; } if (nextOpen !== open) setManualOpen(nextOpen); }} style={{ border: 0, background: "transparent" }}>
      <summary style={{ display: "flex", minHeight: 32, alignItems: "center", gap: 8, padding: "3px 0", border: 0, borderRadius: 0, background: "transparent", color: "var(--text-subtle)", cursor: "pointer", listStyle: "none" }}>
        <Wrench size={13} style={{ flex: "0 0 auto", color: "var(--text-subtle)" }} />
        <strong style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", color: "var(--text-subtle)", fontSize: 9, fontWeight: 550, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>已执行 {steps.length} 个工具步骤（{toolGroupSummary(steps)}）</strong>
        {partialArchive && <span style={{ color: "var(--text-subtle)", fontSize: 8 }}>部分排除</span>}
        {archived && <span style={{ color: "var(--text-subtle)", fontSize: 8 }}>已归档</span>}
        {compacted && <><button type="button" className="tool-group-badge compacted" style={quietPill} onClick={revealSummary}>🧹 已精简上下文</button><button type="button" style={{ ...actionStyle, opacity: hovered ? 1 : 0 }} onClick={revealSummary}>查看摘要</button></>}
        <button type="button" className="tool-group-archive" disabled={disabled || live || steps.some((step) => !step.result)} onClick={toggleArchive} style={{ ...actionStyle, marginLeft: "auto", opacity: hovered ? 1 : 0 }}>{archived ? "恢复" : compacted ? "还原" : "🧹 精简"}</button>
        <span aria-hidden="true" style={{ flex: "0 0 auto", marginLeft: compacted ? 0 : "auto", color: "var(--text-subtle)", fontSize: 14 }}>{open ? "▾" : "▸"}</span>
      </summary>
      {open && <div className="tool-timeline-thread" style={{ margin: "2px 0 5px 6px", padding: "2px 0 3px 12px", borderLeft: "1px solid var(--border)", background: "transparent" }}>{steps.map((step, index) => <ToolStep key={`${step.call.id}-${step.assistant.id}`} {...step} stepNumber={index + 1} onCall={onCall} onResult={onMessage} onImage={onImage} onDeleteCall={onDeleteCall} disabled={disabled} searchTerm={searchTerm} jumpedId={jumpedId} />)}</div>}
    </details>
    {summaryOpen && <section className="tool-summary-card" style={{ margin: "3px 0 8px 21px", padding: "10px 12px", border: "1px solid color-mix(in srgb, var(--success) 22%, var(--border))", borderRadius: 10, background: "color-mix(in srgb, var(--success-soft) 40%, var(--surface))", boxShadow: "none" }}>
      <header style={{ display: "flex", minHeight: 24, alignItems: "center", gap: 8, marginBottom: 5 }}><strong style={{ color: "var(--text-muted)", fontSize: 9 }}>工具组摘要</strong><span style={{ color: "var(--text-subtle)", fontSize: 8 }}>保留在模型上下文中</span><div style={{ display: "flex", gap: 5, marginLeft: "auto" }}>{editingSummary ? <><button disabled={disabled} onClick={saveSummary}>保存</button><button disabled={disabled} onClick={() => { setSummaryDraft(summaryText); setEditingSummary(false); }}>取消</button></> : <button disabled={disabled} onClick={() => { setSummaryDraft(summaryText); setEditingSummary(true); }}>编辑</button>}<button disabled={disabled} aria-label="收起摘要" title="收起摘要" onClick={() => setSummaryOpen(false)}>×</button></div></header>
      {editingSummary ? <textarea aria-label="编辑工具组摘要" disabled={disabled} value={summaryDraft} onChange={(event) => setSummaryDraft(event.target.value)} style={{ display: "block", width: "100%", minHeight: 72, padding: 9, border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", background: "var(--surface)", fontSize: 9, lineHeight: 1.55 }} /> : <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 9, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{summaryText}</p>}
    </section>}
    {!!images.length && <div className="image-gallery group-image-gallery" style={{ display: "flex", flexWrap: "wrap", gap: 7, margin: "2px 0 8px 21px", padding: 0 }}>{images.map((image) => <button key={image.file} title={image.name} onClick={() => onImage(image.file, image.name)} style={{ overflow: "hidden", border: "1px solid var(--border)", borderRadius: 9, background: "var(--surface)" }}><img src={imageUrl(image.file)} alt={image.name} loading="lazy" style={{ display: "block", width: "auto", maxWidth: 150, maxHeight: 92, objectFit: "cover" }} /></button>)}</div>}
  </section>;
}

export function MessageStream(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  const scrollRequestRef = useRef(props.scrollRequest);
  const [imagePreview, setImagePreview] = useState<{ file: string; name: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [localDirectoryOpen, setLocalDirectoryOpen] = useState(false);
  const directoryOpen = props.directoryOpen ?? localDirectoryOpen;
  const setDirectoryOpenState = (open: boolean) => props.onDirectoryOpenChange ? props.onDirectoryOpenChange(open) : setLocalDirectoryOpen(open);
  const archiveRequestRef = useRef(props.archiveRequest ?? 0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleSearchTerm = directoryOpen ? searchTerm : "";
  const [jumpedId, setJumpedId] = useState("");
  const [scrollState, setScrollState] = useState({ top: false, bottom: false });
  const followStream = useRef(true);
  const wasBusy = useRef(false);
  const disabled = props.busy;
  const byCallId = useMemo(() => new Map(props.messages.filter((message) => message.role === "tool" && message.toolCallId).map((message) => [wireToolCallId(message.toolCallId!), message])), [props.messages]);
  const matched = useMemo(() => new Set(props.messages.flatMap((message) => message.toolCalls?.map((call) => wireToolCallId(call.id)) || [])), [props.messages]);
  const leadCount = props.messages.findIndex((message) => message.role !== "system" && message.role !== "developer");
  const initialEnd = leadCount < 0 ? props.messages.length : leadCount;
  const initialMessages = props.messages.slice(0, initialEnd);
  const searchMatches = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    return props.messages.flatMap((message, index) => {
      const compacted = message as CompactedMessage;
      const searchable = `${message.content} ${compacted.modelSummary || ""}`.toLocaleLowerCase();
      const matches = !systemWakeNotice(message.content) && (query ? searchable.includes(query) : message.role === "user" && !!message.content.trim());
      return matches ? [{ message, index }] : [];
    });
  }, [props.messages, searchTerm]);
  const archiveGroups = useMemo(() => collectToolGroups(props.messages, initialEnd, byCallId, matched), [props.messages, initialEnd, byCallId, matched]);
  const archiveableGroups = useMemo(() => archiveGroups.filter((group) => group.steps.every((step) => !!step.result) && group.messages.every((message) => message.enabled) && group.messages.some((message) => !(message as CompactedMessage).compactedByModel)), [archiveGroups]);
  const oldToolGroups = useMemo(() => archiveableGroups.slice(0, -1), [archiveableGroups]);
  const runningWorkers = (props.gptWorkers || []).filter((worker) => activeWorkerStatuses.has(worker.status));
  const openImage = (file: string, name: string) => setImagePreview({ file, name });
  const updateScroll = (element: HTMLDivElement) => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    followStream.current = distance < 120;
    setScrollState({ top: element.scrollTop > 220, bottom: distance > 120 });
  };
  const jumpToMessage = (id: string) => {
    const root = scrollRef.current;
    if (!root) return;
    let target = [...root.querySelectorAll<HTMLElement>("[data-message-id], [data-result-id]")].find((element) => element.dataset.messageId === id || element.dataset.resultId === id);
    if (!target) {
      const message = props.messages.find((item) => item.id === id);
      if (message?.role === "tool") {
        const owner = props.messages.find((item) => item.toolCalls?.some((call) => wireToolCallId(call.id) === wireToolCallId(message.toolCallId || "")));
        const group = owner && root.querySelector<HTMLElement>(`.tool-group[data-message-id="${CSS.escape(owner.id)}"]`);
        const groupDetails = group?.querySelector<HTMLDetailsElement>(":scope > details");
        if (groupDetails) {
          if (!groupDetails.open) groupDetails.querySelector<HTMLElement>("summary")?.click();
          requestAnimationFrame(() => requestAnimationFrame(() => jumpToMessage(id)));
          return;
        }
      }
      const banner = root.querySelector<HTMLElement>(".system-banner");
      const toggle = banner?.querySelector<HTMLButtonElement>(".system-banner-head button");
      const expandedMessage = [...(banner?.querySelectorAll<HTMLElement>("[data-message-id]") || [])].some((element) => element.dataset.messageId === id);
      if (message && (message.role === "system" || message.role === "developer") && toggle && !expandedMessage) {
        toggle.click();
        requestAnimationFrame(() => jumpToMessage(id));
      }
      return;
    }
    for (let parent: HTMLElement | null = target; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) {
      if (parent === target && !parent.open) parent.querySelector<HTMLElement>("summary")?.click();
      else parent.open = true;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("jump-highlight");
    setJumpedId(id);
    window.setTimeout(() => { target?.classList.remove("jump-highlight"); setJumpedId((current) => current === id ? "" : current); }, 1800);
  };
  const archiveOldToolRecords = () => {
    if (disabled) return;
    for (const group of oldToolGroups) {
      const summary = toolGroupDehydrationSummary(group.steps);
      for (const message of group.messages) props.onMessage(message.id, { compactedByModel: true, modelSummary: summary });
    }
  };
  useEffect(() => { props.onArchiveableGroupsChange?.(oldToolGroups.length); }, [oldToolGroups.length, props.onArchiveableGroupsChange]);
  useEffect(() => {
    if (props.archiveRequest === undefined || props.archiveRequest === archiveRequestRef.current) return;
    archiveRequestRef.current = props.archiveRequest;
    archiveOldToolRecords();
  }, [props.archiveRequest, oldToolGroups, disabled]);
  const snippet = (message: Message) => {
    const compacted = message as CompactedMessage;
    const query = searchTerm.trim();
    const content = message.content.replace(/\s+/g, " ").trim();
    const summary = compacted.modelSummary?.replace(/\s+/g, " ").trim() || "";
    const text = query && !content.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && summary.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? summary : content || summary || "（空消息）";
    const position = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
    const start = position > 45 ? position - 35 : 0;
    return `${start ? "…" : ""}${text.slice(start, start + 125)}${text.length > start + 125 ? "…" : ""}`;
  };
  const highlightPreview = (value: string) => {
    const query = searchTerm.trim();
    if (!query) return value;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.split(new RegExp(`(${escaped})`, "gi")).map((part, index) => part.toLocaleLowerCase() === query.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part);
  };
  useEffect(() => { setSearchTerm(""); setDirectoryOpenState(false); setJumpedId(""); }, [props.sessionId]);
  useEffect(() => { if (directoryOpen) requestAnimationFrame(() => searchInputRef.current?.focus()); }, [directoryOpen]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setDirectoryOpenState(true);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sessionChanged = sessionRef.current !== props.sessionId;
    const requested = scrollRequestRef.current !== props.scrollRequest;
    sessionRef.current = props.sessionId;
    scrollRequestRef.current = props.scrollRequest;
    if (sessionChanged || requested || (props.busy && !wasBusy.current)) followStream.current = true;
    wasBusy.current = props.busy;
    if (sessionChanged || requested) {
      requestAnimationFrame(() => {
        if (!element.isConnected) return;
        element.scrollTo({ top: element.scrollHeight, behavior: sessionChanged ? "auto" : "smooth" });
        requestAnimationFrame(() => element.isConnected && updateScroll(element));
      });
    } else if (props.busy && followStream.current) element.scrollTop = element.scrollHeight;
    requestAnimationFrame(() => element.isConnected && updateScroll(element));
  }, [props.sessionId, props.scrollRequest, props.messages, props.busy, props.toolActivity, props.streamingThinking]);
  useEffect(() => {
    const element = scrollRef.current;
    const inner = innerRef.current;
    if (!element || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followStream.current) element.scrollTop = element.scrollHeight;
      updateScroll(element);
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const scrollTo = (where: "top" | "bottom") => scrollRef.current?.scrollTo({ top: where === "top" ? 0 : scrollRef.current.scrollHeight, behavior: "smooth" });
  const renderCard = (message: Message, index: number, children?: React.ReactNode) => {
    const compacted = message as CompactedMessage;
    const query = visibleSearchTerm.trim();
    const searchable = `${message.content} ${compacted.modelSummary || ""}`.toLocaleLowerCase();
    return <MessageCard key={message.id} message={message} index={index} total={props.messages.length} busy={props.busy} streaming={props.busy && props.streamingId === message.id} onMessage={props.onMessage} onCopy={props.onCopy} onAdd={props.onAdd} onMove={props.onMove} onDelete={props.onDelete} onBranch={props.onBranch} onImage={openImage} searchTerm={query && searchable.includes(query.toLocaleLowerCase()) ? query : ""}>{children}</MessageCard>;
  };
  const renderGroup = (steps: { assistant: Message; call: ToolCall; callIndex: number; result?: Message }[]) => {
    const live = props.busy && steps.some((step) => !step.result || step.assistant.id === props.streamingId);
    return <ToolStepGroup key={`group-${steps[0].assistant.id}`} steps={steps} compact={props.compactTools} onCall={props.onCall} onMessage={props.onMessage} onImage={openImage} onDeleteCall={props.onDeleteCall} live={live} disabled={disabled} searchTerm={visibleSearchTerm} jumpedId={jumpedId} />;
  };
  const toggleDirectory = () => setDirectoryOpenState(!directoryOpen);
  const content: React.ReactNode[] = [<div className="stream-tools" key="stream-tools" style={{ position: "sticky", top: 7, zIndex: 20, height: 0, margin: 0, padding: 0, overflow: "visible", background: "transparent", pointerEvents: "none" }}>
      <div className={`directory-panel ${directoryOpen ? "open" : ""}`} aria-hidden={!directoryOpen} inert={!directoryOpen} style={{ position: "absolute", top: 0, right: 0, zIndex: 30, display: directoryOpen ? "flex" : "none", flexDirection: "column", gap: 8, width: "min(440px, calc(100vw - 40px))", maxHeight: "min(62vh, 460px)", margin: 0, padding: 11, overflow: "hidden", opacity: 1, transform: "none", pointerEvents: "auto", border: "1px solid var(--border)", borderRadius: 13, background: "color-mix(in srgb, var(--surface) 96%, transparent)", boxShadow: "0 16px 44px rgba(20,20,20,.15)", backdropFilter: "blur(18px)" }}>
        <div className="message-search-box"><Search size={14} /><input ref={searchInputRef} aria-label="搜索会话消息" tabIndex={directoryOpen ? 0 : -1} value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setDirectoryOpenState(false); } }} placeholder="实时搜索消息或提问…" />{searchTerm && <button type="button" aria-label="清空搜索" tabIndex={directoryOpen ? 0 : -1} onClick={() => setSearchTerm("")}><X size={13} /></button>}</div>
        <div className="question-directory" role="list" aria-label={searchTerm.trim() ? "搜索结果" : "提问目录"} style={{ minHeight: 0, overflow: "auto" }}>{searchMatches.length ? searchMatches.slice(0, 50).map(({ message, index }) => <button key={message.id} tabIndex={directoryOpen ? 0 : -1} className={`question-result ${jumpedId === message.id ? "active" : ""}`} role="listitem" onClick={() => jumpToMessage(message.id)}><span className={`question-result-role ${message.role}`}>{roleIcon(message.role)}{roleName(message.role)}</span><span className="question-result-text">{highlightPreview(snippet(message))}</span><small>{String(index + 1).padStart(2, "0")}</small></button>) : <p className="question-directory-empty">没有匹配的消息。</p>}{searchMatches.length > 50 && <small className="question-directory-more">仅显示前 50 条匹配结果 · 共 {searchMatches.length} 条</small>}</div>
      </div>
  </div>];
  if (initialMessages.length) content.push(<SystemPromptBanner key="system-banner" messages={initialMessages} startIndex={0} onMessage={props.onMessage} onAdd={props.onAdd} onDelete={props.onDelete} disabled={disabled} />);
  if (props.lineage) content.push(<section className="session-lineage-card" key="session-lineage"><header><span>🧬 派生自「{props.lineage.parentSessionTitle || "上一个会话"}」</span>{props.onJumpToSession && <button disabled={disabled} onClick={() => props.onJumpToSession?.(props.lineage!.parentSessionId)}>查看原会话</button>}</header>{props.lineage.forkSummary && <div className="session-lineage-summary"><Markdown content={props.lineage.forkSummary} /></div>}</section>);
  for (let index = initialEnd; index < props.messages.length;) {
    const message = props.messages[index];
    const wakeNotice = message.role === "user" ? systemWakeNotice(message.content) : undefined;
    if (wakeNotice) {
      content.push(<div key={`worker-wake-${message.id}`} className="system-worker-wake-notice" role="status" data-message-id={message.id} title="这是后台工兵完成后的系统唤醒请求"><span>{wakeNotice}</span><button type="button" aria-label="删除工兵交卷通知" title="删除此通知" disabled={disabled} onClick={() => props.onDelete(message.id)}><X size={12} /></button></div>);
      index++; continue;
    }
    if (message.role === "tool" && message.toolCallId && matched.has(wireToolCallId(message.toolCallId))) { index++; continue; }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const own = message.toolCalls.map((call, callIndex) => ({ assistant: message, call, callIndex, result: byCallId.get(wireToolCallId(call.id)) }));
      // Keep assistant prose in a normal, always-visible message card. Tool collapsing
      // applies only to tool details; it must never hide text emitted alongside calls.
      if (!message.images?.length && message.content.trim()) {
        const liveThinking = props.streamingThinking && props.busy && props.streamingId === message.id ? <div className="live-thinking" role="status"><details><summary><Brain size={14} />思考过程 · 实时</summary><pre>{props.streamingThinking}</pre></details></div> : null;
        const callView = <div className="assistant-tool-steps">{own.map((step) => <ToolStep key={step.call.id} {...step} onCall={props.onCall} onResult={props.onMessage} onImage={openImage} onDeleteCall={props.onDeleteCall} disabled={disabled} searchTerm={visibleSearchTerm} jumpedId={jumpedId} />)}{liveThinking}</div>;
        content.push(renderCard(message, index, callView)); index++; continue;
      }
      if (!message.images?.length) {
        const steps = [...own]; let cursor = index + 1;
        while (cursor < props.messages.length) {
          const next = props.messages[cursor];
          if (next.role === "tool" && next.toolCallId && matched.has(wireToolCallId(next.toolCallId))) { cursor++; continue; }
          if (next.role === "assistant" && next.toolCalls?.length && !next.images?.length && !next.content.trim()) {
            next.toolCalls.forEach((call, callIndex) => steps.push({ assistant: next, call, callIndex, result: byCallId.get(wireToolCallId(call.id)) })); cursor++; continue;
          }
          break;
        }
        content.push(renderGroup(steps)); index = cursor; continue;
      }
      const liveThinking = props.streamingThinking && props.busy && props.streamingId === message.id ? <div className="live-thinking" role="status"><details><summary><Brain size={14} />思考过程 · 实时</summary><pre>{props.streamingThinking}</pre></details></div> : null;
      const callView = <div className="assistant-tool-steps">{own.map((step) => <ToolStep key={step.call.id} {...step} onCall={props.onCall} onResult={props.onMessage} onImage={openImage} onDeleteCall={props.onDeleteCall} disabled={disabled} searchTerm={visibleSearchTerm} jumpedId={jumpedId} />)}{liveThinking}</div>;
      content.push(renderCard(message, index, callView)); index++; continue;
    }
    if (message.role === "assistant" && props.busy && props.streamingId === message.id) {
      const liveThinking = props.streamingThinking ? <div className="live-thinking" role="status"><details><summary><Brain size={14} />思考过程 · 实时</summary><pre>{props.streamingThinking}</pre></details></div> : null;
      content.push(renderCard(message, index, liveThinking)); index++; continue;
    }
    content.push(renderCard(message, index)); index++;
  }
  if (props.toolActivity) content.push(<div key="tool-live" className="live-tool-card"><strong><Wrench size={14} />正在执行 {props.toolActivity.name}</strong><pre>{JSON.stringify(props.toolActivity.arguments, null, 2)}</pre>{props.toolActivity.output && <pre>{props.toolActivity.output}</pre>}</div>);
  if (props.forkNotice) content.push(<section key={`fork-created-${props.forkNotice.forkId}`} className="session-fork-created-card" role="status"><div><strong>✨ 已生成提纯分身「{props.forkNotice.title}」</strong><small>携带核心记忆轻装上阵，原会话保持不变。</small></div><button disabled={props.busy} onClick={() => props.onSwitchFork?.(props.forkNotice!.forkId)}>立即切换到新分身</button></section>);
  if (props.busy && runningWorkers.length) content.push(<div key="worker-live" className="live-tool-card live-workers-card"><strong><Sparkles size={14} />GPT 工兵活动中 · {runningWorkers.length}</strong>{runningWorkers.map((worker) => <div className="live-worker-row" key={worker.id}><span className="live-worker-name">{worker.name}<small>{worker.status === "waiting_input" ? "等待输入" : worker.status === "starting" ? "启动中" : "运行中"}</small></span><div className="live-worker-tools">{worker.recentTools.length ? worker.recentTools.slice(0, 5).map((tool, index) => <span className={`live-worker-tool ${tool.status}`} key={`${tool.name}-${index}`}>{tool.name}</span>) : <small>等待工具活动</small>}</div></div>)}</div>);
  if (!props.messages.length) content.push(<div key="empty" className="conversation-empty"><span>✦</span><strong>从一条消息开始</strong><p>给 Gemini 一个目标，让它协调 GPT 工兵完成工作。</p></div>);
  return <>
    <div className="message-stream" ref={scrollRef} data-session-id={props.sessionId} onScroll={(event) => updateScroll(event.currentTarget)}>
      <div className="stream-inner" ref={innerRef}>{content}<div className="stream-bottom-space" /></div>
      <div className="scroll-shortcuts">{scrollState.top && <button onClick={() => scrollTo("top")} title="回到顶部"><ArrowUp size={15} /></button>}{scrollState.bottom && <button onClick={() => scrollTo("bottom")} title="跳到底部"><ArrowDown size={15} /></button>}</div>
    </div>
    {imagePreview && <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setImagePreview(null)}><button className="lightbox-close" onClick={() => setImagePreview(null)} aria-label="关闭图片"><X size={20} /></button><img src={imageUrl(imagePreview.file)} alt={imagePreview.name} onClick={(event) => event.stopPropagation()} /><span>{imagePreview.name}</span></div>}
  </>;
}
