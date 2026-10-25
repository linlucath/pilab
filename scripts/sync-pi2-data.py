#!/usr/bin/env python3
"""Safely merge the legacy pi 2 workspace and image library into this project."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SOURCE_PROJECT = Path("/Users/linlu/Desktop/pi 2")
SOURCE_META = SOURCE_PROJECT / ".pi-lab"
DEST_META = PROJECT / ".pi-lab"


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def session_digest(session: dict) -> str:
    encoded = json.dumps(session, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_workspace(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != 1 or not isinstance(data.get("sessions"), list):
        raise RuntimeError(f"workspace 格式不符合预期：{path}")
    ids = [session.get("id") for session in data["sessions"]]
    if any(not isinstance(item, str) or not item for item in ids) or len(set(ids)) != len(ids):
        raise RuntimeError(f"workspace 会话 ID 缺失或重复：{path}")
    if data.get("active") not in ids:
        raise RuntimeError(f"workspace 当前会话不存在：{path}")
    return data


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def merge_workspace(source: dict, destination: dict, baseline: dict[str, str]) -> dict:
    source_by_id = {item["id"]: item for item in source["sessions"]}
    destination_by_id = {item["id"]: item for item in destination["sessions"]}
    result = [copy.deepcopy(item) for item in source["sessions"]]
    titles = {item.get("title", "") for item in result}

    def preserved_copy(item: dict) -> dict:
        clone = copy.deepcopy(item)
        if clone.get("piSync"):
            raise RuntimeError(
                f"会话「{clone.get('title', '')}」含 Pi 同步元数据，不能自动克隆；为避免损坏同步身份已中止。"
            )
        clone["id"] = str(uuid.uuid4())
        base = f"{item.get('title', '会话')} · pilab 本地副本"
        title = base
        suffix = 2
        while title in titles:
            title = f"{base} ({suffix})"
            suffix += 1
        clone["title"] = title
        titles.add(title)
        return clone

    preserved = []
    for source_id, local in destination_by_id.items():
        authoritative = source_by_id.get(source_id)
        local_hash = session_digest(local)
        if authoritative is None:
            # Drop an unchanged Pi 2-origin record that Pi 2 intentionally removed;
            # retain it if pilab edited it since the previous merge.
            if source_id in baseline and local_hash == baseline[source_id]:
                continue
            candidate = copy.deepcopy(local)
            if candidate.get("title", "") in titles:
                candidate = preserved_copy(candidate)
            else:
                titles.add(candidate.get("title", ""))
            preserved.append(candidate)
        elif local != authoritative and baseline.get(source_id) != local_hash:
            # Only diverged pilab edits become a preserved alternate. A stale copy
            # of a Pi 2 session is simply refreshed from the authoritative source.
            preserved.append(preserved_copy(local))
    result.extend(preserved)

    hidden = list(dict.fromkeys([*source.get("hiddenPiSessions", []), *destination.get("hiddenPiSessions", [])]))
    deleted = list(dict.fromkeys([*source.get("deletedSessionIds", []), *destination.get("deletedSessionIds", [])]))
    return {
        **copy.deepcopy(source),
        "sessions": result,
        "active": source["active"],
        "revision": max(int(source.get("revision", 0)), int(destination.get("revision", 0))) + 1,
        "hiddenPiSessions": hidden,
        "deletedSessionIds": deleted,
        "followPi": source.get("followPi", destination.get("followPi", False)),
    }


def image_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    files = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"图片库内有符号链接，拒绝自动迁移：{path.relative_to(root)}")
        if path.is_file():
            files.append(path)
    return sorted(files)


def sync_images(source: Path, destination: Path) -> tuple[int, int]:
    files = image_files(source)
    # Preflight every collision before copying anything. Content-addressed image
    # blobs should be identical; differing metadata needs a human decision.
    for src in files:
        rel = src.relative_to(source)
        dst = destination / rel
        if dst.exists() and digest(src) != digest(dst):
            raise RuntimeError(f"图片库同路径内容不同，未覆盖任何文件：{rel}")
    copied = 0
    for src in files:
        rel = src.relative_to(source)
        dst = destination / rel
        if dst.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{dst.name}.", suffix=".tmp", dir=dst.parent)
        os.close(fd)
        try:
            shutil.copy2(src, tmp_name)
            os.replace(tmp_name, dst)
        finally:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass
        copied += 1
    return copied, len(files)


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--force", action="store_true", help="无论时间戳如何都执行合并")
    mode.add_argument("--if-source-newer", action="store_true", help="仅当 pi 2 工作区文件更新时合并")
    args = parser.parse_args()
    src_workspace = SOURCE_META / "workspace.json"
    dst_workspace = DEST_META / "workspace.json"
    if not src_workspace.is_file() or not dst_workspace.is_file():
        raise RuntimeError("源或目标 workspace.json 不存在；未执行迁移。")
    if args.if_source_newer and src_workspace.stat().st_mtime_ns <= dst_workspace.stat().st_mtime_ns:
        print("Pi 2 workspace 未比 pilab 更新；跳过同步。")
        return 0

    source = validate_workspace(src_workspace)
    destination = validate_workspace(dst_workspace)
    state_file = DEST_META / "migrations" / "pi2-sync-state.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        baseline = state.get("sourceSessionHashes", {}) if state.get("version") == 1 else {}
    except FileNotFoundError:
        baseline = {}
    if not isinstance(baseline, dict):
        raise RuntimeError("Pi 2 同步基线格式无效；为保护会话已中止。")
    merged = merge_workspace(source, destination, baseline)
    src_images = SOURCE_META / "images"
    dst_images = DEST_META / "images"
    files_to_copy, total_source_files = sync_images(src_images, dst_images)

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
    backup = DEST_META / "backups" / f"pi2-migration-{stamp}"
    backup.mkdir(parents=True, exist_ok=False, mode=0o700)
    shutil.copy2(dst_workspace, backup / "workspace.before.json")
    shutil.copy2(src_workspace, backup / "workspace.source.json")
    if state_file.exists():
        shutil.copy2(state_file, backup / "sync-state.before.json")
    atomic_json(dst_workspace, merged)
    atomic_json(state_file, {
        "version": 1,
        "sourceRevision": source.get("revision", 0),
        "sourceSessionHashes": {item["id"]: session_digest(item) for item in source["sessions"]},
    })

    titles = [item.get("title", "") for item in merged["sessions"]]
    print(
        f"合并完成：revision={merged['revision']}，active={next((s.get('title') for s in merged['sessions'] if s['id'] == merged['active']), '<missing>')}，"
        f"sessions={len(merged['sessions'])}，images_copied={files_to_copy}/{total_source_files}，"
        f"backup={backup.relative_to(PROJECT)}"
    )
    print("会话：" + "、".join(titles))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"迁移未完成：{error}", file=__import__("sys").stderr)
        raise SystemExit(1)
