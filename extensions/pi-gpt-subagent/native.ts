import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { PiRpcProcess } from "./rpc.ts";
import { gptWorkerSystemPrompt } from "./persona.ts";
import type { TransportFactory } from "./sessions.ts";

export function sessionStorageDir(owner: string) {
  const key = createHash("sha256").update(owner).digest("hex").slice(0, 24);
  return path.join(getAgentDir(), "gpt-sessions", key);
}

export function nativeTransportFactory(imageRoot = process.env.PI_LAB_IMAGE_ROOT || process.cwd()): TransportFactory {
  return (session, onEvent, onExit) => {
    const packageDir = getPackageDir();
    const cli = ["dist/bundle/cli.js", "dist/cli.js"]
      .map((relative) => path.join(packageDir, relative))
      .find((candidate) => existsSync(candidate));
    const command = process.env.PI_LAB_PI_BIN || (cli ? process.execPath : "pi");
    const args = process.env.PI_LAB_PI_BIN || !cli ? [] : [cli];
    args.push(
      "--mode", "rpc", "--provider", "openai-codex", "--model", session.model,
      "--thinking", "max",
      "--name", session.name,
      // Pi restores a resumed session's recorded loadout. Explicitly add the
      // publisher too, including when the session predates the image tools.
      "--tools", "+read,+bash,+edit,+write,+grep,+find,+ls,+present_images",
      "--append-system-prompt", gptWorkerSystemPrompt(session.rolePreset),
    );
    if (session.sessionFile) fs.mkdirSync(path.dirname(session.sessionFile), { recursive: true });
    if (session.sessionFile && existsSync(session.sessionFile))
      args.push("--session", session.sessionFile);
    else args.push("--session-id", session.id);

    // Each process uses Pi's existing credential store and the normal local shell environment.
    const env = { ...process.env, PI_CODING_AGENT_DIR: getAgentDir(), PI_LAB_GPT_WORKER: "1", PI_LAB_IMAGE_ROOT: imageRoot };
    return new PiRpcProcess({ command, args, cwd: session.cwd, env, onEvent, onExit });
  };
}
