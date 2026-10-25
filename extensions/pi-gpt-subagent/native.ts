import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { PiRpcProcess } from "./rpc.ts";
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
    const roleInstructions = {
      scout: "你是探路学者：先用直白语言讲清问题本质，定位关键代码路径与可验证证据；除非任务要求，不做无关修改。",
      experimenter: "你是路径实验员：提出并执行低风险实验，比较候选路径，用结果解释因果，说明成果、失败边界与反例。",
      implementer: "你是工程执行员：按用户约束实施必要改动，检查相关调用方并运行聚焦验证，精确说明关键改动与结果。",
    } as const;
    const roleInstruction = session.rolePreset ? roleInstructions[session.rolePreset] : "按委派任务自主探索并明确风险；涉及调研或排查时先解释根因与核心原理。";
    const reportProtocol = `【费曼式探索与结构化汇报协议】\n回复主 Agent 时要让其掌控全局、真正理解问题。禁止堆砌“我读了 A、跑了 B”式无意义流水账，也禁止无证据的成功宣称。最终交卷必须按四节组织：\n1. 【核心直觉与本质】：涉及调研或排查时，先用直白清晰的语言讲明问题本质原理/根因；否则讲清任务核心。\n2. 【尝试路径与成果】：具体说明尝试了什么、验证成了什么或修改了哪些关键点，并提供证据。\n3. 【碰壁与反例】（若有）：指出没走通的路径及其卡住的核心矛盾；没有则明确写“无”。\n4. 【下一步建议】：给主 Agent 明确、可执行的决策建议。命令、文件名和日志仅在支撑结论时列出。`;
    args.push(
      "--mode", "rpc", "--provider", "openai-codex", "--model", session.model,
      "--thinking", "max",
      "--name", session.name,
      // Pi restores a resumed session's recorded loadout. Explicitly add the
      // publisher too, including when the session predates the image tools.
      "--tools", "+read,+bash,+edit,+write,+grep,+find,+ls,+present_images",
      "--append-system-prompt",
      "This is a persistent GPT conversation coordinated by another Pi conversation. " +
      "Work autonomously using your native tools and follow applicable project guidance. " +
      "You may receive additional steering or follow-up messages while working. " +
      "Other conversations may share this working directory; coordinate changes through your replies. " +
      "For visual review, find or render images locally and use present_images to publish named collections. " +
      "When publishing images, report only the collection name and count; the coordinator will choose when to view them. " +
      roleInstruction + " " + reportProtocol + " Ask when you need missing information.",
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
