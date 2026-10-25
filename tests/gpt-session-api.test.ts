import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRecentTools } from "../server/gpt-subagent";
import type { ProgressEvent } from "../extensions/pi-gpt-subagent/sessions";
import { gptSessionSummarySchema } from "../shared/gpt-sessions";

test("GPT dashboard tool summaries expose metadata, never raw arguments or output", () => {
  const events: ProgressEvent[] = [
    { sequence: 1, at: 100, type: "tool_start", text: '{"command":"private command"}', toolName: "bash", toolCallId: "call-1" },
    { sequence: 2, at: 150, type: "tool_progress", text: "private output", toolName: "bash", toolCallId: "call-1" },
    { sequence: 3, at: 200, type: "tool_end", text: "private result", toolName: "bash", toolCallId: "call-1", isError: false },
    { sequence: 4, at: 300, type: "tool_start", text: '{"path":"secret"}', toolName: "read", toolCallId: "call-2" },
  ];
  const summaries = summarizeRecentTools(events);
  assert.deepEqual(summaries, [
    { name: "read", status: "running", at: 300 },
    { name: "bash", status: "completed", at: 200 },
  ]);
  assert.equal(JSON.stringify(summaries).includes("private"), false);
  assert.equal(JSON.stringify(summaries).includes("secret"), false);
});

test("GPT live summaries exclude the worker working-directory path", () => {
  const summary = gptSessionSummarySchema.parse({
    id: "session-1", name: "worker", role: "审计工兵", status: "idle", model: "model", cwd: "/private/project",
    updatedAt: 1, hasUnreadReply: false, pendingQuestionCount: 0, recentTools: [], lastReplyPreview: "done",
  });
  assert.equal(summary.role, "审计工兵");
  assert.equal("cwd" in summary, false);
});
