import { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Pi owns its credential file and the cross-process refresh lock. Never copy tokens into app state.
const agentDir =
  process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
let runtime: Promise<ModelRuntime> | undefined;
export function piRuntime() {
  return (runtime ||= ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    // Also enables Pi's persisted dynamic model catalog and provider routing.
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: true,
  }).then(async (models) => {
    // Provider plugins (including Antigravity) own their catalogs and OAuth handlers.
    const resources = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resources.reload();
    const loaded = resources.getExtensions();
    for (const { path, error } of loaded.errors)
      console.warn(`Pi extension ${path}: ${error}`);
    for (const { name, config } of loaded.runtime.pendingProviderRegistrations)
      models.registerProvider(name, config);
    for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations)
      models.registerNativeProvider(provider);
    await models.refresh({ allowNetwork: false });
    return models;
  }).catch((error) => {
    runtime = undefined;
    throw error;
  }));
}
// Keep existing GPT selections compatible; qualify other providers to avoid ID collisions.
export function piModelId(model: { provider: string; id: string }) {
  return model.provider === "openai-codex" ? model.id : `${model.provider}/${model.id}`;
}
export function resolvePiModel(models: ModelRuntime, id: string) {
  const slash = id.indexOf("/");
  return slash < 0
    ? models.getModel("openai-codex", id)
    : models.getModel(id.slice(0, slash), id.slice(slash + 1));
}
export async function piStatus() {
  if (process.env.PI_LAB_E2E === "1")
    return { connected: false, models: [] };
  const models = await piRuntime();
  let selectedModel: string | undefined;
  try {
    const settings = JSON.parse(
      await readFile(path.join(agentDir, "settings.json"), "utf8"),
    );
    if (settings.defaultProvider && settings.defaultModel)
      selectedModel = piModelId({ provider: settings.defaultProvider, id: settings.defaultModel });
  } catch {
    /* Missing preferences do not invalidate a logged-in subscription. */
  }
  const catalog = models.getModels().filter((m) => models.hasConfiguredAuth(m.provider));
  const preferred = catalog.find((m) => piModelId(m) === selectedModel) || catalog[0];
  return {
    connected: catalog.length > 0,
    provider: preferred?.provider,
    defaultModel: preferred && piModelId(preferred),
    models: catalog.map((m) => ({
      id: piModelId(m),
      name: `${m.name} · ${m.provider}`,
      reasoningEfforts: getSupportedThinkingLevels(m),
      reasoningEffortMap: m.thinkingLevelMap,
    })),
  };
}
