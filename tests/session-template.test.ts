import test from "node:test";
import assert from "node:assert/strict";
import { NEW_SESSION_SYSTEM_PROMPT, newSession, toolTitle } from "../src/utils/session";

test("new sessions use the dual-model template and a supplied dedicated workspace without history", () => {
  const session = newSession("/tmp/project");
  assert.equal(session.settings.protocol, "pi-subscription");
  assert.equal(session.settings.model, "antigravity/gemini-3.8-flash");
  assert.equal("toolMode" in session.settings, false);
  assert.equal(session.settings.reasoning, true);
  assert.equal(session.settings.reasoningEffort, "high");
  assert.equal(session.settings.maxTurns, 20);
  assert.equal(session.settings.maxTokens, 16384);
  assert.equal(session.settings.workingDirectory, "/tmp/project");
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].role, "system");
  assert.equal(session.messages[0].content, NEW_SESSION_SYSTEM_PROMPT);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /省略 timeoutSeconds 即无限等待/);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /同步派发期间无需也绝不能反复调用 wait 或 query 轮询/);
  assert.doesNotMatch(NEW_SESSION_SYSTEM_PROMPT, /设置合理 timeoutSeconds/);
  assert.equal(session.runs.length, 0);
});

test("tool titles rely on semantic icons instead of duplicate leading emoji", () => {
  assert.equal(toolTitle("gpt_session_create", '{"name":"ppt_prep"}'), "创建并派发 GPT「ppt_prep」");
  assert.equal(toolTitle("gpt_session_wait", '{"names":["ppt_prep"]}'), "等待 GPT 完成 · ppt_prep");
  assert.equal(toolTitle("gpt_session_read", '{"name":"ppt_prep"}'), "读取 GPT「ppt_prep」 状态");
  assert.equal(toolTitle("subagent_dispatch", '{"task":{"name":"ppt_prep","message":"prepare"}}'), "派发工兵「ppt_prep」任务");
  assert.equal(toolTitle("subagent_query", '{"action":"status","name":"ppt_prep"}'), "读取工兵「ppt_prep」状态");
  assert.equal(toolTitle("bash", "{}"), "调用工具 bash");
});
