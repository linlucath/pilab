import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { modelRequestError } from "../server/network";

test("Antigravity inactivity default allows ten minutes and preserves explicit/legacy overrides", () => {
  const moduleUrl = new URL("../server/network.ts", import.meta.url).href;
  for (const [current, legacy, expected] of [
    [undefined, undefined, "600000"],
    ["240000", "300000", "240000"],
    [undefined, "300000", "300000"],
    ["0", undefined, "0"],
  ]) {
    const env = { ...process.env };
    delete env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS;
    delete env.NOAGY_STREAM_STALL_TIMEOUT_MS;
    if (current !== undefined) env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = current;
    if (legacy !== undefined) env.NOAGY_STREAM_STALL_TIMEOUT_MS = legacy;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write(process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS);`,
    ], { env, encoding: "utf8" });
    assert.equal(output, expected);
  }
});

test("stream inactivity errors explain the wait without claiming a specific upstream cause", () => {
  const raw = "stream stalled: no data for 120000ms";
  const message = modelRequestError(raw, { provider: "antigravity", baseUrl: "https://example.test" });
  assert.match(message, /连续 120 秒未收到数据/);
  assert.match(message, /可能是/);
  assert.ok(message.endsWith(raw));
  assert.equal(modelRequestError("Invalid API key", { provider: "antigravity", baseUrl: "https://example.test" }), "Invalid API key");
});
