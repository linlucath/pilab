import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, RotateCcw, Search, Sparkles, Zap } from "lucide-react";
import { getReasoningEffort, reasoningEfforts, type ReasoningEffort, type Settings } from "../../shared/schema";

export type ModelOption = {
  id: string;
  name: string;
  reasoningEfforts: ReasoningEffort[];
  reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>>;
};
type Picker = "model" | "reasoning" | null;
type Props = {
  settings: Pick<Settings, "protocol" | "model" | "reasoning" | "reasoningEffort">;
  models: ModelOption[];
  defaultModel?: string;
  piConnected?: boolean;
  busy?: boolean;
  blocked?: boolean;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onNotice: (message: string) => void;
  onRefreshModels: () => void;
};

const effortLabels: Record<ReasoningEffort, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max",
};
const effortOrder: ReasoningEffort[] = [...reasoningEfforts];

function providerName(model: ModelOption) {
  const provider = model.id.split("/")[0];
  return provider === model.id ? "其他模型" : provider;
}

export function ComposerModelControls({ settings, models, defaultModel, piConnected, busy = false, blocked = false, onSetting, onNotice, onRefreshModels }: Props) {
  const [picker, setPicker] = useState<Picker>(null);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const disabled = busy || blocked;
  const isSubscription = settings.protocol === "pi-subscription";
  const catalog = isSubscription ? models : [];
  const selectedModel = catalog.find((model) => model.id === settings.model);
  const currentEffort = getReasoningEffort(settings);
  // This list is canonical (Off → Minimal → Low → Medium → High → XHigh → Max).
  // Model capabilities only disable unsupported points; they never control visual order.
  const effortOptions: ReasoningEffort[] = [...reasoningEfforts];
  const canUseEffort = (effort: ReasoningEffort) => !isSubscription || !selectedModel?.reasoningEfforts.length || selectedModel.reasoningEfforts.includes(effort);
  const resetEffort = isSubscription && selectedModel?.reasoningEfforts.length
    ? [...effortOrder].reverse().find((effort) => selectedModel.reasoningEfforts.includes(effort)) || "off"
    : "high";
  const recommended = useMemo(() => {
    const preferred = [defaultModel, settings.model]
      .map((id) => catalog.find((model) => model.id === id))
      .filter((model): model is ModelOption => !!model);
    return [...new Map((preferred.length ? preferred : catalog.slice(0, 3)).map((model) => [model.id, model])).values()];
  }, [catalog, defaultModel, settings.model]);
  const filtered = catalog.filter((model) => `${model.name} ${model.id} ${providerName(model)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const groupedModels = filtered.reduce((groups, model) => {
    const provider = providerName(model);
    groups.set(provider, [...(groups.get(provider) || []), model]);
    return groups;
  }, new Map<string, ModelOption[]>());
  const groups = [...groupedModels.entries()].sort(([left], [right]) => left.localeCompare(right));

  useEffect(() => {
    if (!picker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPicker(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picker]);

  const chooseModel = (model: ModelOption) => {
    if (disabled) return;
    onSetting("model", model.id);
    const allowed = model.reasoningEfforts;
    if (allowed.length && !allowed.includes(currentEffort)) {
      const supported = new Set(allowed);
      const currentIndex = effortOrder.indexOf(currentEffort);
      const adjusted = effortOrder.filter((effort) => supported.has(effort))
        .sort((left, right) => Math.abs(effortOrder.indexOf(left) - currentIndex) - Math.abs(effortOrder.indexOf(right) - currentIndex))[0] || "off";
      onSetting("reasoningEffort", adjusted);
      onSetting("reasoning", adjusted !== "off");
      onNotice(`${model.name} 不支持 ${effortLabels[currentEffort]} 推理强度，已自动调整为 ${effortLabels[adjusted]}。`);
    }
    setPicker(null);
    setSearch("");
  };
  const chooseEffort = (effort: ReasoningEffort) => {
    if (disabled || !effortOptions.includes(effort)) return;
    onSetting("reasoningEffort", effort);
    onSetting("reasoning", effort !== "off");
    setPicker(null);
  };
  const resetReasoning = () => {
    if (disabled) return;
    onSetting("reasoningEffort", resetEffort);
    onSetting("reasoning", resetEffort !== "off");
  };

  return <div className="composer-model-controls" ref={root}>
    <div className="composer-control-anchor">
      <button type="button" className={`composer-model-pill ${picker === "model" ? "active" : ""}`} disabled={disabled}
        aria-haspopup="dialog" aria-expanded={picker === "model"} aria-label={`选择模型，当前 ${selectedModel?.name || settings.model}`}
        onClick={() => setPicker((current) => current === "model" ? null : "model")}>
        <Sparkles size={13} /><strong>{selectedModel?.name || settings.model || "选择模型"}</strong><ChevronDown size={13} />
      </button>
      {picker === "model" && <section className="composer-picker composer-model-picker" role="dialog" aria-label="选择模型">
        <header className="composer-picker-heading"><span><Sparkles size={15} /><strong>模型</strong></span><small>{isSubscription ? (piConnected === false ? "Pi 未连接" : `${catalog.length} 个可用模型`) : "当前接口"}</small></header>
        {isSubscription && <label className="composer-model-search"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型或供应商" aria-label="搜索模型" /></label>}
        {isSubscription && !search && recommended.length > 0 && <div className="composer-model-group"><small>推荐模型</small>{recommended.map((model) => <ModelChoice key={`recommended-${model.id}`} model={model} selected={settings.model === model.id} onClick={() => chooseModel(model)} />)}</div>}
        {isSubscription && <div className="composer-model-list">
          {!catalog.length ? <div className="composer-picker-empty">{piConnected === false ? "Pi 登录尚未连接，暂时没有可选模型。" : "正在读取 Pi 模型目录，或输入自定义模型 ID。"}</div> : groups.map(([provider, options]) => <div className="composer-model-group" key={provider}>
            <small>{provider}</small>{options.map((model) => <ModelChoice key={model.id} model={model} selected={settings.model === model.id} onClick={() => chooseModel(model)} />)}
          </div>)}
        </div>}
        <label className="composer-custom-model"><span>自定义模型 ID</span><input value={settings.model} disabled={disabled} onChange={(event) => onSetting("model", event.target.value)} aria-label="自定义模型 ID" /></label>
        {isSubscription && <button type="button" className="composer-refresh-models" onClick={onRefreshModels}><RefreshCw size={13} />刷新模型目录</button>}
      </section>}
    </div>
    <div className="composer-control-anchor">
      <button type="button" className={`composer-effort-pill ${picker === "reasoning" ? "active" : ""}`} disabled={disabled}
        aria-haspopup="dialog" aria-expanded={picker === "reasoning"} aria-label={`推理强度 ${effortLabels[currentEffort]}`}
        onClick={() => setPicker((current) => current === "reasoning" ? null : "reasoning")}>
        <Zap size={13} /><span>{effortLabels[currentEffort]}</span><ChevronDown size={12} />
      </button>
      {picker === "reasoning" && <section className="composer-picker composer-reasoning-picker" role="dialog" aria-label="选择推理强度">
        <header className="composer-picker-heading"><span><Zap size={15} /><strong>{effortLabels[currentEffort]} · {selectedModel?.name || settings.model}</strong></span><button type="button" className="composer-effort-reset" onClick={resetReasoning} disabled={disabled} aria-label="重置推理强度" title={`重置为 ${effortLabels[resetEffort]}`}><RotateCcw size={12} />重置</button></header>
        <p>选择此模型后续运行使用的推理档位。</p>
        <div className="composer-effort-scale" role="group" aria-label="推理强度档位">
          {effortOptions.map((effort) => <button type="button" key={effort} className={`composer-effort-point ${currentEffort === effort ? "selected" : ""}`}
            disabled={disabled || !canUseEffort(effort)} aria-pressed={currentEffort === effort} title={effortLabels[effort]} onClick={() => chooseEffort(effort)}>
            <i aria-hidden="true" /><span>{effortLabels[effort]}</span>
          </button>)}
        </div>
        {isSubscription && selectedModel?.reasoningEfforts.length ? <small className="composer-picker-footnote">档位由当前模型能力决定。</small> : null}
      </section>}
    </div>
  </div>;
}

function ModelChoice({ model, selected, onClick }: { model: ModelOption; selected: boolean; onClick: () => void }) {
  return <button type="button" className={`composer-model-option ${selected ? "selected" : ""}`} onClick={onClick} role="option" aria-selected={selected}>
    <span><strong>{model.name}</strong><small>{model.id}</small></span>{selected && <Check size={14} />}
  </button>;
}
