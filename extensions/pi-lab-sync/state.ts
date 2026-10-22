import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export type NativeMessage = Record<string, any>;
export type Override = { base: string[]; messages: NativeMessage[] };
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function applyOverride(
  raw: NativeMessage[],
  override?: Override,
): NativeMessage[] {
  if (!override) return raw;
  if (
    raw.length < override.base.length ||
    override.base.some((hash, i) => digest(raw[i]) !== hash)
  )
    throw new Error(
      "Pi 已切换分支或压缩上下文，旧的网页修改已暂停。请重新同步后提交。",
    );
  return [...override.messages, ...raw.slice(override.base.length)];
}
export function makeOverride(
  raw: NativeMessage[],
  edited: NativeMessage[],
): Override {
  return { base: raw.map(digest), messages: edited };
}
export function atomicJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}
export const nativeRevision = (
  messages: NativeMessage[],
  model: unknown,
  thinking: string,
) => digest({ messages, model, thinking });
