import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowDown, Archive, BookOpen, ChevronDown, CircleAlert, CircleCheck, LoaderCircle, MessageSquare, Pencil, Play, RefreshCw, Search, Send, ShieldAlert, Sparkles, Wrench, X } from "lucide-react";
import type { GptSessionSummary } from "../../shared/gpt-sessions";
import { gptWorkerSystemPrompt } from "../../extensions/pi-gpt-subagent/persona";

type TranscriptEvent = {
  sequence: number; at: number; type: string; text: string;
  toolName?: string; toolCallId?: string; isError?: boolean;
};
type Props = {
  ownerSessionId: string; cwd: string; workers: GptSessionSummary[]; selectedId: string;
  onSelect: (id: string) => void; onWorkerUpdate: (worker: GptSessionSummary) => void;
  onWorkersUpdate: (workers: GptSessionSummary[]) => void; onRefresh: () => void; sessionsError?: string;
};

const activeStatuses = new Set(["starting", "running", "waiting_input"]);
const cleanupStatuses = new Set(["idle", "suspended", "interrupted", "error"]);
const labels: Record<string, string> = {
  starting: "启动中", running: "运行中", idle: "空闲", waiting_input: "等待输入",
  interrupted: "已中断", suspended: "已挂起", closed: "已归档", error: "异常",
};

function statusLabel(status: string) { return labels[status] || status; }

type ToolCallTranscript = { key: string; name: string; events: TranscriptEvent[] };
type TranscriptItem = { kind: "event"; event: TranscriptEvent } | { kind: "tools"; key: string; calls: ToolCallTranscript[] };
type ToolStatus = "running" | "completed" | "error";
type TranscriptPersona = { systemPrompt?: string; dispatchContext?: string };

function isToolEvent(event: TranscriptEvent) { return ["tool_start", "tool_progress", "tool_end"].includes(event.type); }
function buildTranscriptItems(events: TranscriptEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, ToolCallTranscript>();
  const activeByName = new Map<string, string>();
  let currentGroup: Extract<TranscriptItem, { kind: "tools" }> | undefined;
  for (const event of events) {
    if (!isToolEvent(event)) { items.push({ kind: "event", event }); currentGroup = undefined; continue; }
    const name = event.toolName || "tool";
    const key = event.toolCallId || (event.type !== "tool_start" ? activeByName.get(name) : undefined) || `${name}:${event.sequence}`;
    let call = calls.get(key);
    if (!call) {
      call = { key, name, events: [] };
      calls.set(key, call);
      if (!currentGroup || items.at(-1) !== currentGroup) {
        currentGroup = { kind: "tools", key: `tools-${event.sequence}`, calls: [] };
        items.push(currentGroup);
      }
      currentGroup.calls.push(call);
    }
    call.events.push(event);
    if (!event.toolCallId && event.type === "tool_start") activeByName.set(name, key);
    if (!event.toolCallId && event.type === "tool_end") activeByName.delete(name);
  }
  return items;
}
function toolAction(call: ToolCallTranscript) {
  const start = call.events.find((event) => event.type === "tool_start");
  let args: Record<string, unknown> = {};
  try { const value = JSON.parse(start?.text || "{}"); if (value && typeof value === "object" && !Array.isArray(value)) args = value; } catch { /* Older transcripts may have non-JSON arguments. */ }
  const firstString = (...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string" && !!value.trim())?.replace(/\s+/g, " ").trim();
  const target = firstString("path", "file", "target", "directory", "cwd");
  const detail = firstString("command", "pattern", "query", "url");
  const name = call.name.toLowerCase();
  const value = name === "read" || name.includes("read_file") ? `已读取 ${target || detail || "文件"}`
    : name === "edit" || name.includes("edit_file") ? `已编辑 ${target || detail || "文件"}`
    : name === "write" || name.includes("write_file") ? `已写入 ${target || detail || "文件"}`
    : name === "bash" || name === "terminal" ? `已运行 ${detail || target || "命令"}`
    : name === "grep" || name === "search" ? `已搜索 ${detail || target || "内容"}`
    : name === "find" ? `已查找 ${detail || target || "文件"}`
    : name === "ls" ? `已列出 ${target || "目录"}`
    : name === "present_images" ? "已提交图片素材"
    : name === "view_images" || name === "list_images" ? `已查看 ${detail || target || "图片素材"}`
    : `已执行 ${call.name}${target ? ` · ${target}` : detail ? ` · ${detail}` : ""}`;
  return value.length > 120 ? `${value.slice(0, 117)}…` : value;
}
function toolStatus(call: ToolCallTranscript): ToolStatus {
  const end = [...call.events].reverse().find((event) => event.type === "tool_end");
  return !end ? "running" : end.isError ? "error" : "completed";
}
function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === "read" || lower.includes("read_file")) return <BookOpen size={13} />;
  if (lower === "edit" || lower.includes("edit_file") || lower === "write" || lower.includes("write_file")) return <Pencil size={13} />;
  if (["grep", "find", "search"].includes(lower)) return <Search size={13} />;
  if (["bash", "terminal"].includes(lower)) return <Play size={13} />;
  if (lower.includes("image")) return <Sparkles size={13} />;
  return <Wrench size={13} />;
}
function toolDetails(call: ToolCallTranscript) {
  const start = call.events.find((event) => event.type === "tool_start");
  let args = "";
  try { args = JSON.stringify(JSON.parse(start?.text || ""), null, 2); } catch { args = start?.text || ""; }
  const outputEvent = [...call.events].reverse().find((event) => event.type === "tool_end" && event.text)
    || [...call.events].reverse().find((event) => event.type === "tool_progress" && event.text);
  return { args, output: outputEvent?.text || "", progressCount: call.events.filter((event) => event.type === "tool_progress").length };
}
function transcriptUrl(name: string, ownerSessionId: string, cwd: string, cursor?: { after?: number; before?: number }) {
  const query = new URLSearchParams({ ownerSessionId, cwd });
  if (cursor) query.set("limit", "100");
  if (cursor?.after !== undefined) query.set("after", String(cursor.after));
  if (cursor?.before !== undefined) query.set("before", String(cursor.before));
  return `/api/gpt-sessions/${encodeURIComponent(name)}/transcript?${query}`;
}

