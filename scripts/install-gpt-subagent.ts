import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const agentDir =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const target = join(agentDir, "extensions", "pi-gpt-subagent");
const owner = join(target, "pi-lab-owner.json");

try {
  const existing = await readdir(target);
  if (
    existing.length &&
    JSON.parse(await readFile(owner, "utf8")).owner !== "pi-message-lab"
  )
    throw new Error("目标扩展目录不属于 Pi Lab");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const existing = await readdir(target).catch(() => []);
  if (existing.length) throw new Error(`请先检查已有扩展目录：${target}`);
}

await mkdir(target, { recursive: true, mode: 0o700 });
for (const name of ["rpc.ts", "sessions.ts", "native.ts", "tools.ts", "images.ts", "index.ts"])
  await copyFile(resolve("extensions/pi-gpt-subagent", name), join(target, name));
await writeFile(
  owner,
  JSON.stringify({ owner: "pi-message-lab", source: process.cwd() }),
  { mode: 0o600 },
);
console.log(
  `已安装 Pi GPT 并行会话扩展：${target}\n新的 Pi 会话自动加载；已打开的 Pi 需执行 /reload。`,
);
