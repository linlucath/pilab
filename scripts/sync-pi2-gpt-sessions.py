#!/usr/bin/env python3
"""Copy only inactive Pi 2 GPT worker records into pilab's owner namespace."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

AGENT = Path(os.environ.get("PI_CODING_AGENT_DIR") or (Path.home() / ".pi" / "agent")).resolve()
SOURCE_ROOT = Path("/Users/linlu/Desktop/pi 2").resolve()
DEST_ROOT = Path(__file__).resolve().parents[1]

def owner_dir(project: Path) -> Path:
    key = hashlib.sha256(f"lab:{project}".encode()).hexdigest()[:24]
    return AGENT / "gpt-sessions" / key

def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def copy_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    try:
        shutil.copy2(source, tmp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, destination)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

def main() -> int:
    source_dir, dest_dir = owner_dir(SOURCE_ROOT), owner_dir(DEST_ROOT)
    source_manifest, dest_manifest = source_dir / "sessions.json", dest_dir / "sessions.json"
    if not source_manifest.is_file():
        print("Pi 2 GPT manifest 不存在；跳过。")
        return 0
    source_data = json.loads(source_manifest.read_text(encoding="utf-8"))
    if source_data.get("version") != 1 or not isinstance(source_data.get("sessions"), list):
        raise RuntimeError("Pi 2 GPT manifest 格式无效；未写入目标。")
    inactive = [item for item in source_data["sessions"] if item.get("status") in {"suspended", "idle"}]
    active = [item.get("name", "<unnamed>") for item in source_data["sessions"] if item.get("status") in {"starting", "running", "waiting_input"}]
    dest_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if dest_manifest.exists():
        dest_data = json.loads(dest_manifest.read_text(encoding="utf-8"))
        if dest_data.get("version") != 1 or not isinstance(dest_data.get("sessions"), list):
            raise RuntimeError("pilab GPT manifest 格式无效；未覆盖。")
    else:
        dest_data = {"version": 1, "sessions": []}
    destination_by_id = {item["id"]: copy.deepcopy(item) for item in dest_data["sessions"]}
    source_by_id = {item["id"]: copy.deepcopy(item) for item in inactive}
    if len(source_by_id) != len(inactive) or len(destination_by_id) != len(dest_data["sessions"]):
        raise RuntimeError("GPT manifest 存在重复会话 ID；未写入目标。")
    for session_id in source_by_id.keys() & destination_by_id.keys():
        if destination_by_id[session_id].get("status") in {"starting", "running", "waiting_input"}:
            raise RuntimeError("目标命名空间同一 GPT 会话仍在运行；拒绝覆盖。")

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
    backup = DEST_ROOT / ".pi-lab" / "backups" / f"gpt-session-sync-{stamp}"
    to_copy: list[tuple[Path, Path]] = []
    for session_id, info in source_by_id.items():
        event_src = source_dir / f"{session_id}.events.jsonl"
        event_dst = dest_dir / f"{session_id}.events.jsonl"
        if event_src.exists():
            if event_dst.exists() and file_hash(event_src) != file_hash(event_dst):
                backup.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(event_dst, backup / event_dst.name)
            to_copy.append((event_src, event_dst))
        destination_by_id[session_id] = info
    if dest_manifest.exists():
        # Keep an exact rollback point before replacing source-owned records.
        backup.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(dest_manifest, backup / "sessions.before.json")
    for source, destination in to_copy:
        copy_atomic(source, destination)
    merged = {"version": 1, "sessions": list(destination_by_id.values())}
    atomic_json(dest_manifest, merged)
    print(
        f"GPT 会话同步完成：已复制/更新 {len(source_by_id)} 条挂起或空闲记录；"
        f"目标总数 {len(merged['sessions'])}；仍运行且未复制 {len(active)} 条。"
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