function WorkerToolCall({ call }: { call: ToolCallTranscript }) {
  const status = toolStatus(call);
  const { args, output, progressCount } = toolDetails(call);
  const StatusIcon = status === "completed" ? CircleCheck : status === "error" ? CircleAlert : LoaderCircle;
  const statusText = status === "completed" ? "完成" : status === "error" ? "失败" : "运行中";
  return <details className={`worker-tool-call ${status}`}>
    <summary title={toolAction(call)}><span className="worker-tool-icon">{toolIcon(call.name)}</span><span className="worker-tool-action">{toolAction(call)}</span><span className={`worker-tool-status ${status}`}><StatusIcon size={12} className={status === "running" ? "spin" : ""} />{statusText}</span><ChevronDown size={13} className="worker-tool-chevron" /></summary>
    <div className="worker-tool-detail">
      {args && <section><strong>参数</strong><pre>{args}</pre></section>}
      {output && <section><strong>输出{progressCount > 1 ? ` · ${progressCount} 次进度更新` : ""}</strong><pre>{output}</pre></section>}
      {!args && !output && <small>暂无参数或输出记录。</small>}
    </div>
  </details>;
}

function WorkerToolGroup({ item }: { item: Extract<TranscriptItem, { kind: "tools" }> }) {
  const completed = item.calls.filter((call) => toolStatus(call) === "completed").length;
  const failed = item.calls.filter((call) => toolStatus(call) === "error").length;
  const preview = item.calls.slice(0, 2).map(toolAction).join(" · ");
  const more = item.calls.length > 2 ? ` · +${item.calls.length - 2}` : "";
  return <details className="worker-tool-group">
    <summary><Wrench size={13} /><span className="worker-tool-group-preview">{preview}{more}</span><small>{item.calls.length} 步骤</small>{failed > 0 && <span className="worker-tool-status error"><CircleAlert size={12} />{failed} 失败</span>}{completed === item.calls.length && !failed && <span className="worker-tool-status completed"><CircleCheck size={12} />完成</span>}<ChevronDown size={13} className="worker-tool-chevron" /></summary>
    <div className="worker-tool-list">{item.calls.map((call) => <WorkerToolCall key={call.key} call={call} />)}</div>
  </details>;
}

