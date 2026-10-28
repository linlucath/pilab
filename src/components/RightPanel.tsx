import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, RefreshCw, Settings2, Shield, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { ReasoningEffort, Settings } from "../../shared/schema";
import type { GptSessionSummary } from "../../shared/gpt-sessions";
import type { Run, Session } from "../workspace-store";

type ModelOption = { id: string; name: string; reasoningEfforts: ReasoningEffort[]; reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>> };
type Props = {
  session: Session; busy: boolean; runtimeCwd: string; apiKey: string; models: ModelOption[]; piConnected?: boolean; hidden?: boolean; onClose: () => void;
  piDefaultModel?: string; activeRun?: Run; onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void; onNotice: (message: string) => void;
  onApiKey: (key: string) => void; onRefreshAuth: () => void; onExport: () => void; onImport: (file?: File) => void;
  onSessionsChange?: (sessions: GptSessionSummary[]) => void;
};
const effortOrder: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const effortLabels: Record<ReasoningEffort, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
const statusLabel: Record<string, string> = { starting: "启动中", running: "运行中", idle: "空闲", waiting_input: "等待输入", interrupted: "已中断", suspended: "已挂起", closed: "已关闭", error: "异常" };
const activeStatuses = ["starting", "running", "waiting_input"];
const cleanupStatuses = ["idle", "suspended", "interrupted", "error"];

