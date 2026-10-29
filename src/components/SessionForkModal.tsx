import { useState } from "react";
import { Dna, Sparkles, X } from "lucide-react";
import type { Session } from "../workspace-store";

type Props = {
  session: Session;
  canUseSmartFork: boolean;
  onClose: () => void;
  onCreate: (title: string, memory: string, keepRecentTurns: number) => void;
  onSmartFork: (title: string, keepRecentTurns: number) => void;
};

export function SessionForkModal({ session, canUseSmartFork, onClose, onCreate, onSmartFork }: Props) {
  const [title, setTitle] = useState(`${session.title || "新建对话"} · 提纯分身`);
  const [memory, setMemory] = useState("");
  const [keepRecentTurns, setKeepRecentTurns] = useState(0);
  return <div className="session-fork-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="session-fork-modal" role="dialog" aria-modal="true" aria-labelledby="session-fork-title">
      <header><span className="fork-modal-icon"><Dna size={18} /></span><div><h2 id="session-fork-title">提纯会话分身</h2><p>保留原会话不变，创建一个更轻、更聚焦的新实验。</p></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
      <label className="fork-field">新分身名称<input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：PPT · 视觉优化分身" /></label>
      <label className="fork-field">记忆结晶 <small>目标、约束、偏好、关键决定与待办</small><textarea value={memory} onChange={(event) => setMemory(event.target.value)} maxLength={20_000} placeholder="可以自己写一段提纯记忆；也可以让 Gemini 阅读完整对话并自动提炼。" /></label>
      <div className="fork-carry-row"><span><strong>携带近期对话轮数</strong><small>默认 0：只带 System 人设与记忆结晶，创建干净前缀</small></span><select aria-label="携带近期对话轮数" value={keepRecentTurns} onChange={(event) => setKeepRecentTurns(Number(event.target.value))}>{[0, 1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count} 轮</option>)}</select></div>
      {!canUseSmartFork && <p className="fork-mode-hint">当前运行或 Pi 同步状态不支持智能提纯；你仍可手动填写记忆并直接创建。</p>}
      <footer><button className="fork-cancel" onClick={onClose}>取消</button><button className="fork-create" disabled={!memory.trim() || !title.trim()} onClick={() => onCreate(title.trim(), memory.trim(), keepRecentTurns)}>即刻创建并切换</button><button className="fork-smart" disabled={!canUseSmartFork || !title.trim()} onClick={() => onSmartFork(title.trim(), keepRecentTurns)}><Sparkles size={14} />Gemini 提纯并生成切换卡片</button></footer>
    </section>
  </div>;
}
