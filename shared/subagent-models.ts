export const DEFAULT_SUBAGENT_MODEL_ID = "gpt-6-luna";

import type { ReasoningEffort } from "./schema";

export type SubagentModelOption = {
  id: string;
  name: string;
  provider: string;
  description?: string;
  reasoningEfforts?: ReasoningEffort[];
};

/** Keep legacy bare model IDs compatible; newer providers use provider/model IDs. */
export function formatSubagentModelId(model: { provider: string; id: string }) {
  return model.provider === "openai-codex" ? model.id : `${model.provider}/${model.id}`;
}

export function parseSubagentModelId(value: string) {
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: "openai-codex", id: value }
    : { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Fallback entries shown only when Pi's configured model catalog is unavailable. */
export const DEFAULT_SUBAGENT_MODELS: SubagentModelOption[] = [
  {
    id: DEFAULT_SUBAGENT_MODEL_ID,
    name: "gpt-6-luna",
    provider: "openai-codex",
    description: "默认工兵模型",
  },
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    provider: "openai-codex",
    description: "编码模型",
  },
];
