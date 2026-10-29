import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Archive, ChevronDown, LoaderCircle, MessageSquare, RefreshCw, Send, ShieldAlert, X } from "lucide-react";
import type { GptSessionSummary } from "../../shared/gpt-sessions";

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
function transcriptUrl(name: string, ownerSessionId: string, cwd: string, cursor?: { after?: number; before?: number }) {
  const query = new URLSearchParams({ ownerSessionId, cwd, limit: "100" });
  if (cursor?.after !== undefined) query.set("after", String(cursor.after));
  if (cursor?.before !== undefined) query.set("before", String(cursor.before));
  return `/api/gpt-sessions/${encodeURIComponent(name)}/transcript?${query}`;
}

function WorkerTranscript({ worker, ownerSessionId, cwd, onWorkerUpdate, onClose }: {
  worker: GptSessionSummary; ownerSessionId: string; cwd: string;
  onWorkerUpdate: Props["onWorkerUpdate"]; onClose: () => void;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const tail = useRef<HTMLDivElement>(null);
  const latestSequence = events.at(-1)?.sequence ?? 0;
  const latestSequenceRef = useRef(latestSequence);
  latestSequenceRef.current = latestSequence;

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let initialized = false;
    const controller = new AbortController();
    const applyPage = (page: { events?: TranscriptEvent[]; hasMore?: boolean; session?: GptSessionSummary }, mode: "replace" | "append" | "prepend") => {
      if (cancelled) return;
      if (page.session) onWorkerUpdate(page.session);
      if (mode === "replace") setEvents(page.events || []);
      else if (page.events?.length) setEvents((current) => {
        const next = mode === "append" ? [...current, ...page.events!] : [...page.events!, ...current];
        const unique = [...new Map(next.map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
        return unique.length === current.length && unique.every((event, index) => event.sequence === current[index]?.sequence)
          ? current : unique;
      });
      if (mode !== "append") setHasMore(!!page.hasMore);
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

  useEffect(() => { tail.current?.scrollIntoView({ block: "end" }); }, [events.length]);

  const loadOlder = async () => {
    const before = events[0]?.sequence;
    if (before === undefined || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const response = await fetch(transcriptUrl(worker.name, ownerSessionId, cwd, { before }), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取更早记录失败。");
      if (data.events?.length) setEvents((current) => [...data.events, ...current]);
      setHasMore(!!data.hasMore); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取更早记录失败。"); }
    finally { setLoadingOlder(false); }
  };

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
    {error && <div className="thread-error" role="alert">{error}</div>}
    <div className="worker-transcript-scroll" aria-live="polite">
      {hasMore && <button className="thread-load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder && <LoaderCircle size={13} className="spin" />}{loadingOlder ? "读取中…" : "读取更早记录"}</button>}
      {!events.length && <div className="thread-transcript-empty"><MessageSquare size={20} /><span>工兵尚无可显示记录</span></div>}
      {events.map((event) => <article className={`worker-transcript-event ${event.type}`} key={event.sequence}>
        <header><strong>{event.type === "user" || event.type === "message_sent" ? "指导" : event.type === "assistant" || event.type === "assistant_progress" ? "GPT" : event.toolName || "状态"}</strong><small>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></header>
        {event.type.startsWith("tool_") ? <details><summary>{event.type === "tool_start" ? "工具开始" : event.type === "tool_end" ? (event.isError ? "工具失败" : "工具完成") : "工具进度"} · {event.toolName || "工具"}</summary><pre>{event.text || "（无输出）"}</pre></details>
          : <p>{event.text || statusLabel(event.type)}</p>}
      </article>)}
      <div ref={tail} />
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
