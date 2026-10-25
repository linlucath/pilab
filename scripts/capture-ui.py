#!/usr/bin/env python3
"""Capture Pi Lab's main UI states with headless Chromium via Python Playwright."""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts" / "pilab_initial_ui"


def health(base_url: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=1.5) as response:
            data = json.load(response)
        if Path(data.get("workingDirectory", "")).resolve() == ROOT:
            return data
    except (OSError, ValueError, urllib.error.URLError):
        pass
    return None


def port_is_free(port: int) -> bool:
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def get_base_url(requested_url: str | None) -> str:
    if requested_url:
        base_url = requested_url.rstrip("/")
        if not health(base_url):
            raise RuntimeError(f"{base_url} 未响应本项目的 /api/health。")
        return base_url

    # Reuse an existing Pi Lab instance; do not accidentally capture another app
    # that happens to occupy the default port.
    for port in range(3000, 3011):
        base_url = f"http://127.0.0.1:{port}"
        if health(base_url):
            return base_url

    port = next((candidate for candidate in range(3000, 3011) if port_is_free(candidate)), None)
    if port is None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

    log_path = Path("/tmp/pilab-screenshot-dev-server.log")
    log = log_path.open("ab")
    env = os.environ.copy()
    env["PORT"] = str(port)
    subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(80):
        if health(base_url):
            return base_url
        time.sleep(0.5)
    raise RuntimeError(f"Pi Lab 服务启动超时，请检查 {log_path}。")


def capture(base_url: str) -> list[Path]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError(
            "缺少 Python Playwright。请运行：python3 -m pip install playwright "
            "&& python3 -m playwright install chromium"
        ) from error

    OUTPUT.mkdir(parents=True, exist_ok=True)
    screenshots: list[Path] = []
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(headless=True)
        except Exception as error:
            raise RuntimeError(
                "找不到 Playwright Chromium。请运行：python3 -m playwright install chromium"
            ) from error

        context = browser.new_context(
            viewport={"width": 1920, "height": 1200},
            device_scale_factor=2,
            locale="zh-CN",
        )
        page = context.new_page()
        page.goto(base_url, wait_until="networkidle", timeout=60_000)
        page.wait_for_selector(".workspace-grid", timeout=20_000)
        page.wait_for_timeout(1_000)

        def save(name: str) -> None:
            destination = OUTPUT / name
            page.screenshot(path=str(destination), full_page=True)
            screenshots.append(destination)

        save("01-editor-home.png")
        page.get_by_role("button", name="请求检查").click()
        page.wait_for_timeout(200)
        save("02-request-inspector.png")
        page.get_by_role("button", name="运行记录").click()
        page.wait_for_timeout(200)
        save("03-run-history.png")
        page.locator(".endpoint-button").click()
        page.wait_for_selector('[role="dialog"]', timeout=5_000)
        page.wait_for_timeout(150)
        save("04-model-connection-dialog.png")
        page.get_by_role("button", name="保存并应用").click()
        page.get_by_role("button", name="消息编排").click()
        page.get_by_role("button", name="切换浅色主题").click()
        page.wait_for_timeout(250)
        save("05-light-theme.png")
        context.close()

        mobile = browser.new_context(
            viewport={"width": 430, "height": 932},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
            locale="zh-CN",
        )
        mobile_page = mobile.new_page()
        mobile_page.goto(base_url, wait_until="networkidle", timeout=60_000)
        mobile_page.wait_for_selector(".workspace-grid", timeout=20_000)
        mobile_page.wait_for_timeout(500)
        destination = OUTPUT / "06-mobile-responsive.png"
        mobile_page.screenshot(path=str(destination), full_page=True)
        screenshots.append(destination)
        mobile.close()
        browser.close()
    return screenshots


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Reuse an already-running Pi Lab URL")
    args = parser.parse_args()
    try:
        base_url = get_base_url(args.url)
        screenshots = capture(base_url)
    except Exception as error:
        print(f"截图失败：{error}", file=sys.stderr)
        return 1

    print(f"Pi Lab 截图完成：{base_url}")
    for screenshot in screenshots:
        print(screenshot.relative_to(ROOT))
    print("提示：在当前 Pi 会话中使用 present_images 提交以上截图供视觉审阅。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
