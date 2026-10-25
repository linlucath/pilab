import { useState } from "react";
import { Braces, RotateCcw } from "lucide-react";
import type { Message, Settings } from "../../shared/schema";
import type { Run } from "../workspace-store";
import { statusText } from "../utils/session";

type Props = { runs: Run[]; activeId?: string; onSelect: (id: string) => void; onRestore: (settings: Settings, messages: Message[]) => void; onInspect: (id: string) => void };
export function RunHistory({ runs, activeId, onSelect, onRestore, onInspect }: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!runs.length) return <div className="history-empty"><span>◷</span><small>RUN HISTORY</small><h2>还没有运行记录</h2><p>编辑上下文后，在底部点击「运行当前上下文」。</p></div>;
  return <div className="run-history">{runs.map((run, index) => <article key={run.id} className={`history-card ${run.id === activeId ? "active" : ""}`}>
    <header><button className="history-title" onClick={() => onSelect(run.id)}><i className={`run-indicator ${run.status}`} />运行 {runs.length - index}<small>{new Date(run.at).toLocaleString("zh-CN")}</small></button><button className="text-button" onClick={() => onRestore(run.snapshot.settings, structuredClone(run.snapshot.messages))}><RotateCcw size={13} />恢复输入</button></header>
    <div className="history-meta">{run.snapshot.settings.model} · reasoning {run.snapshot.settings.reasoningEffort || "off"}</div><p className={run.error ? "error-text" : ""}>{run.error || run.output || (run.status === "running" ? "正在等待模型响应…" : "无文本输出")}</p>
    {run.thinking && <details><summary>思考内容</summary><pre>{run.thinking}</pre></details>}
    {!!run.trace?.some((message) => message.toolCalls?.length || message.role === "tool") && <details open={expanded.includes(run.id)} onToggle={(event) => { const isOpen = event.currentTarget.open; setExpanded((current) => isOpen ? [...new Set([...current, run.id])] : current.filter((value) => value !== run.id)); }}><summary>工具轨迹 · {run.trace.filter((message) => message.role === "tool").length} 个结果 · {run.turns || 0} 轮</summary><div className="history-trace">{run.trace.map((message) => <div key={message.id}><strong>{message.toolName || (message.toolCalls?.length ? "Gemini 工具调用" : message.role)}</strong>{message.toolCalls?.map((call) => <pre key={call.id}>{call.name}({call.arguments})</pre>)}{message.content && <pre>{message.content}</pre>}</div>)}</div></details>}
    <footer><span>{statusText(run.status)}</span><span>{(run.elapsed / 1000).toFixed(1)}s{run.usage ? ` · ${run.usage.input + run.usage.output} tokens` : ""}</span><button onClick={() => onInspect(run.id)}><Braces size={13} />请求</button></footer>
  </article>)}</div>;
}
