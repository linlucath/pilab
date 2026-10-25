import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defaults, fileSchema, messageSchema, runSchema, type Message } from "../shared/schema";
import { fromPiMessage, toPiMessage } from "../server/transcript";
import { ProjectWorkspaceStore } from "../server/workspace";

test("long Argon text signatures survive request, export, persistence and Pi replay intact", async () => {
  const signature = "AbCd0123+/".repeat(12_000) + "==";
  const model = { api: "antigravity", provider: "antigravity", id: "gemini-4-argon" } as Model<Api>;
  const message: Message = {
    id: "signed-argon-reply", role: "assistant", enabled: true, content: "Historical reply",
    providerState: { api: model.api, provider: model.provider, model: model.id,
      thinking: [], textSignature: signature, stopReason: "stop" },
  };
  // Reproduce the original zero-based messages.150 validation path.
  const messages: Message[] = Array.from({ length: 150 }, (_, index) => ({
    id: `history-${index}`, role: "user", enabled: true, content: "Earlier message",
  }));
  messages.push(message);
  const request = runSchema.parse({ settings: defaults, messages });
  assert.equal(request.messages[150].providerState?.textSignature, signature);
  const exported = fileSchema.parse({ version: 1, title: "Argon history", settings: defaults, messages });
  const replay = toPiMessage(exported.messages[150], model);
  assert.equal(fromPiMessage(replay, message.id).providerState?.textSignature, signature);
  const directory = await mkdtemp(join(tmpdir(), "pilab-signature-"));
  try {
    const file = join(directory, "workspace.json");
    const store = new ProjectWorkspaceStore(file);
    await store.initialize({ sessions: [{ ...exported, id: "argon" }], active: "argon" });
    const restored = await new ProjectWorkspaceStore(file).get();
    assert.equal(restored?.sessions[0].messages[150].providerState?.textSignature, signature);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.equal(messageSchema.safeParse({ ...message, providerState: {
    ...message.providerState, textSignature: "s".repeat(1_000_001),
  } }).success, false);
});
