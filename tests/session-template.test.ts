import test from "node:test";
import assert from "node:assert/strict";
import { NEW_SESSION_SYSTEM_PROMPT, newSession, toolTitle } from "../src/utils/session";

test("new sessions use a neutral engineering prompt and dedicated workspace without history", () => {
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
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /高级产品设计与软件工程伙伴/);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /subagent_dispatch/);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /subagent_query/);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /subagent_control/);
  assert.match(NEW_SESSION_SYSTEM_PROMPT, /不套固定模板/);
  assert.doesNotMatch(NEW_SESSION_SYSTEM_PROMPT, /Gemini|GPT|讨厌|最好的伙伴|费曼|四节|核心直觉与本质/);
  assert.doesNotMatch(NEW_SESSION_SYSTEM_PROMPT, /timeoutSeconds/);
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
