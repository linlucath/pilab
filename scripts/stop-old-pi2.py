#!/usr/bin/env python3
"""Gracefully stop only the known pi 2 server listening on the requested port."""
from __future__ import annotations
import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SOURCE = Path("/Users/linlu/Desktop/pi 2").resolve()

def listeners(port: int) -> list[int]:
    result = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
        text=True, capture_output=True, check=False,
    )
    return sorted({int(line) for line in result.stdout.splitlines() if line.strip().isdigit()})

def cwd_of(pid: int) -> Path | None:
    result = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], text=True, capture_output=True)
    for line in result.stdout.splitlines():
        if line.startswith("n"):
            return Path(line[1:]).resolve()
    return None

def command_of(pid: int) -> str:
    return subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="], text=True, capture_output=True).stdout.strip()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    pids = listeners(args.port)
    if not pids:
        print(f"端口 {args.port} 空闲。")
        return 0
    for pid in pids:
        cwd, command = cwd_of(pid), command_of(pid)
        if cwd != SOURCE or "server/index.ts" not in command:
            print(f"端口 {args.port} 被非目标进程占用；未发送信号（PID {pid}）。", file=sys.stderr)
            return 2
    targets = set(pids)
    for pid in pids:
        print(f"向 pi 2 服务 PID {pid} 发送 SIGTERM；不会使用 SIGKILL。", flush=True)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        current = listeners(args.port)
        for pid in current:
            cwd, command = cwd_of(pid), command_of(pid)
            if cwd != SOURCE or "server/index.ts" not in command:
                print(f"端口 {args.port} 被新进程占用；未触碰它（PID {pid}）。", file=sys.stderr)
                return 2
        alive = []
        for pid in targets:
            state = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat="], text=True, capture_output=True).stdout.strip()
            if state and not state.startswith("Z"):
                alive.append(pid)
        if not current and not alive:
            print(f"pi 2 服务已完成 SIGTERM 关闭，端口 {args.port} 已释放。", flush=True)
            return 0
        time.sleep(0.5)
    print(f"等待 {args.timeout} 秒后 pi 2 服务仍未完全退出；未强制终止。", file=sys.stderr)
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
