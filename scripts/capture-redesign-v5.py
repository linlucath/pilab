#!/usr/bin/env python3
"""Capture the PPT dehydration flow using mock GPT/workspace-write APIs."""
from __future__ import annotations
import copy
import json
import os
import re
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("PILAB_URL", "http://127.0.0.1:3000").rstrip("/")
OUTPUT = ROOT / "artifacts" / "redesign-v5" / "01-ppt-dehydration.png"
VIEWPORT = {"width": 1440, "height": 900}


def workspace_snapshot():
    with urllib.request.urlopen(f"{BASE_URL}/api/workspace", timeout=8) as response:
        return json.load(response)["workspace"]


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    original = workspace_snapshot()
    simulated = copy.deepcopy(original)
    revision = {"value": original.get("revision", 0)}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1, locale="zh-CN")
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => true });")

        # The browser receives a private in-memory workspace. Never persist the archive action.
        def mock_workspace_read(route):
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"workspace": simulated}, ensure_ascii=False))

        def mock_workspace_write(route):
            change = route.request.post_data_json or {}
            by_id = {session["id"]: session for session in simulated["sessions"]}
            for patch in change.get("sessions", []):
                session_id = patch.get("id")
                if session_id in by_id:
                    by_id[session_id].update({key: value for key, value in patch.items() if key != "id"})
                elif session_id:
                    new_session = {key: value for key, value in patch.items() if key != "id"}
                    new_session["id"] = session_id
                    simulated["sessions"].append(new_session)
            if change.get("removed"):
                removed = set(change["removed"])
                simulated["sessions"] = [session for session in simulated["sessions"] if session["id"] not in removed]
            hidden = set(simulated.get("hiddenPiSessions", []))
            hidden.update(change.get("hidden", []))
            hidden.difference_update(change.get("restored", []))
            simulated["hiddenPiSessions"] = list(hidden)
            for key in ("active", "followPi"):
                if key in change:
                    simulated[key] = change[key]
            revision["value"] += 1
            simulated["revision"] = revision["value"]
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"workspace": simulated}, ensure_ascii=False))

        def mock_gpt_api(route):
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"sessions": []}))

        page.route("**/api/workspace", mock_workspace_read)
        page.route("**/api/workspace/changes", mock_workspace_write)
        page.route("**/api/gpt-sessions**", mock_gpt_api)
        page.goto(BASE_URL, wait_until="networkidle", timeout=60_000)
        page.wait_for_selector(".app-shell", timeout=20_000)
        page.wait_for_selector(".session-row", timeout=20_000)

        for row in page.locator(".session-row").all():
            if row.locator(".session-copy > strong").inner_text().strip() == "PPT":
                row.locator(".session-main").click()
                break
        else:
            raise RuntimeError("找不到 PPT 会话")
        page.wait_for_timeout(500)
        if page.get_by_role("button", name="隐藏工作台").count():
            page.get_by_role("button", name="隐藏工作台").click()

        workspace_path = page.locator(".cwd-control button span").inner_text().strip()
        def redact_workspace_path():
            path = workspace_path
            if path:
                page.evaluate("""path => {
                  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                  let node;
                  while ((node = walker.nextNode())) if (node.nodeValue?.includes(path)) node.nodeValue = node.nodeValue.split(path).join('[本地工作目录]');
                  for (const code of document.querySelectorAll('code, pre')) if (code.textContent?.includes('/Users/')) code.textContent = '[本地文件路径已隐藏]';
                }""", path)
        redact_workspace_path()

        # Compact by default; click and ⌘F both reveal search and the question list.
        search_toggle = page.locator(".question-directory-toggle")
        if page.locator(".directory-panel.open").count():
            raise RuntimeError("会话搜索默认应收起")
        search_toggle.click()
        page.locator(".message-search-box input").wait_for(state="visible")
        search_toggle.click()
        page.keyboard.press("Meta+f")
        page.wait_for_function("document.activeElement?.getAttribute('aria-label') === '搜索会话消息'")
        search_toggle.click()

        archive = page.locator(".archive-old-tools")
        archive.wait_for(state="visible")
        if archive.is_disabled():
            raise RuntimeError("PPT 会话没有可一键脱水的旧工具组")
        archive.click()
        page.wait_for_timeout(450)

        target = page.locator(".tool-group").filter(has_text="救命啊").first
        target.wait_for(state="visible")
        step_count = int(target.get_attribute("data-step-count") or "0")
        if step_count < 2:
            raise RuntimeError(f"Gemini 调度说明没有与后续工具步骤合组：{step_count}")
        if not target.locator(".tool-summary-card").is_visible():
            # Bulk dehydration intentionally preserves the newest group; compact it in the mock view as well.
            group_archive = target.locator(".tool-group-archive")
            if group_archive.is_disabled():
                raise RuntimeError("最新工具组有未完成步骤，不能安全脱水")
            group_archive.click()
            page.wait_for_timeout(180)
        if not target.locator(".tool-summary-card").is_visible():
            raise RuntimeError("脱水后没有显示工具组摘要")
        target_details = target.locator(":scope > details")
        if not target_details.evaluate("element => element.open"):
            target_details.locator(":scope > summary").click()
        send_step = target.locator('.tool-step[data-tool-name="gpt_session_send"]').first
        send_step.wait_for(state="attached")
        if not send_step.evaluate("element => element.open"):
            send_step.locator(":scope > summary").click()
        if send_step.get_attribute("data-has-thinking") != "true":
            raise RuntimeError("合组后的 GPT 派发步骤没有保留原始 thinking")
        if not send_step.locator(".tool-step-body").evaluate("element => element.innerHTML.includes('tool-step-thinking')"):
            raise RuntimeError("展开派发步骤后没有渲染 thinking 控件")
        send_step.locator(":scope > summary").click()
        target_details.locator(":scope > summary").click()

        metrics = page.locator(".context-count").inner_text()
        saved = re.search(r"已省\s*(\d+)%", metrics)
        saved_percent = int(saved.group(1)) if saved else 0
        if saved_percent < 50:
            raise RuntimeError(f"上下文节省比例不足 50%：{metrics}")
        target.scroll_into_view_if_needed()
        page.wait_for_timeout(180)
        redact_workspace_path()
        page.screenshot(path=str(OUTPUT), full_page=False, animations="disabled")
        thought_path = OUTPUT.with_name("02-ppt-thinking-in-group.png")
        target_details.locator(":scope > summary").click()
        send_step.locator(":scope > summary").click()
        if not send_step.locator(".tool-step-body").evaluate("element => element.innerHTML.includes('tool-step-thinking')"):
            raise RuntimeError("合组步骤展开后没有 thinking 面板")
        send_step.scroll_into_view_if_needed()
        page.wait_for_timeout(180)
        redact_workspace_path()
        page.screenshot(path=str(thought_path), full_page=False, animations="disabled")
        print(f"saved={OUTPUT.relative_to(ROOT)} and {thought_path.relative_to(ROOT)} · 1440x900 · fullPage=false · groupSteps={step_count} · context={metrics}")
        context.close()
        browser.close()

    if workspace_snapshot() != original:
        raise RuntimeError("截图流程改写了真实 .pi-lab/workspace.json")
    print("workspace snapshot unchanged; GPT-session API and workspace writes were mocked")


if __name__ == "__main__":
    main()
