import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Search, Zap } from "lucide-react";
import { nearestSupportedReasoningEffort, reasoningEfforts, type ReasoningEffort, type Settings } from "../../shared/schema";
import { DEFAULT_SUBAGENT_MODELS, type SubagentModelOption } from "../../shared/subagent-models";

type Props = {
  model?: string;
  thinkingLevel?: ReasoningEffort;
  models: readonly SubagentModelOption[];
  subagentConnected?: boolean;
  disabled?: boolean;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onNotice: (message: string) => void;
};
type Picker = "model" | "thinking" | null;

const effortLabels: Record<ReasoningEffort, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max",
};

function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    antigravity: "Google Gemini",
    deepseek: "DeepSeek",
    google: "Google",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    openrouter: "OpenRouter",
  };
  return labels[provider] || provider;
}

export function ComposerSubagentModelPicker({ model, thinkingLevel, models, subagentConnected, disabled = false, onSetting, onNotice }: Props) {
  const selectedModel = model?.trim() || DEFAULT_SUBAGENT_MODELS[0].id;
  const currentEffort = thinkingLevel || "max";
  const [picker, setPicker] = useState<Picker>(null);
  const [search, setSearch] = useState("");
  const [thinkingMenuLeft, setThinkingMenuLeft] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const thinkingButton = useRef<HTMLButtonElement>(null);
  const thinkingPicker = useRef<HTMLElement>(null);
  const selectedModelOption = models.find((candidate) => candidate.id === selectedModel);
  const supportedEfforts = selectedModelOption?.reasoningEfforts;
  const availableEfforts = supportedEfforts?.length ? supportedEfforts : undefined;
  const canUseEffort = (effort: ReasoningEffort) => !availableEfforts || availableEfforts.includes(effort);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter((candidate) => !query ||
      `${candidate.id} ${candidate.name} ${candidate.provider} ${providerLabel(candidate.provider)} ${candidate.description || ""}`.toLowerCase().includes(query));
  }, [models, search]);
  const grouped = useMemo(() => {
    const providers = new Map<string, SubagentModelOption[]>();
    for (const candidate of filtered) {
      const options = providers.get(candidate.provider) || [];
      options.push(candidate);
      providers.set(candidate.provider, options);
    }
    return [...providers.entries()].sort(([left], [right]) => providerLabel(left).localeCompare(providerLabel(right)));
  }, [filtered]);

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

  useLayoutEffect(() => {
    if (picker !== "thinking") return;
    const positionPicker = () => {
      const trigger = thinkingButton.current?.getBoundingClientRect();
      const panel = thinkingPicker.current?.getBoundingClientRect();
      const container = root.current?.getBoundingClientRect();
      if (!trigger || !panel || !container) return;
      const viewportMargin = 12;
      const rightmost = window.innerWidth - panel.width - viewportMargin;
      const clampedLeft = Math.max(viewportMargin, Math.min(trigger.right - panel.width, rightmost));
      setThinkingMenuLeft(clampedLeft - container.left);
    };
    positionPicker();
    window.addEventListener("resize", positionPicker);
    window.addEventListener("scroll", positionPicker, true);
    return () => {
      window.removeEventListener("resize", positionPicker);
      window.removeEventListener("scroll", positionPicker, true);
    };
  }, [picker]);

  const chooseModel = (option: SubagentModelOption) => {
    if (disabled) return;
    onSetting("defaultSubagentModel", option.id);
    const allowed = option.reasoningEfforts;
    if (allowed?.length && !allowed.includes(currentEffort)) {
      const adjusted = nearestSupportedReasoningEffort(currentEffort, allowed);
      onSetting("defaultSubagentThinkingLevel", adjusted);
      onNotice(`${option.name} 不支持 ${effortLabels[currentEffort]} 推理强度，已自动调整为 ${effortLabels[adjusted]}。`);
    }
    setPicker(null);
    setSearch("");
  };
  const chooseEffort = (effort: ReasoningEffort) => {
    if (disabled || !canUseEffort(effort)) return;
    onSetting("defaultSubagentThinkingLevel", effort);
    setPicker(null);
  };

  return <div className="composer-subagent-controls" ref={root}>
    <div className="composer-subagent-control">
      <button
        type="button"
        className={`composer-subagent-pill ${picker === "model" ? "active" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={picker === "model"}
        aria-label={`工兵模型 ${selectedModel}`}
        title={`默认工兵模型：${selectedModel}`}
        onClick={() => setPicker((current) => current === "model" ? null : "model")}
      >
        <Bot size={14} aria-hidden="true" />
        <strong>{selectedModel}</strong>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {picker === "model" && <section className="composer-picker composer-subagent-picker" role="dialog" aria-label="选择工兵模型">
        <header className="composer-picker-heading">
          <span><Bot size={15} /><strong>工兵模型</strong></span>
          <small>{models.length} 个候选模型{subagentConnected === false ? " · 未检测到已认证模型" : ""}</small>
        </header>
        <label className="composer-model-search">
          <Search size={14} />
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型或供应商" aria-label="搜索工兵模型" />
        </label>
        <div className="composer-subagent-list" role="listbox" aria-label="工兵模型列表">
          {!filtered.length ? <div className="composer-picker-empty">没有匹配的工兵模型。</div> : grouped.map(([provider, options]) => <div className="composer-subagent-provider" role="group" aria-label={providerLabel(provider)} key={provider}>
            <div className="composer-subagent-provider-heading">{providerLabel(provider)}<span>{options.length}</span></div>
            {options.map((option) => {
              const selected = selectedModel === option.id;
              return <button
                type="button"
                className={`composer-subagent-option ${selected ? "selected" : ""}`}
                key={option.id}
                role="option"
                aria-selected={selected}
                onClick={() => chooseModel(option)}
              >
                <span className="composer-subagent-option-copy">
                  <strong>{option.name || option.id}</strong>
                  <small>{option.provider} · {option.id}</small>
                  {option.description && <em>{option.description}</em>}
                </span>
                {selected && <Check size={15} aria-label="当前选中" />}
              </button>;
            })}
          </div>)}
        </div>
        <footer className="composer-subagent-footnote">
          <span><Bot size={13} />为新工兵任务选择运行模型</span>
          {subagentConnected === false && <small>请在 Pi 中为所选供应商配置认证</small>}
        </footer>
      </section>}
    </div>
    <div className="composer-subagent-thinking-control">
      <button
        ref={thinkingButton}
        type="button"
        className={`composer-effort-pill composer-subagent-effort-pill ${picker === "thinking" ? "active" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={picker === "thinking"}
        aria-label={`工兵推理强度 ${effortLabels[currentEffort]}`}
        onClick={() => setPicker((current) => current === "thinking" ? null : "thinking")}
      >
        <Zap size={13} aria-hidden="true" /><span>{effortLabels[currentEffort]}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
      {picker === "thinking" && <section
        ref={thinkingPicker}
        className="composer-picker composer-reasoning-picker composer-subagent-thinking-picker"
        role="dialog"
        aria-label="选择工兵推理强度"
        style={thinkingMenuLeft === undefined ? undefined : { left: `${thinkingMenuLeft}px` }}
      >
        <header className="composer-picker-heading"><span><Zap size={15} /><strong>工兵 · {effortLabels[currentEffort]}</strong></span></header>
        <p>选择新工兵任务使用的推理档位。</p>
        <div className="composer-effort-scale" role="group" aria-label="工兵推理强度档位">
          {reasoningEfforts.map((effort) => <button
            type="button"
            key={effort}
            className={`composer-effort-point ${currentEffort === effort ? "selected" : ""}`}
            disabled={disabled || !canUseEffort(effort)}
            aria-pressed={currentEffort === effort}
            title={effortLabels[effort]}
            onClick={() => chooseEffort(effort)}
          ><i aria-hidden="true" /><span>{effortLabels[effort]}</span></button>)}
        </div>
        {availableEfforts && <small className="composer-picker-footnote">档位由当前工兵模型能力决定。</small>}
      </section>}
    </div>
  </div>;
}
