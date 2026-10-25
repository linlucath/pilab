#!/usr/bin/env python3
"""Headless UI smoke test; all workspace writes and model streams are sandboxed in-page."""
from __future__ import annotations
import copy
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("PILAB_URL", "http://127.0.0.1:3000").rstrip("/")


def read_workspace():
    with urllib.request.urlopen(f"{BASE_URL}/api/workspace", timeout=5) as response:
        return json.load(response)["workspace"]


def make_session(session_id: str, title: str, settings: dict, count: int):
    messages = [{"id": f"{session_id}-system", "role": "system", "content": "Smoke-test system prompt", "enabled": True}]
    for index in range(count):
        messages.extend([
            {"id": f"{session_id}-user-{index}", "role": "user", "content": f"Question {index}", "enabled": True},
            {"id": f"{session_id}-assistant-{index}", "role": "assistant", "content": f"Answer {index}", "enabled": True},
        ])
    return {"id": session_id, "title": title, "settings": copy.deepcopy(settings), "messages": messages}


def sandbox_script(workspace: dict) -> str:
    fixture = json.dumps(workspace, ensure_ascii=False)
    return r"""(() => {
      let workspace = __FIXTURE__;
      let failNext = false;
      const stats = { runs: [], patches: 0 };
      const nativeFetch = window.fetch.bind(window);
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname === '/api/workspace') return json({ workspace });
        if (url.pathname === '/api/workspace/changes') {
          stats.patches++;
          const delta = JSON.parse(init.body || '{}');
          for (const patch of delta.sessions || []) {
            const index = workspace.sessions.findIndex((session) => session.id === patch.id);
            if (index < 0) workspace.sessions.push(patch);
            else workspace.sessions[index] = { ...workspace.sessions[index], ...patch };
          }
          if (delta.removed) workspace.sessions = workspace.sessions.filter((session) => !delta.removed.includes(session.id));
          if (delta.hidden) workspace.hiddenPiSessions = [...new Set([...workspace.hiddenPiSessions, ...delta.hidden])];
          if (delta.restored) workspace.hiddenPiSessions = workspace.hiddenPiSessions.filter((id) => !delta.restored.includes(id));
          if (delta.active !== undefined) workspace.active = delta.active;
          if (delta.followPi !== undefined) workspace.followPi = delta.followPi;
          workspace.revision++;
          return json({ workspace });
        }
        if (url.pathname === '/api/pi-status') return json({ connected: false, provider: '', models: [] });
        if (url.pathname === '/api/pi-sync') return json({ sessions: [] });
        if (url.pathname === '/api/run') {
          const body = JSON.parse(init.body || '{}');
          stats.runs.push(body);
          if (failNext) { failNext = false; return json({ error: 'Mock validation failure: broken tool history' }, 400); }
          const encoder = new TextEncoder();
          const events = [
            { type: 'assistant_start', id: 'smoke-tool-assistant', turn: 1 },
            { type: 'thinking', id: 'smoke-tool-assistant', delta: '正在准备工具步骤' },
            { type: 'assistant', message: { id: 'smoke-tool-assistant', role: 'assistant', content: '', enabled: true, toolCalls: [{ id: 'smoke-call', name: 'gpt_session_send', arguments: JSON.stringify({ session_id: 'gpt-demo', message: 'smoke instruction' }) }] } },
            { type: 'tool_activity', id: 'smoke-call', name: 'gpt_session_send', arguments: { message: 'smoke instruction' }, output: '' },
          ];
          const stream = new ReadableStream({ start(controller) {
            (async () => {
              for (const event of events) { controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); await delay(90); }
              await delay(650);
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'message', message: { id: 'smoke-tool-result', role: 'tool', toolCallId: 'smoke-call', toolName: 'gpt_session_send', content: '{"status":"running"}', enabled: true } }) + '\n'));
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'tool_activity_end', id: 'smoke-call' }) + '\n'));
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'assistant_start', id: 'smoke-final-assistant', turn: 1 }) + '\n'));
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', id: 'smoke-final-assistant', delta: 'Final smoke reply' }) + '\n'));
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'assistant', message: { id: 'smoke-final-assistant', role: 'assistant', content: 'Final smoke reply', enabled: true } }) + '\n'));
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'done', reason: 'stop', usage: { input: 1, output: 3 }, turns: 1 }) + '\n'));
              controller.close();
            })().catch((error) => controller.error(error));
          } });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
        }
        return nativeFetch(input, init);
      };
      try { Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => true }); } catch {}
      window.__pilabSmoke = { stats, failNextRun: () => { failNext = true; } };
    })();""".replace("__FIXTURE__", fixture)


