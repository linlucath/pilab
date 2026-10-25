#!/usr/bin/env python3
"""Capture fixed-viewport redesign states without persisting workspace selection changes."""
from __future__ import annotations
import copy
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("PILAB_URL", "http://127.0.0.1:3001").rstrip("/")
OUTPUT = ROOT / "artifacts" / "redesign_v1"
VIEWPORT = {"width": 1440, "height": 900}

def workspace_snapshot():
    with urllib.request.urlopen(f"{BASE_URL}/api/workspace", timeout=5) as response:
        return json.load(response)["workspace"]

def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    saved_workspace = workspace_snapshot()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=2, locale="zh-CN")
        page = context.new_page()

        # Session selection is useful for screenshots but should not mutate the user's saved active tab.
        def keep_workspace_in_browser(route):
            change = route.request.post_data_json or {}
            shadow = copy.deepcopy(saved_workspace)
            by_id = {session["id"]: session for session in shadow["sessions"]}
            for patch in change.get("sessions", []):
                session_id = patch.get("id")
                if session_id in by_id:
                    by_id[session_id].update({key: value for key, value in patch.items() if key != "id"})
            for session_id in change.get("removed", []):
                shadow["sessions"] = [item for item in shadow["sessions"] if item["id"] != session_id]
            if change.get("active") in {item["id"] for item in shadow["sessions"]}:
                shadow["active"] = change["active"]
            if "followPi" in change:
                shadow["followPi"] = change["followPi"]
            shadow["revision"] = saved_workspace["revision"] + 1
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"workspace": shadow}))
        page.route("**/api/workspace/changes", keep_workspace_in_browser)
        page.goto(BASE_URL, wait_until="networkidle", timeout=60_000)
        page.wait_for_selector(".app-shell", timeout=20_000)
        page.wait_for_selector(".session-row", timeout=20_000)
        page.wait_for_timeout(1400)

        def save(filename: str):
            page.screenshot(path=str(OUTPUT / filename), full_page=False, animations="disabled")
            print(f"saved {filename}")

        def select_session(title: str):
            for row in page.locator(".session-row").all():
                if row.locator(".session-copy > strong").inner_text().strip() == title:
                    row.locator(".session-main").click()
                    return
            raise RuntimeError(f"会话不存在：{title}")

        save("01-pi-light.png")

        select_session("PPT")
        page.wait_for_timeout(500)
        page.locator(".message-stream").evaluate("element => element.scrollTop = 0")
        save("02-ppt-150-messages.png")

        page.get_by_role("button", name="展开工具过程").click()
        page.wait_for_timeout(350)
        tool_groups = page.locator(".tool-group")
        tool_steps = page.locator(".assistant-tool-steps .tool-step")
        if tool_groups.count():
            tool_groups.first.scroll_into_view_if_needed()
        elif tool_steps.count():
            tool_steps.first.scroll_into_view_if_needed()
        page.wait_for_timeout(250)
        save("03-tool-steps-expanded.png")

        select_session("pi")
        page.wait_for_timeout(350)
        page.get_by_role("button", name="请求检查").click()
        page.wait_for_timeout(300)
        page.locator(".scroll-view").evaluate("element => element.scrollTop = 0")
        save("04-request-inspection.png")

        page.locator(".view-switch button").filter(has_text="对话").click()
        page.wait_for_timeout(250)
        page.get_by_role("button", name="切换深色模式").click()
        page.wait_for_timeout(300)
        page.locator(".message-stream").evaluate("element => element.scrollTop = 0")
        save("05-pi-dark.png")

        context.close()
        browser.close()
    if workspace_snapshot() != saved_workspace:
        raise RuntimeError("截图意外修改了 .pi-lab/workspace.json 的工作区快照。")
    print(f"screenshots={OUTPUT.relative_to(ROOT)} count=5 viewport=1440x900 fullPage=false dpr=2")

if __name__ == "__main__":
    main()
