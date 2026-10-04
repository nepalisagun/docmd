#!/usr/bin/env python3
"""
--------------------------------------------------------------------
docmd : the zero-config documentation engine.

@package     @docmd/engine-python
@website     https://docmd.io
@repository  https://github.com/docmd-io/docmd
@license     MIT
@copyright   Copyright (c) 2025-present docmd.io

[docmd-source] - Please do not remove this header.
--------------------------------------------------------------------
"""

import sys
import os
import json
import time
import re
import math
import subprocess
from concurrent.futures import ThreadPoolExecutor

SKIP_DIRS = {"node_modules", ".git", ".docmd", "dist", "site"}


def file_discover(payload):
    directory = payload.get("dir")
    if not directory:
        raise ValueError("file:discover: missing 'dir'")

    raw_exts = payload.get("extensions")
    ext_set = set(raw_exts) if raw_exts else None

    raw_exclude = payload.get("exclude") or []
    skip_set = SKIP_DIRS | set(raw_exclude)

    results = []

    def walk(current_dir):
        try:
            with os.scandir(current_dir) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name not in skip_set:
                                walk(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            _, ext = os.path.splitext(entry.name)
                            ext_lower = ext.lower()
                            if not ext_set or ext_lower in ext_set or entry.name in ext_set:
                                stat = entry.stat()
                                results.append({
                                    "path": entry.path,
                                    "size": stat.st_size,
                                    "mtimeMs": int(stat.st_mtime * 1000)
                                })
                    except (OSError, PermissionError):
                        continue
        except (OSError, PermissionError):
            return

    walk(directory)
    return results


def file_read(payload):
    file_path = payload.get("path")
    if not file_path:
        raise ValueError("file:read: missing 'path'")
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def file_read_batch(payload):
    paths = payload.get("paths", [])
    if not isinstance(paths, list):
        raise ValueError("file:readBatch: 'paths' must be an array")

    results = {}
    if not paths:
        return results

    def read_one(p):
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                return p, f.read()
        except Exception:
            return p, ""

    max_workers = min(32, len(paths) or 1)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for p, content in executor.map(read_one, paths):
            results[p] = content

    return results


def file_write(payload):
    file_path = payload.get("path")
    content = payload.get("content", "")
    if not file_path:
        raise ValueError("file:write: missing 'path'")

    parent = os.path.dirname(file_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    return {"success": True}


def file_exists(payload):
    file_path = payload.get("path")
    if not file_path:
        return False
    return os.path.exists(file_path)


def git_log(payload):
    file_paths = payload.get("filePaths", [])
    max_commits = int(payload.get("maxCommits", 6))
    if not isinstance(file_paths, list):
        raise ValueError("git:log: 'filePaths' must be an array")

    results = {}
    if not file_paths:
        return results

    cwd = os.getcwd()

    def log_one(fp):
        cmd = [
            "git", "log", "--follow", "-n", str(max_commits),
            "--format=%H|%h|%an|%ae|%at|%s", "--", fp
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=cwd)
            if res.returncode == 0 and res.stdout.strip():
                entries = []
                for line in res.stdout.strip().split("\n"):
                    if not line:
                        continue
                    parts = line.split("|", 5)
                    ts = 0
                    if len(parts) > 4:
                        try:
                            ts = int(parts[4]) * 1000
                        except ValueError:
                            ts = 0
                    entries.append({
                        "hash": parts[0] if len(parts) > 0 else "",
                        "shortHash": parts[1] if len(parts) > 1 else "",
                        "author": parts[2] if len(parts) > 2 else "",
                        "email": parts[3] if len(parts) > 3 else "",
                        "timestamp": ts,
                        "message": parts[5] if len(parts) > 5 else ""
                    })
                return fp, entries
            return fp, []
        except Exception:
            return fp, []

    max_workers = min(16, len(file_paths) or 1)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for fp, entries in executor.map(log_one, file_paths):
            results[fp] = entries

    return results


def git_status(_payload):
    cwd = os.getcwd()
    try:
        res = subprocess.run(["git", "status", "--porcelain"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=cwd)
        if res.returncode == 0:
            lines = res.stdout.strip().split("\n")
            status_entries = []
            for line in lines:
                if line and len(line) >= 3:
                    status_entries.append({
                        "status": line[:2].strip(),
                        "path": line[3:].strip()
                    })
            return status_entries
        return []
    except Exception:
        return []


def search_index(payload):
    documents = payload.get("documents", [])
    indexed = []
    for doc in documents:
        title = str(doc.get("title", "")).lower()
        content = str(doc.get("content", "")).lower()[:5000]
        indexed_doc = {
            "id": doc.get("id"),
            "title": title,
            "content": content,
            "path": doc.get("path")
        }
        if "locale" in doc and doc["locale"] is not None:
            indexed_doc["locale"] = doc["locale"]
        if "version" in doc and doc["version"] is not None:
            indexed_doc["version"] = doc["version"]
        indexed.append(indexed_doc)

    index_obj = {
        "documents": indexed,
        "builtAt": int(time.time() * 1000)
    }
    return json.dumps(index_obj)


def search_chunk(payload):
    text = payload.get("text", "")
    file_path = payload.get("file", "")
    chunk_size = int(payload.get("chunkSize", 256))
    chunk_overlap = int(payload.get("chunkOverlap", 32))

    chunks = []
    current_heading = None
    current_words = []
    current_start = 0
    byte_pos = 0

    heading_re = re.compile(r"^#{1,6}\s")

    for line in text.split("\n"):
        line_bytes = len(line.encode("utf-8")) + 1

        if heading_re.match(line):
            if current_words:
                chunks.append({
                    "file": file_path,
                    "heading": current_heading,
                    "text": " ".join(current_words),
                    "range": [current_start, byte_pos]
                })
                current_words = current_words[-chunk_overlap:] if chunk_overlap > 0 else []
                current_start = byte_pos
            current_heading = re.sub(r"^#+\s*", "", line).strip()
        else:
            words = [w for w in re.split(r"\s+", line) if w]
            current_words.extend(words)

            if len(current_words) >= chunk_size:
                chunks.append({
                    "file": file_path,
                    "heading": current_heading,
                    "text": " ".join(current_words),
                    "range": [current_start, byte_pos + line_bytes]
                })
                current_words = current_words[-chunk_overlap:] if chunk_overlap > 0 else []
                current_start = byte_pos

        byte_pos += line_bytes

    if current_words:
        chunks.append({
            "file": file_path,
            "heading": current_heading,
            "text": " ".join(current_words),
            "range": [current_start, byte_pos]
        })

    return chunks


def search_quantize(payload):
    vectors = payload.get("vectors", [])
    dimensions = int(payload.get("dimensions", 384))

    quantized = []
    mins = []
    ranges = []

    for vec in vectors:
        v = vec if len(vec) == dimensions else (vec + [0.0] * (dimensions - len(vec)))[:dimensions]
        v_min = float(min(v)) if v else 0.0
        v_max = float(max(v)) if v else 1.0
        v_range = v_max - v_min
        if abs(v_range) < 1e-10:
            v_range = 1.0

        q = [round(((x - v_min) / v_range) * 255 - 128) for x in v]
        quantized.append(q)
        mins.append(v_min)
        ranges.append(v_range)

    return {"quantized": quantized, "mins": mins, "ranges": ranges}


def search_cosine(payload):
    query = payload.get("query", [])
    vectors = payload.get("vectors", [])
    top_k = int(payload.get("topK", 10))

    q_norm = math.sqrt(sum(x * x for x in query))
    if q_norm < 1e-10:
        return []

    scores = []
    for idx, vec in enumerate(vectors):
        dot = sum(q * v for q, v in zip(query, vec))
        v_norm = math.sqrt(sum(v * v for v in vec))
        sim = 0.0 if v_norm < 1e-10 else dot / (q_norm * v_norm)
        scores.append({"index": idx, "score": sim})

    scores.sort(key=lambda s: s["score"], reverse=True)
    return scores[:top_k]


HANDLERS = {
    "file:discover": file_discover,
    "file:read": file_read,
    "file:readBatch": file_read_batch,
    "file:write": file_write,
    "file:exists": file_exists,
    "git:log": git_log,
    "git:status": git_status,
    "search:index": search_index,
    "search:chunk": search_chunk,
    "search:quantize": search_quantize,
    "search:cosine": search_cosine,
}


def dispatch_task(task_type, payload):
    handler = HANDLERS.get(task_type)
    if not handler:
        raise ValueError(f"Unknown task type: '{task_type}'")
    return handler(payload)


def listen_loop():
    """Persistent stdio line-delimited JSON-RPC loop."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            task_type = req.get("type")
            payload = req.get("payload", {})
            start = time.time()
            data = dispatch_task(task_type, payload)
            duration = int((time.time() - start) * 1000)
            response = {
                "id": req_id,
                "success": True,
                "data": data,
                "duration": duration
            }
        except Exception as e:
            response = {
                "id": req_id,
                "success": False,
                "error": str(e)
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--listen":
        listen_loop()
        return

    if len(sys.argv) > 1 and sys.argv[1] == "--ping":
        print(json.dumps({"pong": True, "version": sys.version}))
        return

    if len(sys.argv) >= 3:
        task_type = sys.argv[1]
        try:
            payload = json.loads(sys.argv[2])
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {e}"}))
            return

        try:
            start = time.time()
            data = dispatch_task(task_type, payload)
            duration = int((time.time() - start) * 1000)
            print(json.dumps({"success": True, "data": data, "duration": duration}))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
        return

    print("Usage: runner.py --listen | runner.py <task_type> <payload_json>", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()