function WorkerTranscript({ worker, ownerSessionId, cwd, onWorkerUpdate, onClose }: {
  worker: GptSessionSummary; ownerSessionId: string; cwd: string;
  onWorkerUpdate: Props["onWorkerUpdate"]; onClose: () => void;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [persona, setPersona] = useState<TranscriptPersona>({});
  const [nearBottom, setNearBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const latestSequence = events.at(-1)?.sequence ?? 0;
  const latestSequenceRef = useRef(latestSequence);
  latestSequenceRef.current = latestSequence;

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let initialized = false;
    const controller = new AbortController();
    const applyPage = (page: { events?: TranscriptEvent[]; session?: GptSessionSummary; persona?: TranscriptPersona }, mode: "replace" | "append") => {
      if (cancelled) return;
      if (page.session) onWorkerUpdate(page.session);
      if (page.persona) setPersona(page.persona);
      if (mode === "replace") setEvents(page.events || []);
      else if (page.events?.length) setEvents((current) => {
        const next = [...current, ...page.events!];
        const unique = [...new Map(next.map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
        return unique.length === current.length && unique.every((event, index) => event.sequence === current[index]?.sequence)
          ? current : unique;
      });
    };
    const loadInitial = async () => {
      try {
        const response = await fetch(transcriptUrl(worker.name, ownerSessionId, cwd), { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取工兵记录失败。");
        applyPage(data, "replace"); setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取工兵记录失败。"); }
      finally { initialized = true; }
    };
    void loadInitial();
    const poll = async () => {
      if (!initialized || polling || cancelled) return;
      polling = true;
      try {
        const latest = latestSequenceRef.current;
        const response = await fetch(transcriptUrl(worker.name, ownerSessionId, cwd, { after: latest }), { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "刷新工兵记录失败。");
        applyPage(data, "append"); setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "刷新工兵记录失败。"); }
      finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll(), activeStatuses.has(worker.status) ? 2_000 : 5_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [worker.id, worker.name, worker.status, ownerSessionId, cwd, onWorkerUpdate]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followBottom.current) element.scrollTop = element.scrollHeight;
  }, [events.length]);
  const updateScroll = (element: HTMLDivElement) => {
    const closeToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    followBottom.current = closeToBottom;
    setNearBottom(closeToBottom);
  };
  const scrollToBottom = () => {
    followBottom.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };
  const latestDispatch = [...events].reverse().find((event) => event.type === "message_sent")?.text;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true); setError("");
    try {
      const response = await fetch(`/api/gpt-sessions/${encodeURIComponent(worker.name)}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ownerSessionId, message, mode: "steer" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发送指导失败。");
      if (data.session) onWorkerUpdate(data.session);
      setDraft("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发送指导失败。"); }
    finally { setSending(false); }
  };

  return <section className="worker-thread-view" aria-label={`${worker.name} 工兵记录`}>
    <header className="worker-thread-header">
      <div className="worker-thread-title"><span className={`thread-status-dot ${worker.status}`} /><div><strong>{worker.name}</strong><small>{worker.role || "GPT 工兵"} · {worker.model}</small></div><span className={`thread-status ${worker.status}`}>{statusLabel(worker.status)}</span></div>
      <div className="worker-thread-actions">
        {activeStatuses.has(worker.status) && <button className="thread-action danger" onClick={() => void runAction("interrupt")}><ShieldAlert size={14} />中断工兵</button>}
        {worker.status !== "closed" && <button className="thread-action" onClick={() => void runAction("close")}><Archive size={14} />归档会话</button>}
        <button className="icon-button" aria-label="返回主会话" title="返回主会话" onClick={onClose}><X size={16} /></button>
      </div>
    </header>
    <section className={`worker-persona ${personaOpen ? "open" : ""}`}>
      <button className="worker-persona-toggle" aria-expanded={personaOpen} onClick={() => setPersonaOpen((open) => !open)}>
        <Sparkles size={14} />
        <span><strong>工兵人设 · {worker.role || "通用 GPT"}{worker.rolePreset ? ` ${worker.rolePreset}` : ""}</strong><small>系统提示词与最近派遣上下文</small></span>
        <ChevronDown size={14} className="worker-persona-chevron" />
      </button>
      {personaOpen && <div className="worker-persona-content">
        <section><strong>System prompt</strong><pre>{persona.systemPrompt || gptWorkerSystemPrompt(worker.rolePreset)}</pre></section>
        <section><strong>最近派遣上下文</strong><pre>{latestDispatch || persona.dispatchContext || "尚未记录派遣上下文。"}</pre></section>
      </div>}
    </section>
    {error && <div className="thread-error" role="alert">{error}</div>}
    <div className="worker-transcript-container">
      <div className="worker-transcript-scroll" ref={scrollRef} aria-live="polite" onScroll={(event) => updateScroll(event.currentTarget)}>
        {!events.length && <div className="thread-transcript-empty"><MessageSquare size={20} /><span>工兵尚无可显示记录</span></div>}
        {buildTranscriptItems(events).map((item) => item.kind === "tools"
          ? <WorkerToolGroup key={item.key} item={item} />
          : <article className={`worker-transcript-event ${item.event.type}`} key={item.event.sequence}>
              <header><strong>{item.event.type === "user" || item.event.type === "message_sent" ? "指导" : item.event.type === "assistant" || item.event.type === "assistant_progress" ? "GPT" : "状态"}</strong><small>{new Date(item.event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></header>
              <p>{item.event.text || statusLabel(item.event.type)}</p>
            </article>)}
      </div>
      {!nearBottom && <button className="worker-scroll-to-bottom" aria-label="跳到底部工兵记录" title="跳到底部" onClick={scrollToBottom}><ArrowDown size={16} /></button>}
    </div>
    <form className="worker-guidance-form" onSubmit={(event) => void send(event)}>
      <textarea aria-label="指导工兵" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="给这个工兵发送直接指导…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <button type="submit" disabled={!draft.trim() || sending}>{sending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{sending ? "发送中…" : "发送指导"}</button>
    </form>
  </section>;

  async function runAction(kind: "interrupt" | "close") {
    try {
      const response = await fetch(`/api/gpt-sessions/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ownerSessionId, name: worker.name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "工兵操作失败。");
      if (data.session) onWorkerUpdate(data.session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工兵操作失败。"); }
  }
}

export function ThreadTabs({ ownerSessionId, cwd, workers, selectedId, onSelect, onWorkerUpdate, onWorkersUpdate, onRefresh, sessionsError }: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const liveWorkers = workers.filter((worker) => worker.status !== "closed" && !hiddenIds.has(worker.id));
  const archivedWorkers = workers.filter((worker) => worker.status === "closed");
  const cleanupWorkers = workers.filter((worker) => cleanupStatuses.has(worker.status));

  useEffect(() => {
    setHiddenIds(new Set());
  }, [ownerSessionId]);
  useEffect(() => {
    if (selectedId && !workers.some((worker) => worker.id === selectedId)) onSelect("");
  }, [selectedId, workers, onSelect]);

  const archive = async (worker: GptSessionSummary) => {
    try {
      const response = await fetch("/api/gpt-sessions/close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ownerSessionId, name: worker.name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "归档工兵失败。");
      if (data.session) onWorkerUpdate(data.session);
      setError("");
      if (selectedId === worker.id) onSelect("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "归档工兵失败。"); }
  };

  const cleanupIdle = async () => {
    if (!cleanupWorkers.length || !window.confirm(`归档 ${cleanupWorkers.length} 个非运行态工兵？\n${cleanupWorkers.map((worker) => `· ${worker.name}（${statusLabel(worker.status)}）`).join("\n")}`)) return;
    try {
      const response = await fetch("/api/gpt-sessions/cleanup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ownerSessionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "归档工兵失败。");
      onWorkersUpdate(data.sessions || []);
      if (data.failures?.length) setError(`归档完成，但 ${data.failures.length} 个会话未关闭。`);
      else setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "归档工兵失败。"); }
  };

  const closeTab = (worker: GptSessionSummary) => {
    setHiddenIds((current) => new Set(current).add(worker.id));
    if (selectedId === worker.id) onSelect("");
  };

  return <>
    <div className="thread-tabs-bar">
      <div ref={scroll} className="thread-tabs-scroll" role="tablist" aria-label="GPT 工兵线程" onWheel={(event) => {
        if (scroll.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); scroll.current.scrollLeft += event.deltaY; }
      }}>
        <button role="tab" aria-selected={!selectedId} className={`thread-main-tab ${!selectedId ? "selected" : ""}`} onClick={() => onSelect("")}>Gemini 主会话</button>
        {liveWorkers.map((worker) => <div className={`thread-tab ${selectedId === worker.id ? "selected" : ""}`} key={worker.id}>
          <button role="tab" aria-selected={selectedId === worker.id} className="thread-tab-select" title={`${worker.name} · ${statusLabel(worker.status)}`} onClick={() => onSelect(worker.id)}>
            <span className={`thread-status-dot ${worker.status}`} /><strong>{worker.name}</strong>{worker.recentTools[0] && <span className="thread-tab-tool" title={`最近工具：${worker.recentTools[0].name}`}>{worker.recentTools[0].name}</span>}<span className={`thread-status ${worker.status}`}>{statusLabel(worker.status)}</span>{worker.pendingQuestionCount > 0 && <span className="thread-tab-pending" title={`有 ${worker.pendingQuestionCount} 个待回答问题`}>{worker.pendingQuestionCount}问</span>}{worker.hasUnreadReply && <i className="thread-unread-dot" title="有新回复" />}
          </button>
          <button className="thread-tab-action" title="关闭标签，不停止工兵" aria-label={`关闭标签 ${worker.name}`} onClick={() => closeTab(worker)}><X size={12} /></button>
          <button className="thread-tab-action archive" title="归档工兵并保留记录" aria-label={`归档工兵 ${worker.name}`} onClick={() => void archive(worker)}><Archive size={12} /></button>
        </div>)}
      </div>
      <div className="thread-tabs-tools">
        <button className="thread-refresh" title="刷新 GPT 会话" aria-label="刷新 GPT 会话" onClick={onRefresh}><RefreshCw size={14} /></button>
        {cleanupWorkers.length > 0 && <button className="thread-cleanup" onClick={() => void cleanupIdle()} title="归档所有非运行态工兵">归档空闲 · {cleanupWorkers.length}</button>}
        {archivedWorkers.length > 0 && <button className={`thread-archived-toggle ${archivedOpen ? "open" : ""}`} onClick={() => setArchivedOpen((open) => !open)} aria-expanded={archivedOpen} title="显示已归档工兵">已归档 {archivedWorkers.length}<ChevronDown size={13} /></button>}
      </div>
      {(error || sessionsError) && <span className="thread-tabs-error" role="status">{error || sessionsError}</span>}
    </div>
    {archivedOpen && !!archivedWorkers.length && <div className="thread-archived-list" role="tablist" aria-label="已归档工兵">
      {archivedWorkers.map((worker) => <div className={`thread-tab archived ${selectedId === worker.id ? "selected" : ""}`} key={worker.id}>
        <button role="tab" aria-selected={selectedId === worker.id} className="thread-tab-select" onClick={() => onSelect(worker.id)}><span className="thread-status-dot closed" /><strong>{worker.name}</strong><span className="thread-status closed">已归档</span></button>
      </div>)}
    </div>}
    {selectedId && workers.find((worker) => worker.id === selectedId) && <WorkerTranscript
      key={`${ownerSessionId}:${selectedId}`} worker={workers.find((worker) => worker.id === selectedId)!}
      ownerSessionId={ownerSessionId} cwd={cwd} onWorkerUpdate={onWorkerUpdate} onClose={() => onSelect("")}
    />}
  </>;
}
