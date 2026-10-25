import { useState } from "react";
import { AlignLeft, ArrowDown, ArrowUp, Copy } from "lucide-react";
import type { Run } from "../workspace-store";

type Props = { draft: unknown; activeRun?: Run; onCopy: (text: string) => void };
function JsonPanel({ title, value, compact, wrap }: { title: string; value: unknown; compact: boolean; wrap: boolean }) {
  const source = typeof value === "string" ? value : JSON.stringify(value, null, compact ? 0 : 2) ?? "null";
  return <section className="inspector-panel"><div className="inspector-panel-heading"><strong>{title}</strong><small>{source.split("\n").length} 行</small></div><pre className={`json-panel ${wrap ? "wrap" : ""}`}><code>{source}</code></pre></section>;
}
export function RequestInspector({ draft, activeRun, onCopy }: Props) {
  const [compact, setCompact] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [allOpen, setAllOpen] = useState(true);
  const requests = activeRun?.requests?.length ? activeRun.requests : activeRun?.request ? [activeRun.request] : [];
  const copyValue = requests.length > 1 ? requests : activeRun?.request || draft;
  return <div className="inspector-view">
    <div className="inspector-toolbar"><div><strong>请求检查</strong><span>当前配置与实际请求</span></div><div className="inspector-actions"><button onClick={() => setAllOpen((value) => !value)}>{allOpen ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{allOpen ? "收起全部" : "展开全部"}</button><button onClick={() => setCompact((value) => !value)}>{compact ? "美化 JSON" : "紧凑 JSON"}</button><button className={wrap ? "active" : ""} onClick={() => setWrap((value) => !value)}><AlignLeft size={14} />换行</button><button onClick={() => onCopy(JSON.stringify(copyValue, null, compact ? 0 : 2))}><Copy size={14} />复制 JSON</button></div></div>
    <JsonPanel title="当前配置与消息草稿" value={draft} compact={compact} wrap={wrap} />
    <section className="inspector-panel"><div className="inspector-panel-heading"><strong>本次运行 · 实际请求体</strong><small>{requests.length} 轮</small></div>{requests.length ? requests.map((request, index) => <details key={index} className="request-turn" open={allOpen}><summary>第 {index + 1} 轮请求</summary><pre className={`json-panel ${wrap ? "wrap" : ""}`}><code>{JSON.stringify(request, null, compact ? 0 : 2)}</code></pre></details>) : <div className="request-empty">尚未产生运行请求。实际请求会显示在这里。</div>}</section>
  </div>;
}
