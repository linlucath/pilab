import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverride,
  makeOverride,
  atomicJson,
} from "../extensions/pi-lab-sync/state";
import extension from "../extensions/pi-lab-sync/index";
import { mergeSyncMessages } from "../server/pi-sync";
import { fromPiMessage } from "../server/transcript";
import { messageSchema, type Message } from "../shared/schema";

const model = { id: "test", api: "openai-completions", provider: "openai" };
const raw = [
  {
    role: "system",
    content: "",
    sections: { rules: "Be concise." },
    toolsAdded: [{ name: "read", parameters: {} }],
    timestamp: 1,
  },
  {
    role: "user",
    content: [
      { type: "text", text: "OLD" },
      { type: "image", data: "opaque", mimeType: "image/png" },
    ],
    timestamp: 2,
  },
];

test("override preserves order, new turns, tool declarations and repeated edits", () => {
  const edited = [raw[0], { ...raw[1], content: "EDITED" }];
  const override = makeOverride(raw, edited);
  const next = { role: "user", content: "What was the marker?", timestamp: 3 };
  const delta = {
    role: "system",
    content: "",
    sections: { rules: "New rules" },
    timestamp: 4,
  };
  assert.deepEqual(applyOverride([...raw, next, delta], override), [
    ...edited,
    next,
    delta,
  ]);
  const second = makeOverride(
    [...raw, next],
    [...edited, { ...next, content: "Second edit" }],
  );
  assert.equal(
    applyOverride([...raw, next, delta], second)[2].content,
    "Second edit",
  );
  assert.throws(
    () => applyOverride([raw[0], { ...raw[1], content: "Branch" }], override),
    /切换分支或压缩/,
  );
  assert.throws(() => applyOverride([raw[0]], override), /切换分支或压缩/);
});

test("native message merge preserves opaque data, edits text and rejects invalid histories", async () => {
  const { digest } = await import("../extensions/pi-lab-sync/state");
  const ids = raw.map((m, i) => `pi-${i}-${digest(m).slice(0, 20)}`);
  const messages: Message[] = [
    messageSchema.parse({
      id: ids[0],
      role: "system",
      content: "Be concise.",
      enabled: true,
    }),
    messageSchema.parse({
      id: ids[1],
      role: "user",
      content: "OLD",
      enabled: true,
    }),
  ];
  assert.deepEqual(
    mergeSyncMessages(raw, messages, model),
    raw,
    "unchanged views survive schema key reordering",
  );
  const edited = structuredClone(messages);
  edited[1].content = "NEW";
  const native = mergeSyncMessages(raw, edited, model);
  assert.deepEqual(native[0], raw[0]);
  assert.deepEqual(native[1].content, [
    { type: "text", text: "NEW" },
    raw[1].content[1],
  ]);
  assert.equal(native[1].timestamp, 2);
  const systemEdit = structuredClone(messages);
  systemEdit[0].content = "New instructions.";
  const replaced = mergeSyncMessages(raw, systemEdit, model);
  assert.equal(replaced[0].sections, undefined);
  assert.equal(replaced[0].content, "New instructions.");
  assert.deepEqual(replaced[0].toolsAdded, raw[0].toolsAdded);
  assert.throws(
    () => mergeSyncMessages(raw, messages.slice(1), model),
    /保留开头/,
  );
  assert.throws(
    () =>
      mergeSyncMessages(
        raw,
        [
          ...messages,
          { id: "dev", role: "developer", enabled: true, content: "test" },
        ],
        model,
      ),
    /developer/,
  );
  assert.throws(
    () =>
      mergeSyncMessages(
        raw,
        [
          ...messages,
          {
            id: "tool",
            role: "tool",
            enabled: true,
            content: "result",
            toolCallId: "orphan",
            toolName: "read",
          },
        ],
        model,
      ),
    /没有对应/,
  );
});

test("extension applies idle commands once, rejects races/busy edits, restores on resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sync-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, Function>();
  let entries: any[] = [];
  let messages: any[] = structuredClone(raw);
  let idle = true;
  let leaf = "leaf";
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    getThinkingLevel() {
      return "low";
    },
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
      leaf += "e";
    },
  };
  const ctx = {
    cwd: dir,
    model,
    isIdle: () => idle,
    getSystemPrompt: () => "Be concise.",
    ui: { setStatus() {}, notify() {} },
    sessionManager: {
      getSessionId: () => "session-test",
      getSessionFile: () => undefined,
      getSessionName: () => "Fixture",
      buildSessionProjection: () => ({ messages }),
      getLeafId: () => leaf,
      getBranch: () => entries,
    },
  };
  const fire = async (name: string, event: any = {}) =>
    handlers.get(name)?.(event, ctx);
  const file = join(dir, "pi-lab-sync", `session-test-${process.pid}.json`);
  const command = file.replace(/\.json$/, ".command.json");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  async function tick() {
    await fire("session_tree");
  }
  try {
    extension(pi as any);
    await fire("session_start");
    const revision = read().revision;
    atomicJson(command, {
      id: "apply",
      revision,
      messages: [raw[0], { ...raw[1], content: "EDITED" }],
    });
    // Use the registered command as a deterministic tick, without relying on timer timing.
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(read().ack.status, "applied");
    assert.equal(entries.length, 1);
    const next = { role: "user", content: "Marker?", timestamp: 5 };
    messages.push(next);
    leaf += "n";
    const result = await fire("context_with_system", { messages });
    assert.equal(result.messages[1].content, "EDITED");
    assert.deepEqual(result.messages[2], next);
    assert.equal(read().lastAppliedRequest, 1);
    idle = false;
    atomicJson(command, { id: "busy", revision: read().revision, messages });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.match(read().ack.error, /正在执行/);
    assert.equal(entries.length, 1);
    idle = true;
    atomicJson(command, { id: "stale", revision: "0".repeat(64), messages });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.match(read().ack.error, /已有新变化/);
    await fire("session_start");
    assert.equal(
      read().applied,
      true,
      "resuming restores the overlay from the active branch",
    );
    assert.equal(read().messages[1].content, "EDITED");
    entries = [];
    leaf += "branch";
    await tick();
    assert.equal(
      read().applied,
      false,
      "switching away from the edited branch clears it",
    );
    assert.equal(read().messages[1].content[0].text, "OLD");
    assert.ok(
      readdirSync(join(dir, "pi-lab-sync")).every((n) => !n.endsWith(".tmp")),
    );
  } finally {
    await fire("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
