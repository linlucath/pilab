import { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCw, Square, UserRound, Sparkles, Cpu, ChevronDown, Plus, LoaderCircle, Wrench } from "lucide-react";
import type { Message } from "../../shared/schema";
import type { GptSessionSummary } from "../../shared/gpt-sessions";

type WakeNotice = { names: string[]; automatic: boolean; dueAt: number };
type Props = { busy: boolean; blocked?: boolean; toolName?: string; messageCount: number; contextTokens: number; savedPercent: number; draft: string; onDraftChange: (value: string) => void; backgroundWorkers?: GptSessionSummary[]; wakeNotice?: WakeNotice | null; autoWakeEnabled: boolean; onCancelWake?: () => void; onEnableAutoWake?: () => void; onReviewWorkers?: () => void; onSend: (content: string, role: Message["role"], run: boolean) => boolean | void; onRun: () => void; onStop: () => void };
const composerRoles: Message["role"][] = ["user", "assistant", "system"];
const roleIcon = (role: Message["role"]) => role === "assistant" ? <Sparkles size={14} /> : role === "system" ? <Cpu size={14} /> : <UserRound size={14} />;
export function ComposerBar({ busy, blocked, toolName, messageCount, contextTokens, savedPercent, draft, onDraftChange, backgroundWorkers = [], wakeNotice, autoWakeEnabled, onCancelWake, onEnableAutoWake, onReviewWorkers, onSend, onRun, onStop }: Props) {
  const tokenLabel = contextTokens >= 10_000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens.toLocaleString();
  const usageLabel = `~${tokenLabel} tokens`;
  const usageTitle = `${messageCount} 条消息 · 按消息、思考过程及工具参数估算`;
  const [role, setRole] = useState<Message["role"]>("user");
  const input = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  useEffect(() => { const node = input.current; if (!node) return; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; }, [draft]);
  const submit = (run: boolean) => { if (!draft.trim() || busy || blocked) return; if (onSend(draft.trim(), role, run) === false) return; onDraftChange(""); };
  return <footer className="composer-bar">
    {!busy && backgroundWorkers.length > 0 && <div className="background-task-bar" aria-label="后台 GPT 工兵状态"><strong><Cpu size={14} />后台工兵并行中</strong><div>{backgroundWorkers.map((worker) => { const activeTool = worker.recentTools.find((tool) => tool.status === "running"); return <span className="background-task-item" key={worker.id}><b>{worker.role || worker.name}</b><small>{worker.status === "waiting_input" ? "等待输入" : activeTool ? `正在执行 ${activeTool.name}…` : worker.status === "starting" ? "正在启动…" : "正在工作…"}</small></span>; })}</div></div>}
    {wakeNotice && <div className={`worker-wake-banner ${wakeNotice.automatic ? "automatic" : "manual"}`} role="status"><span><Sparkles size={14} />{wakeNotice.names.length > 1 ? `${wakeNotice.names.length} 个 GPT 工兵` : `工兵「${wakeNotice.names[0]}」`}已交卷！{wakeNotice.automatic ? " · 1.5 秒后自动唤醒 Gemini" : busy || draft.trim() ? " · 当前有运行/输入，等待你决定" : ""}</span><div><button className="wake-review-button" onClick={() => onReviewWorkers?.()}>✨ 让 Gemini 审阅汇报</button>{wakeNotice.automatic && <button className="wake-cancel-button" onClick={onCancelWake}>取消自动唤醒</button>}{!autoWakeEnabled && <button className="wake-enable-button" onClick={onEnableAutoWake}>开启自动唤醒</button>}</div></div>}
    {busy ? <div className="composer-running"><LoaderCircle size={15} className="spin" /><span>{toolName ? <><Wrench size={13} />正在执行 {toolName}…</> : "✨ Gemini 正在思考…"}</span><small className="running-context-count" title={usageTitle}>{usageLabel}{savedPercent > 0 ? ` · 已省 ${savedPercent}%` : ""}</small><button className="stop-button" onClick={onStop}><Square size={13} fill="currentColor" />停止</button></div> : <div className="composer-card">
      <textarea ref={input} value={draft} onChange={(event) => onDraftChange(event.target.value)} onCompositionStart={() => { isComposingRef.current = true; }} onCompositionEnd={() => { isComposingRef.current = false; }} onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (isComposingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        submit(true);
      }} placeholder="给 Gemini 发消息，让我指挥 GPT 干活…" aria-label="撰写新消息" disabled={busy || blocked} />
      <div className="composer-card-footer">
        <div className="composer-footer-left"><label className="role-picker" title="选择消息角色">{roleIcon(role)}<select aria-label="新消息角色" value={role} onChange={(event) => setRole(event.target.value as Message["role"])}>{composerRoles.map((value) => <option key={value} value={value}>{value === "user" ? "User" : value === "assistant" ? "Assistant" : "System"}</option>)}</select><ChevronDown size={13} /></label><span className="context-count" title={usageTitle} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><span>{usageLabel}</span>{savedPercent > 0 && <span style={{ color: "var(--success)", fontSize: 8 }}>🧹 已省 {savedPercent}%</span>}</span></div>
        <div className="composer-footer-right"><span className="composer-shortcuts" title="Shift+Enter 换行">⏎ 发送</span><div className="composer-actions">{draft.trim() ? <><button className="add-only-button" disabled={busy} onClick={() => submit(false)}><Plus size={14} />仅添加</button><button className="send-button" disabled={busy || blocked} onClick={() => submit(true)}><ArrowUp size={15} />发送</button></> : <button className="send-button run-current" disabled={busy || blocked} onClick={onRun} title="重新运行当前上下文" style={{ minWidth: "unset", width: "auto", padding: "0 10px", fontSize: 9, fontWeight: 500, color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-soft)" }}><RotateCw size={13} />重新运行</button>}</div></div>
      </div>
    </div>}
    {blocked && <small className="composer-hint">Pi 同步会话请先在顶部应用或放弃本地修改。</small>}
  </footer>;
}
