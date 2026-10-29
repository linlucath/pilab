import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredTempRoot = process.env.PI_LAB_E2E_DATA_DIR?.trim();
const tempRoot = configuredTempRoot ? path.resolve(configuredTempRoot) : os.tmpdir();
const canonicalTarget = async (target) => {
  let cursor = target;
  const suffix = [];
  while (true) {
    try {
      return path.join(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
};
const isWithin = (target, parent) => {
  const relative = path.relative(parent, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const protectedRoots = [path.join(root, ".pi-lab"), path.join(os.homedir(), ".pi")];
const assertSafeTempRoot = async (target) => {
  const resolvedTarget = await canonicalTarget(target);
  for (const protectedRoot of protectedRoots) {
    if (isWithin(resolvedTarget, await canonicalTarget(protectedRoot)))
      throw new Error(`PI_LAB_E2E_DATA_DIR must not point inside protected user data: ${protectedRoot}`);
  }
};
if (configuredTempRoot) {
  await assertSafeTempRoot(tempRoot);
  await mkdir(tempRoot, { recursive: true });
  await assertSafeTempRoot(await realpath(tempRoot));
}
const temp = await mkdtemp(path.join(tempRoot, "pilab-e2e-"));
const dataDir = path.join(temp, "project-data");
const agentDir = path.join(temp, "pi-agent");
const cwd = path.join(temp, "workdir");
await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
const port = process.env.PI_LAB_E2E_PORT || process.env.PORT || "3100";
const env = { ...process.env, NODE_ENV: "development", PI_LAB_E2E: "1", PI_LAB_DATA_DIR: dataDir, PI_LAB_WORKSPACES_DIR: path.join(dataDir, "session-workspaces"), PI_CODING_AGENT_DIR: agentDir, PI_LAB_E2E_CWD: cwd, PORT: String(port), PI_LAB_E2E_PORT: String(port) };
for (const key of ["PI_LAB_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "PI_LAB_PI_BIN", "PI_LAB_IMAGE_ROOT"])
  delete env[key];
const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env, stdio: "inherit" });
const cleanup = () => {
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* Best-effort fallback if async shutdown is interrupted. */ }
};
process.once("exit", cleanup);
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  // Playwright may terminate the webServer process group before the child exit event;
  // removing the isolated sandbox now is safe because this path is shutdown-only.
  cleanup();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", async (code, signal) => {
  await rm(temp, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
