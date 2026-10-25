import test from "node:test";
import assert from "node:assert/strict";
import {
  completeToolBranchEnd,
  deleteMessageWithToolPairs,
  deleteToolCallWithResult,
  findToolCallOwner,
  pairedToolResultIds,
  patchMessageWithToolPairs,
  patchToolCallWithResult,
  toolHistoryError,
  wireToolCallId,
} from "../shared/tool-history";
import type { Message } from "../shared/schema";

const user = (id: string): Message => ({ id, role: "user", content: id, enabled: true });
const call = (id: string, name = "lookup"): Message => ({
  id: `assistant-${id}`, role: "assistant", content: "", enabled: true,
  toolCalls: [{ id, name, arguments: "{}" }],
});
const result = (id: string, callId: string, name = "lookup"): Message => ({
  id, role: "tool", toolCallId: callId, toolName: name, content: "ok", enabled: true,
});

test("tool history accepts consecutive user messages and correctly paired calls", () => {
  assert.equal(toolHistoryError([user("u1"), user("u2"), call("c1"), result("r1", "c1")]), null);
});

test("tool history explains orphan and incomplete tool messages", () => {
  assert.match(toolHistoryError([result("orphan", "missing")]) || "", /没有对应的调用/);
  assert.match(toolHistoryError([call("pending")]) || "", /添加工具结果/);
  assert.match(toolHistoryError([call("pending"), user("interrupt")]) || "", /必须先补齐/);
});

test("tool call IDs with provider suffixes pair by wire ID", () => {
  const assistant = call("call-1|provider-signature");
  const tool = result("result-1", "call-1|result-signature");
  const messages = [assistant, tool];
  assert.equal(wireToolCallId(assistant.toolCalls![0].id), "call-1");
  assert.equal(toolHistoryError(messages), null);
  assert.deepEqual([...pairedToolResultIds(messages, assistant)], ["result-1"]);
  assert.equal(findToolCallOwner(messages, tool)?.id, assistant.id);
  assert.equal(completeToolBranchEnd(messages, 0), 1);
  assert.equal(completeToolBranchEnd(messages, 1), 1);
  assert.equal(completeToolBranchEnd([assistant], 0), null);
  assert.equal(completeToolBranchEnd([assistant, result("wrong-name", "call-1", "other")], 0), null);
});

test("deleting or excluding an assistant tool call applies atomically to its results", () => {
  const assistant = call("call-2");
  const tool = result("result-2", "call-2");
  const messages = [user("before"), assistant, tool, user("after")];
  assert.deepEqual(deleteMessageWithToolPairs(messages, assistant.id).map((m) => m.id), ["before", "after"]);
  const excluded = patchMessageWithToolPairs(messages, assistant.id, { enabled: false });
  assert.equal(excluded[1].enabled, false);
  assert.equal(excluded[2].enabled, false);
  const excludedResult = patchMessageWithToolPairs(messages, tool.id, { enabled: false });
  assert.equal(excludedResult[1].enabled, false);
  assert.equal(excludedResult[2].enabled, false);
});

test("editing call ID or name keeps the paired result synchronized", () => {
  const assistant = call("call-3");
  const tool = result("result-3", "call-3");
  const withNewId = patchToolCallWithResult([assistant, tool], assistant.id, 0, { id: "call-4" });
  assert.equal(withNewId[0].toolCalls?.[0].id, "call-4");
  assert.equal(withNewId[1].toolCallId, "call-4");
  const withNewName = patchToolCallWithResult([assistant, tool], assistant.id, 0, { name: "search" });
  assert.equal(withNewName[0].toolCalls?.[0].name, "search");
  assert.equal(withNewName[1].toolName, "search");
  assert.equal(toolHistoryError(withNewId), null);
  assert.equal(toolHistoryError(withNewName), null);
});

test("deleting an individual tool result removes its call instead of orphaning history", () => {
  const assistant = call("call-5");
  const tool = result("result-5", "call-5");
  const remaining = deleteMessageWithToolPairs([user("before"), assistant, tool], tool.id);
  assert.deepEqual(remaining.map((m) => m.id), ["before"]);
});

test("deleting one step from a multi-call assistant preserves the other complete pair", () => {
  const assistant: Message = { ...call("call-6"), toolCalls: [
    { id: "call-6", name: "lookup", arguments: "{}" },
    { id: "call-7", name: "lookup", arguments: "{}" },
  ] };
  const messages = [assistant, result("r6", "call-6"), result("r7", "call-7")];
  const remaining = deleteToolCallWithResult(messages, assistant.id, "call-6");
  assert.deepEqual(remaining.map((m) => m.id), [assistant.id, "r7"]);
  assert.deepEqual(remaining[0].toolCalls?.map((c) => c.id), ["call-7"]);
  assert.equal(toolHistoryError(remaining), null);
});
