import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  }).catch((error) => {
    runtime = undefined;
    throw error;
  }));
}
export async function piStatus() {
  const models = await piRuntime();
  const credentials = await models.listCredentials();
  const connected = credentials.some(
    (c) => c.providerId === "openai-codex" && c.type === "oauth",
  );
  let selectedModel: string | undefined;
  try {
    const settings = JSON.parse(
      await readFile(path.join(agentDir, "settings.json"), "utf8"),
    );
    if (settings.defaultProvider === "openai-codex")
      selectedModel = settings.defaultModel;
  } catch {
    /* Missing preferences do not invalidate a logged-in subscription. */
  }
  const catalog = models.getModels("openai-codex");
  return {
    connected,
    provider: "openai-codex",
    defaultModel:
      selectedModel && catalog.some((m) => m.id === selectedModel)
        ? selectedModel
        : catalog[0]?.id,
    models: catalog.map((m) => ({
      id: m.id,
      name: m.name,
      reasoningEfforts: getSupportedThinkingLevels(m),
      reasoningEffortMap: m.thinkingLevelMap,
    })),
  };
}