function WorkerDetails({ worker, onAction }: { worker: GptSessionSummary; onAction: (kind: "interrupt" | "close", name: string) => void }) {
  return <div className="worker-detail">
    <div className="worker-model-row"><span>模型</span><code>{worker.model}</code></div>
    <div className="worker-tools">{worker.recentTools.length ? worker.recentTools.slice(0, 6).map((tool, index) => <span key={`${tool.name}-${index}`} className={`tool-pill ${tool.status}`}>{tool.name}</span>) : <span className="no-tools">尚无近期工具活动</span>}{worker.hasUnreadReply && <span className="unread-badge">新回复</span>}</div>
    <div className="worker-reply-label">最新回复预览 {worker.hasUnreadReply && <b>未读</b>}</div><p className="worker-reply-preview">{worker.lastReplyPreview || "暂无回复内容"}</p>
    {worker.pendingQuestionCount > 0 && <div className="pending-question">等待你回答 {worker.pendingQuestionCount} 个问题</div>}
    {!!worker.recentTools.length && <div className="worker-activity-list">{worker.recentTools.map((tool, index) => <span key={`${tool.name}-${tool.at}-${index}`}><i className={tool.status} />{tool.name}<small>{new Date(tool.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></span>)}</div>}
    {activeStatuses.includes(worker.status) ? <button className="worker-action interrupt" onClick={() => onAction("interrupt", worker.name)}>中断工兵</button> : worker.status !== "closed" ? <button className="worker-action close" onClick={() => onAction("close", worker.name)}>关闭会话</button> : null}
  </div>;
}

export function RightPanel(props: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [sessions, setSessions] = useState<GptSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [cleaningIdle, setCleaningIdle] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const publishedSessions = useRef("");
  const cwd = props.session.settings.workingDirectory.trim() || props.runtimeCwd;
  const activeSessions = sessions.filter((session) => activeStatuses.includes(session.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const historySessions = sessions.filter((session) => !activeStatuses.includes(session.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleHistory = showAllHistory ? historySessions : historySessions.slice(0, 5);
  const cleanupSessions = sessions.filter((session) => cleanupStatuses.includes(session.status));
  const activeWorkers = activeSessions.length > 0;
  const publishSessions = useCallback((next: GptSessionSummary[]) => {
    setSessions(next);
    const serialized = JSON.stringify(next);
    if (serialized !== publishedSessions.current) { publishedSessions.current = serialized; props.onSessionsChange?.(next); }
  }, [props.onSessionsChange]);
  const refresh = useCallback(async (quiet = false) => {
    if (!cwd) { publishSessions([]); return; }
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/gpt-sessions?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "获取 GPT 会话失败");
      const nextSessions = Array.isArray(data.sessions) ? data.sessions as GptSessionSummary[] : [];
      publishSessions(nextSessions); setError("");
    } catch (cause) { setError((cause as Error).message); }
    finally { if (!quiet) setLoading(false); }
  }, [cwd, publishSessions]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(true), props.busy || activeWorkers ? 2000 : 4000); return () => clearInterval(timer); }, [refresh, props.busy, activeWorkers]);
  const action = async (kind: "interrupt" | "close", name: string) => {
    try {
      const response = await fetch(`/api/gpt-sessions/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "操作失败"); await refresh(true);
    } catch (cause) { setError((cause as Error).message); }
  };
  const cleanupIdle = async () => {
    if (!cleanupSessions.length || cleaningIdle || !window.confirm(`关闭 ${cleanupSessions.length} 个非运行态 GPT 工兵会话？\n${cleanupSessions.map((worker) => `· ${worker.name}（${statusLabel[worker.status] || worker.status}）`).join("\n")}`)) return;
    setCleaningIdle(true); setCleanupMessage(""); setError("");
    try {
      const response = await fetch("/api/gpt-sessions/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "清理 GPT 工兵失败");
      await refresh(true);
      if (data.failures?.length) setError(`清理完成，但有 ${data.failures.length} 个会话未关闭：${data.failures.map((item: { name: string; error: string }) => `${item.name}：${item.error}`).join("；")}`);
      else setCleanupMessage(`已清理 ${data.closed?.length ?? 0} 个非运行态工兵会话。`);
    } catch (cause) { setError((cause as Error).message); }
    finally { setCleaningIdle(false); }
  };
  const isSubscription = props.session.settings.protocol === "pi-subscription";
  const selectedModel = props.models.find((model) => model.id === props.session.settings.model);
  const availableModels = props.models.some((model) => model.id === props.session.settings.model)
    ? props.models : [{ id: props.session.settings.model, name: props.session.settings.model, reasoningEfforts: [] as ReasoningEffort[] }, ...props.models];
  const currentEffort = props.session.settings.reasoningEffort || (props.session.settings.reasoning ? "medium" : "off");
  const effortOptions: ReasoningEffort[] = isSubscription && selectedModel?.reasoningEfforts.length
    ? [...new Set<ReasoningEffort>(["off", "low", "medium", "high", ...selectedModel.reasoningEfforts])]
    : ["off", "low", "medium", "high"];
  const canUseEffort = (effort: ReasoningEffort) => !isSubscription || !selectedModel?.reasoningEfforts.length || selectedModel.reasoningEfforts.includes(effort);
  const chooseModel = (modelId: string, subscription = isSubscription) => {
    const model = props.models.find((item) => item.id === modelId);
    props.onSetting("model", modelId);
    if (!subscription || !model?.reasoningEfforts.length || model.reasoningEfforts.includes(currentEffort)) return;
    const supported = new Set<ReasoningEffort>(model.reasoningEfforts);
    const currentIndex = effortOrder.indexOf(currentEffort);
    const adjusted = effortOrder.filter((effort) => supported.has(effort)).sort((left, right) => Math.abs(effortOrder.indexOf(left) - currentIndex) - Math.abs(effortOrder.indexOf(right) - currentIndex))[0] || "off";
    props.onSetting("reasoningEffort", adjusted);
    props.onSetting("reasoning", adjusted !== "off");
    props.onNotice(`${model.name} 不支持 ${effortLabels[currentEffort]} 推理强度，已自动调整为 ${effortLabels[adjusted]}。`);
  };
  const toggleWorker = (id: string) => setExpanded((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  return <aside className="right-panel" aria-label="工作台配置" hidden={props.hidden}>
    <section className="panel-section primary-settings" style={{ order: 1, padding: "13px 16px" }}>
      <div className="right-heading" style={{ marginBottom: 10 }}><div><span className="heading-icon"><Settings2 size={16} /></span><div><strong>模型与环境</strong><small>当前会话的运行配置</small></div></div><div className="right-heading-actions"><span className="local-lock"><Shield size={13} />本地</span><button className="icon-button panel-close" type="button" aria-label="关闭工作台" title="关闭工作台" onClick={props.onClose}><X size={16} /></button></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", rowGap: 8 }}>
        <div><label className="field-label" htmlFor="working-directory" style={{ margin: "0 0 4px" }}>工作目录</label><input id="working-directory" className="field-input path-input" style={{ height: 34, padding: "0 8px" }} value={props.session.settings.workingDirectory} onChange={(event) => props.onSetting("workingDirectory", event.target.value)} placeholder={props.runtimeCwd || "服务端默认目录"} disabled={props.busy} /></div>
        <div><label className="field-label" htmlFor="main-model" style={{ margin: "0 0 4px" }}>主模型</label>{isSubscription && props.models.length ? <select id="main-model" className="field-input" style={{ height: 34, padding: "0 8px" }} value={props.session.settings.model} onChange={(event) => chooseModel(event.target.value)} disabled={props.busy}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select> : <input id="main-model" className="field-input" style={{ height: 34, padding: "0 8px" }} value={props.session.settings.model} onChange={(event) => props.onSetting("model", event.target.value)} disabled={props.busy} />}<div className="auth-line" style={{ marginTop: 3 }}><span className={props.piConnected ? "auth-ok" : "auth-wait"}><i />{props.piConnected ? "Pi 登录已连接" : props.piConnected === false ? "Pi 尚未登录" : "检查 Pi 状态中"}</span><button className="icon-button" style={{ width: 24, height: 24 }} title="刷新 Pi 登录状态" aria-label="刷新 Pi 登录状态" onClick={props.onRefreshAuth}><RefreshCw size={13} /></button></div></div>
        <div><label className="field-label" style={{ margin: "0 0 4px" }}>思考强度</label><div className="segmented effort-segment" style={{ padding: 2 }}>{effortOptions.map((effort) => <button key={effort} className={currentEffort === effort ? "selected" : ""} style={{ minHeight: 25 }} disabled={props.busy || !canUseEffort(effort)} onClick={() => { props.onSetting("reasoningEffort", effort); props.onSetting("reasoning", effort !== "off"); }}>{effortLabels[effort]}</button>)}</div></div>
        <div><label className="field-label" style={{ margin: "0 0 4px" }}>工具模式</label><div className="segmented mode-segment" style={{ padding: 2 }}>{([ ["agent", "Agent"], ["none", "关闭"] ] as const).map(([mode, label]) => <button key={mode} className={props.session.settings.toolMode === mode ? "selected" : ""} style={{ minHeight: 25 }} disabled={props.busy} onClick={() => props.onSetting("toolMode", mode)}>{label}</button>)}</div></div>
      </div>
    </section>
    <section className="worker-panel" style={{ order: 0 }}>
      <header className="worker-heading"><div><span className="worker-icon">✦</span><div><strong>GPT 工兵实况</strong><small>{sessions.length} 个会话 · {activeWorkers ? `${activeSessions.length} 个正在工作` : "后台待命"}</small></div></div><div className="worker-heading-actions"><button className="worker-cleanup-button" disabled={!cleanupSessions.length || cleaningIdle} onClick={() => void cleanupIdle()} title="关闭空闲、挂起、中断或异常的 GPT 工兵"><Trash2 size={13} />{cleaningIdle ? "清理中…" : `清理空闲${cleanupSessions.length ? ` · ${cleanupSessions.length}` : ""}`}</button><button className={`icon-button ${loading ? "spinning" : ""}`} onClick={() => void refresh()} title="刷新 GPT 会话" aria-label="刷新 GPT 会话"><RefreshCw size={15} /></button></div></header>
      {cleanupMessage && <div className="worker-cleanup-message" role="status">{cleanupMessage}</div>}
      {error && <div className="worker-error"><span>{error}</span><button onClick={() => setError("")} aria-label="清除错误"><X size={13} /></button></div>}
      {!sessions.length ? <div className="worker-empty"><span>🛠️</span><strong>暂未派出 GPT 工兵</strong><p>直接给 Gemini 发消息即可自动调度。</p></div> : <div className="worker-list">
        {!!activeSessions.length && <div className="active-worker-list">{activeSessions.map((worker) => <article className={`worker-card active-worker-card ${worker.status}`} key={worker.id}>
          <header className="worker-card-head active-worker-head"><span className={`worker-state-dot ${worker.status}`} /><span className="worker-name"><strong>{worker.name}</strong></span><span className="worker-role-badge">{worker.role || "工兵"}</span><span className={`worker-status ${worker.status}`}>{statusLabel[worker.status] || worker.status}</span></header>
          <WorkerDetails worker={worker} onAction={(kind, name) => void action(kind, name)} />
        </article>)}</div>}
        {!!historySessions.length && <div className="worker-history-list">{visibleHistory.map((worker) => <article className="worker-history-item" key={worker.id}>
          <button className="worker-history-row" aria-expanded={expanded.includes(worker.id)} onClick={() => toggleWorker(worker.id)}><span className={`worker-state-dot ${worker.status}`} /><span className="worker-history-name">{worker.name}</span>{worker.role && <span className="worker-role-badge">{worker.role}</span>}<span className="worker-history-tools">{worker.recentTools.length} 工具</span><span className={`worker-status ${worker.status}`}>{statusLabel[worker.status] || worker.status}</span><ChevronDown className={expanded.includes(worker.id) ? "rotated" : ""} size={14} /></button>
          {expanded.includes(worker.id) && <WorkerDetails worker={worker} onAction={(kind, name) => void action(kind, name)} />}
        </article>)}</div>}
        {historySessions.length > 5 && <button className="worker-history-toggle" onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? "收起历史会话" : `查看全部 (${historySessions.length})`}<ChevronDown className={showAllHistory ? "rotated" : ""} size={13} /></button>}
      </div>}
    </section>
    <section className="panel-section advanced-section" style={{ order: 2 }}><button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}><span><SlidersHorizontal size={15} />高级设置与调试</span><ChevronDown size={15} className={advanced ? "rotated" : ""} /></button>{advanced && <div className="advanced-content">
      <label className="field-label" htmlFor="protocol">接口协议</label><select id="protocol" className="field-input" value={props.session.settings.protocol} onChange={(event) => { const protocol = event.target.value as Settings["protocol"]; props.onSetting("protocol", protocol); if (protocol === "pi-subscription" && props.piDefaultModel) chooseModel(props.piDefaultModel, true); }} disabled={props.busy}><option value="pi-subscription">Pi 本地登录 · Gemini / GPT</option><option value="openai-completions">Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select>
      {!isSubscription && <><label className="field-label" htmlFor="base-url">连接设置 · Base URL</label><input id="base-url" className="field-input mono-input" value={props.session.settings.baseUrl} onChange={(event) => props.onSetting("baseUrl", event.target.value)} /><label className="field-label" htmlFor="api-key">API Key <small>仅当前浏览器会话保存</small></label><input id="api-key" className="field-input mono-input" type="password" autoComplete="off" value={props.apiKey} onChange={(event) => props.onApiKey(event.target.value)} /></>}
      <label className="field-label" htmlFor="temperature">Temperature <small>{props.session.settings.temperature.toFixed(2)}</small></label><input id="temperature" className="range-input" type="range" min="0" max="2" step="0.05" value={props.session.settings.temperature} onChange={(event) => props.onSetting("temperature", +event.target.value)} disabled={props.busy || isSubscription || currentEffort !== "off"} />
      <label className="field-label" htmlFor="max-tokens">最大输出 Tokens</label><input id="max-tokens" className="field-input mono-input" type="number" min="1" max="128000" value={props.session.settings.maxTokens} onChange={(event) => props.onSetting("maxTokens", +event.target.value)} disabled={props.busy} />
      <label className="field-label" htmlFor="max-turns">最大 Agent 轮数</label><input id="max-turns" className="field-input mono-input" type="number" min="1" max="50" value={props.session.settings.maxTurns} onChange={(event) => props.onSetting("maxTurns", +event.target.value)} disabled={props.busy} />
      <div className="io-actions"><button onClick={props.onExport}>导出会话 JSON</button><button onClick={() => fileInput.current?.click()}>导入 JSON</button><input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => { props.onImport(event.target.files?.[0]); event.target.value = ""; }} /></div>
      <div className="run-metrics"><div><small>输入</small><strong>{props.activeRun?.usage?.input?.toLocaleString() || "—"}</strong></div><div><small>输出</small><strong>{props.activeRun?.usage?.output?.toLocaleString() || "—"}</strong></div><div><small>耗时</small><strong>{props.activeRun ? `${(props.activeRun.elapsed / 1000).toFixed(1)}s` : "—"}</strong></div></div>
    </div>}</section>
    <footer className="right-footer" style={{ order: 3 }}><Activity size={13} />上下文消息 {props.session.messages.filter((message) => message.enabled).length} 条<span>·</span><span>{cwd.split(/[\\/]/).at(-1) || "本机"}</span></footer>
  </aside>;
}
