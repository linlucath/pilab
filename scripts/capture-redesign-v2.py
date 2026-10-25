#!/usr/bin/env python3
"""Capture Round 2 UI states at a fixed viewport without persisting workspace selection."""
from __future__ import annotations
import copy
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("PILAB_URL", "http://127.0.0.1:3001").rstrip("/")
OUTPUT = ROOT / "artifacts" / "redesign_v2"
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

        # Keep visual session switches in-memory; never write the user's active tab to disk.
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
        page.wait_for_timeout(1200)

        def save(filename: str):
            page.screenshot(path=str(OUTPUT / filename), full_page=False, animations="disabled")
            print(f"saved {filename}")

        def select_session(title: str):
            for row in page.locator(".session-row").all():
                if row.locator(".session-copy > strong").inner_text().strip() == title:
                    row.locator(".session-main").click()
                    page.wait_for_timeout(450)
                    return
            raise RuntimeError(f"会话不存在：{title}")

        select_session("pi")
        page.locator(".message-stream").evaluate("element => element.scrollTop = 0")
        save("01-pi-light-home.png")

        select_session("PPT")
        page.locator(".message-stream").evaluate("element => element.scrollTop = 0")
        save("02-ppt-150-collapsed.png")
        page.get_by_role("button", name="展开工具过程").click()
        page.wait_for_timeout(300)
        timeline = page.locator(".tool-group").first
        if timeline.count() == 0:
            raise RuntimeError("PPT 会话未找到工具时间线卡片。")
        timeline.scroll_into_view_if_needed()
        if timeline.locator(".tool-step-row").count() < 2:
            raise RuntimeError("工具时间线未聚合出步骤行。")
        if page.get_by_text("空消息", exact=True).count():
            raise RuntimeError("工具调用空正文仍显示“空消息”。")
        create_step = timeline.locator('.tool-step-row[data-tool-name="gpt_session_create"]').first
        create_step.locator(":scope > summary").click()
        page.wait_for_timeout(180)
        save("03-ppt-gpt-instruction.png")

        create_step.locator(":scope > summary").click()
        reply_step = page.locator('.tool-step-row[data-has-report="true"]').first
        if reply_step.count() == 0:
            raise RuntimeError("PPT 会话未找到配对 GPT 汇报步骤。")
        reply_step.scroll_into_view_if_needed()
        reply_step.locator(":scope > summary").click()
        reply_step.locator(".tool-reply-block").scroll_into_view_if_needed()
        page.wait_for_timeout(220)
        save("04-ppt-gpt-reply.png")

        select_session("pi")
        page.locator(".message-stream").evaluate("element => element.scrollTop = 0")
        page.locator(".worker-history-toggle").click()
        page.wait_for_timeout(150)
        target_row = None
        for row in page.locator(".worker-history-row").all():
            if row.locator(".worker-history-name").inner_text().strip() == "test-session":
                target_row = row
                break
        if target_row is None:
            target_row = page.locator(".worker-history-row").first
        target_row.scroll_into_view_if_needed()
        target_row.click()
        page.wait_for_timeout(200)
        target_row.locator("xpath=..").scroll_into_view_if_needed()
        save("05-gpt-worker-detail.png")

        context.close()
        browser.close()
    if workspace_snapshot() != saved_workspace:
        raise RuntimeError("截图意外修改了 .pi-lab/workspace.json 工作区快照。")
    print(f"screenshots={OUTPUT.relative_to(ROOT)} count=5 viewport=1440x900 fullPage=false dpr=2")

if __name__ == "__main__":
    main()
