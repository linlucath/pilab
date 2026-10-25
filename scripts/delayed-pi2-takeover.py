#!/usr/bin/env python3
"""After a grace period, hand port 3000 from pi 2 to pilab without force-killing."""
from __future__ import annotations
import copy
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = Path("/Users/linlu/Desktop/pi 2")
PORT = 3000
AGENT = Path.home() / ".pi" / "agent"
LOG = Path("/tmp/pilab-delayed-takeover.log")
STOPPER = PROJECT / "scripts" / "stop-old-pi2.py"
DATA_SYNC = PROJECT / "scripts" / "sync-pi2-data.py"
GPT_SYNC = PROJECT / "scripts" / "sync-pi2-gpt-sessions.py"


def log(message: str) -> None:
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(f"{datetime.now().isoformat(timespec='seconds')} {message}\n")
        stream.flush()
        os.fsync(stream.fileno())


def runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")
    env["PORT"] = str(PORT)
    env["PI_CODING_AGENT_DIR"] = str(AGENT)
    env.pop("PI_LAB_GPT_WORKER", None)
    env.pop("PI_LAB_IMAGE_ROOT", None)
    env.pop("PI_LAB_PI_BIN", None)
    return env


def run_logged(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 180) -> None:
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if result.stdout.strip():
        log(result.stdout.strip()[-6000:])
    if result.stderr.strip():
        log("stderr: " + result.stderr.strip()[-6000:])
    if result.returncode:
        raise RuntimeError(f"命令失败（exit={result.returncode}）：{Path(command[0]).name} {' '.join(command[1:])}")


def listeners() -> list[int]:
    result = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-t", f"-iTCP:{PORT}", "-sTCP:LISTEN"],
        text=True, capture_output=True,
    )
    return sorted({int(line) for line in result.stdout.splitlines() if line.strip().isdigit()})


def wait_stable(path: Path, timeout: int = 90) -> None:
    deadline = time.monotonic() + timeout
    previous = None
    stable = 0
    while time.monotonic() < deadline:
        stat = path.stat()
        current = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if current == previous:
            stable += 1
            if stable >= 3:
                return
        else:
            stable = 0
            previous = current
        time.sleep(1)
    raise RuntimeError("Pi 2 workspace 未能稳定；为保护最后一轮消息，没有继续接管。")


def health() -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


def start_server(project: Path, *, production: bool) -> subprocess.Popen:
    env = runtime_env()
    command = [shutil.which("npm", path=env["PATH"]) or "/opt/homebrew/bin/npm", "run", "start" if production else "dev"]
    if not production:
        env.pop("NODE_ENV", None)
    log(f"启动服务：project={project.name} mode={'production' if production else 'development'}")
    with LOG.open("a", encoding="utf-8") as output:
        return subprocess.Popen(
            command, cwd=project, env=env, stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
        )


def wait_health(expected: str, timeout: int = 90) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = health()
        if result and result.get("ok") is True and result.get("workingDirectory") == str(Path(expected).resolve()):
            return result
        time.sleep(0.5)
    return None


def stop_own_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, 15)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        log("新 pilab 进程未能及时退出；没有发送 SIGKILL。")


def restore_pi2_if_possible() -> None:
    if listeners():
        log("回退跳过：3000 仍被进程占用；不会触碰该进程。")
        return
    try:
        process = start_server(SOURCE, production=False)
        result = wait_health(str(SOURCE), 45)
        if result:
            log("回退成功：pi 2 服务已在 3000 恢复。")
        else:
            log(f"回退未确认；pi 2 启动 PID={process.pid}，请查看日志。")
    except Exception as error:
        log(f"无法启动 pi 2 回退服务：{error}")


def main() -> int:
    log("延迟接管任务已启动；等待 15 秒，期间不触碰 3000。")
    time.sleep(15)
    old_stopped = False
    new_process = None
    try:
        env = runtime_env()
        run_logged([shutil.which("npm", path=env["PATH"]) or "/opt/homebrew/bin/npm", "run", "build"], cwd=PROJECT, env=env, timeout=240)
        workspace_path = SOURCE / ".pi-lab" / "workspace.json"
        wait_stable(workspace_path)
        run_logged([sys.executable, str(DATA_SYNC), "--force"], cwd=PROJECT, env=env, timeout=180)
        run_logged([sys.executable, str(GPT_SYNC)], cwd=PROJECT, env=env, timeout=180)
        log("等待期已过、首轮数据同步完成；现在温和停止旧实例以刷新最后状态。")
        run_logged([sys.executable, str(STOPPER), "--port", str(PORT), "--timeout", "90"], cwd=PROJECT, env=env, timeout=100)
        old_stopped = True
        # SIGTERM runs Pi Lab's graceful shutdown (flushes workspace and suspends
        # GPT workers). Re-sync afterward so the final reply and worker event tail
        # are included before pilab starts serving 3000.
        wait_stable(workspace_path)
        run_logged([sys.executable, str(DATA_SYNC), "--force"], cwd=PROJECT, env=env, timeout=180)
        run_logged([sys.executable, str(GPT_SYNC)], cwd=PROJECT, env=env, timeout=180)
        if listeners():
            raise RuntimeError("3000 在同步后被另一个进程重新占用；不会终止它。")
        new_process = start_server(PROJECT, production=True)
        if not wait_health(str(PROJECT), 90):
            raise RuntimeError(f"pilab 新服务未能通过健康检查；启动 PID={new_process.pid}。")
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/workspace", timeout=5) as response:
            workspace = json.load(response)["workspace"]
        titles = {session.get("title") for session in workspace.get("sessions", [])}
        if not {"PPT", "pi", "pi · 分支"}.issubset(titles):
            raise RuntimeError("新服务工作区缺少预期主会话。")
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/gpt-sessions", timeout=10) as response:
            workers = json.load(response).get("sessions", [])
        log(
            f"接管成功：3000 工作目录={PROJECT}；workspace revision={workspace.get('revision')}，"
            f"sessions={len(workspace.get('sessions', []))}；GPT摘要数={len(workers)}。"
        )
        return 0
    except Exception as error:
        log(f"接管未完成：{error}")
        if new_process is not None:
            stop_own_process(new_process)
        if old_stopped:
            restore_pi2_if_possible()
        return 1

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"后台任务异常：{error}")
        raise SystemExit(1)