def main():
    original = read_workspace()
    settings = copy.deepcopy(original["sessions"][0]["settings"])
    alpha = make_session("smoke-alpha", "Smoke Alpha", settings, 40)
    beta = make_session("smoke-beta", "Smoke Beta", settings, 27)
    fake = {
        "version": 1, "revision": 1, "deletedSessionIds": [],
        "sessions": [alpha, beta], "active": alpha["id"],
        "hiddenPiSessions": [], "followPi": False,
    }
    failures: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        context.add_init_script(sandbox_script(fake))
        page = context.new_page()
        page.on("pageerror", lambda error: failures.append(str(error)))
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector('.message-stream[data-session-id="smoke-alpha"]', timeout=20_000)

        def assert_at_bottom(label: str):
            page.wait_for_function("""() => {
              const e = document.querySelector('.message-stream');
              return e && e.scrollHeight - e.scrollTop - e.clientHeight < 8;
            }""", timeout=10_000)
            print(f"PASS scroll-bottom: {label}")

        assert_at_bottom("initial session load")
        page.locator(".session-row").filter(has_text="Smoke Beta").locator(".session-main").click()
        page.wait_for_selector('.message-stream[data-session-id="smoke-beta"]')
        assert_at_bottom("switch session to beta")
        page.locator(".session-row").filter(has_text="Smoke Alpha").locator(".session-main").click()
        page.wait_for_selector('.message-stream[data-session-id="smoke-alpha"]')
        assert_at_bottom("switch session back to alpha")

        composer = page.locator('textarea[aria-label="撰写新消息"]')
        composer.fill("queued without running")
        page.get_by_role("button", name="仅添加").click()
        page.get_by_text("queued without running", exact=True).wait_for()
        assert_at_bottom("composer add-only")
        assert page.evaluate("window.__pilabSmoke.stats.runs.length") == 0, "仅添加意外触发了运行"

        edited = page.locator('.message-row[data-message-id="smoke-alpha-assistant-39"]')
        edited.locator('button[title="编辑消息"]').click()
        editor = edited.locator('textarea[aria-label="编辑 Gemini 消息"]')
        page.wait_for_function("""() => document.activeElement?.getAttribute('aria-label') === '编辑 Gemini 消息'""")
        editor.fill("discarded draft")
        edited.get_by_role("button", name="取消").click()
        assert edited.locator(".markdown-body").inner_text() == "Answer 39", "取消编辑仍改写了全局消息"
        edited.locator('button[title="编辑消息"]').click()
        editor = edited.locator('textarea[aria-label="编辑 Gemini 消息"]')
        editor.fill("saved edit")
        editor.press("Control+Enter")
        page.get_by_text("saved edit", exact=True).wait_for()
        assert edited.locator(".markdown-body").inner_text() == "saved edit"
        assert page.evaluate("window.__pilabSmoke.stats.runs.length") == 0, "编辑器的 Ctrl+Enter 泄漏到了全局运行快捷键"
        print("PASS editor: autofocus, cancel rollback, Ctrl+Enter save without running")

        composer = page.locator('textarea[aria-label="撰写新消息"]')
        composer.fill("send exactly once with Ctrl+Enter")
        composer.press("Control+Enter")
        page.wait_for_function("window.__pilabSmoke.stats.runs.length === 1", timeout=5_000)
        page.locator(".tool-group.is-live .tool-live-label").wait_for(timeout=5_000)
        live_group = page.locator(".tool-group.is-live")
        assert live_group.locator("details").first.evaluate("element => element.open"), "活动工具组在 compact 模式下被折叠"
        assert live_group.locator('.tool-step-row[data-tool-name="gpt_session_send"]').count() == 1
        assert page.locator('.message-actions button[title="删除"]').first.is_disabled(), "运行中删除消息按钮没有禁用"
        assert page.locator('.message-actions button[title="从此处分支"]').first.is_disabled(), "运行中分支按钮没有禁用"
        body = page.evaluate("window.__pilabSmoke.stats.runs[0]")
        assert sum(message.get("content") == "send exactly once with Ctrl+Enter" for message in body["messages"]) == 1
        page.locator(".composer-running").wait_for(state="detached", timeout=10_000)
        page.get_by_text("Final smoke reply", exact=True).wait_for()
        assert_at_bottom("streamed reply")
        print("PASS send/stream: one POST, latest user included once, live tool group stays open")

        composer = page.locator('textarea[aria-label="撰写新消息"]')
        composer.fill("IME candidate must remain a draft")
        composer.evaluate("""element => {
          element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
          element.dispatchEvent(new CompositionEvent('compositionend', { data: '测试', bubbles: true }));
        }""")
        page.wait_for_timeout(150)
        assert page.evaluate("window.__pilabSmoke.stats.runs.length") == 1, "IME 候选回车触发了运行"
        assert composer.input_value() == "IME candidate must remain a draft", "IME 候选回车清空了草稿"
        composer.press("Enter")
        page.wait_for_function("window.__pilabSmoke.stats.runs.length === 2", timeout=5_000)
        page.locator(".composer-running").wait_for(state="detached", timeout=10_000)
        print("PASS IME: keyCode 229 does not send; normal Enter sends once")

        page.evaluate("window.__pilabSmoke.failNextRun()")
        page.locator('textarea[aria-label="撰写新消息"]').fill("show the run error in the conversation")
        page.locator('textarea[aria-label="撰写新消息"]').press("Enter")
        banner = page.get_by_role("alert")
        banner.wait_for(timeout=8_000)
        assert "Mock validation failure" in banner.inner_text()
        banner.get_by_role("button", name="关闭运行错误").click()
        banner.wait_for(state="detached")
        print("PASS errors: API validation failure appears above the composer and is dismissible")

        if failures:
            raise AssertionError("browser console errors: " + "; ".join(failures))
        print(f"sandbox workspace PATCH calls intercepted: {page.evaluate('window.__pilabSmoke.stats.patches')}")
        print("All core UI flow checks passed at 1440×900; all writes/LLM streams were mocked in the browser.")
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
