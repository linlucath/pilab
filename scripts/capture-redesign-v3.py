#!/usr/bin/env python3
"""Capture the corrected GPT report detail state at 1440x900."""
from __future__ import annotations
import copy
import json
import os
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("PILAB_URL", "http://127.0.0.1:3001").rstrip("/")
OUTPUT = ROOT / "artifacts" / "redesign_v3"

def workspace_snapshot():
    with urllib.request.urlopen(f"{BASE_URL}/api/workspace", timeout=5) as response:
        return json.load(response)["workspace"]

def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    original = workspace_snapshot()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, locale="zh-CN")
        page = context.new_page()

        def keep_workspace_in_browser(route):
            change = route.request.post_data_json or {}
            shadow = copy.deepcopy(original)
            if change.get("active") in {session["id"] for session in shadow["sessions"]}:
                shadow["active"] = change["active"]
            shadow["revision"] = original["revision"] + 1
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"workspace": shadow}))
        page.route("**/api/workspace/changes", keep_workspace_in_browser)
        page.goto(BASE_URL, wait_until="networkidle", timeout=60_000)
        page.wait_for_selector(".session-row", timeout=20_000)
        for row in page.locator(".session-row").all():
            if row.locator(".session-copy > strong").inner_text().strip() == "PPT":
                row.locator(".session-main").click()
                break
        else:
            raise RuntimeError("找不到 PPT 会话")
        page.wait_for_timeout(400)
        page.get_by_role("button", name="展开工具过程").click()
        page.wait_for_timeout(180)
        timeline = page.locator('.tool-group[data-step-count="13"]').first
        report = timeline.locator('.tool-step-row[data-tool-name="gpt_session_read"][data-has-report="true"]').first
        if report.count() == 0:
            raise RuntimeError("没有找到配对 GPT 汇报的工具步骤")
        report.locator(":scope > summary").click()
        reply_block = report.locator(".tool-reply-block")
        reply_block.scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        if reply_block.locator("table").count() == 0:
            raise RuntimeError("GPT 汇报中的管道表格未渲染为 HTML table")
        overlap = page.evaluate("""() => {
          const shortcut = document.querySelector('.scroll-shortcuts')?.getBoundingClientRect();
          if (!shortcut) return false;
          return [...document.querySelectorAll('.message-actions')].some((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width && rect.height && shortcut.left < rect.right && shortcut.right > rect.left && shortcut.top < rect.bottom && shortcut.bottom > rect.top;
          });
        }""")
        if overlap:
            raise RuntimeError("滚动快捷按钮仍与消息操作栏重叠")
        page.screenshot(path=str(OUTPUT / "04-ppt-gpt-reply.png"), full_page=False, animations="disabled")
        context.close()
        browser.close()
    if workspace_snapshot() != original:
        raise RuntimeError("截图意外修改了 .pi-lab/workspace.json")
    print(f"saved {OUTPUT.relative_to(ROOT)}/04-ppt-gpt-reply.png · viewport=1440x900 · fullPage=false")

if __name__ == "__main__":
    main()
