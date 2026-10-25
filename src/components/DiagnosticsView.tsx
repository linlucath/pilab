import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clipboard, RefreshCw, Trash2 } from "lucide-react";

type Category = "all" | "server" | "run" | "gpt" | "client";
type DiagnosticEntry = { at?: string | number; timestamp?: string | number; category: string; event: string; level?: string; message?: string; [key: string]: unknown };
const categories: { value: Category; label: string }[] = [
  { value: "all", label: "全部类别" }, { value: "server", label: "服务" },
  { value: "run", label: "运行" }, { value: "gpt", label: "GPT 工兵" }, { value: "client", label: "前端" },
];
const entryText = (entry: DiagnosticEntry) => {
  try { return JSON.stringify(entry, null, 2); } catch { return `${entry.category}: ${entry.event}`; }
};
const entryTime = (entry: DiagnosticEntry) => {
  const raw = entry.at || entry.timestamp;
  const value = typeof raw === "number" ? raw : raw ? Date.parse(raw) : 0;
  return Number.isFinite(value) ? value : 0;
};

export function DiagnosticsView() {
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/logs?category=${category}&limit=500`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const rows = Array.isArray(data.logs) ? data.logs : Array.isArray(data.entries) ? data.entries : Array.isArray(data.events) ? data.events : [];
      const valid = rows.filter((entry: unknown): entry is DiagnosticEntry => !!entry && typeof entry === "object" && typeof (entry as DiagnosticEntry).category === "string" && typeof (entry as DiagnosticEntry).event === "string");
      setEntries(valid.sort((a: DiagnosticEntry, b: DiagnosticEntry) => entryTime(b) - entryTime(a)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, [category]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => !needle || entryText(entry).toLocaleLowerCase().includes(needle));
  }, [entries, query]);
  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(visibleEntries.map(entryText).join("\n"));
      setNotice(`已复制 ${visibleEntries.length} 条日志`);
    } catch { setNotice("复制失败，请检查浏览器剪贴板权限"); }
  };
  const clearLogs = async () => {
    if (!window.confirm("确定清空本机诊断日志吗？此操作不可撤销。")) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/logs", { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEntries([]); setNotice("诊断日志已清空");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  return <section className="diagnostics-view" aria-label="诊断日志">
    <header className="diagnostics-header">
      <div><h1>诊断日志</h1><p>本机 Flight Recorder · 最近 {entries.length} 条 · 自动刷新间隔 15 秒</p></div>
      <div className="diagnostics-actions">
        <button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新</button>
        <button onClick={() => void copyLogs()} disabled={!visibleEntries.length}><Clipboard size={14} />复制结果</button>
        <button className="diagnostics-clear" onClick={() => void clearLogs()} disabled={loading}><Trash2 size={14} />清空日志</button>
      </div>
    </header>
    <div className="diagnostics-filters">
      <label>类别<select value={category} onChange={(event) => setCategory(event.target.value as Category)}>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <input aria-label="搜索诊断日志" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、错误或 runId…" />
      <span>{visibleEntries.length} 条</span>
    </div>
    {error && <div className="diagnostics-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="diagnostics-notice" role="status">{notice}</div>}
    <div className="diagnostics-list">
      {visibleEntries.length ? visibleEntries.map((entry, index) => {
        const raw = entryText(entry);
        const date = entry.at || entry.timestamp;
        const displayTime = date ? new Date(date).toLocaleString() : "时间未知";
        const summary = [entry.message, entry.runId, entry.sessionId].find((value): value is string => typeof value === "string") || "";
        return <details className={`diagnostic-entry ${entry.level === "error" || /error|failed|unexpected_eof/i.test(entry.event) ? "error" : ""}`} key={`${date || "entry"}-${entry.event}-${index}`}>
          <summary><time>{displayTime}</time><span className={`diagnostic-category ${entry.category}`}>{entry.category}</span><strong>{entry.event}</strong>{entry.level && <small>{entry.level}</small>}<span className="diagnostic-summary">{summary}</span></summary>
          <pre>{raw}</pre>
        </details>;
      }) : <div className="diagnostics-empty">{loading ? "正在读取诊断日志…" : "没有符合条件的日志"}</div>}
    </div>
  </section>;
}
