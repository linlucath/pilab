import { useRef, useState } from "react";
import { Activity, ChevronDown, RefreshCw, Settings2, Shield, SlidersHorizontal, X } from "lucide-react";
import type { ReasoningEffort, Settings } from "../../shared/schema";
import type { Run, Session } from "../workspace-store";

type ModelOption = { id: string; name: string; reasoningEfforts: ReasoningEffort[]; reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>> };
type Props = {
  session: Session; busy: boolean; runtimeCwd: string; apiKey: string; models: ModelOption[]; piConnected?: boolean; hidden?: boolean; onClose: () => void;
  piDefaultModel?: string; activeRun?: Run; onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void; onNotice: (message: string) => void;
  onApiKey: (key: string) => void; onRefreshAuth: () => void; onExport: () => void; onImport: (file?: File) => void;
};
const effortOrder: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const effortLabels: Record<ReasoningEffort, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
export function RightPanel(props: Props) {
  const [advanced, setAdvanced] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cwd = props.session.settings.workingDirectory.trim() || props.runtimeCwd;
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
