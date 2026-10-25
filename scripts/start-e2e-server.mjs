import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "pilab-e2e-"));
const dataDir = path.join(temp, "project-data");
const agentDir = path.join(temp, "pi-agent");
const cwd = path.join(temp, "workdir");
await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
const port = process.env.PI_LAB_E2E_PORT || process.env.PORT || "3100";
const env = { ...process.env, NODE_ENV: "development", PI_LAB_E2E: "1", PI_LAB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir, PI_LAB_E2E_CWD: cwd, PORT: String(port), PI_LAB_E2E_PORT: String(port) };
for (const key of ["PI_LAB_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "PI_LAB_PI_BIN", "PI_LAB_IMAGE_ROOT"])
  delete env[key];
const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env, stdio: "inherit" });
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", async (code, signal) => {
  await rm(temp, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
