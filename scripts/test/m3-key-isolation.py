#!/usr/bin/env python3
"""M3 key isolation 證據（live 驗收用，合成整合）。
poll docker ps --filter label=whippet.manager.id=local-runner，
對未看過容器 docker inspect（capture_output，不印 rawJSON、不寫檔），
解析 Config.Cmd 辨認 author/main.js 或 runner.js，
檢查 Config.Env 是否含非空 OPENCODE_API_KEY，只印 runId/kind/keyPresent。
author 必須 true、普通 run 必須 false，違反立即非零。
見到至少 1 author 及 1 run 即 exit0；最多 300 秒，每秒 poll；容器已刪則跳過。
不印環境值、不 exec、不連模型。
"""
import json
import subprocess
import sys
import time

LABEL_FILTER = "label=whippet.manager.id=local-runner"
DEADLINE_S = 300

def docker_ps():
    p = subprocess.run(
        ["docker", "ps", "--filter", LABEL_FILTER, "--format", "{{.ID}}"],
        capture_output=True, text=True, timeout=15,
    )
    if p.returncode != 0:
        return []
    return [c.strip() for c in p.stdout.splitlines() if c.strip()]

def docker_inspect(cid):
    # 容器已刪等情況由呼叫方跳過；絕不印 rawJSON、絕不寫檔
    p = subprocess.run(
        ["docker", "inspect", cid],
        capture_output=True, text=True, timeout=15,
    )
    if p.returncode != 0:
        return None
    try:
        data = json.loads(p.stdout)
    except Exception:
        return None
    if not data:
        return None
    return data[0]

def classify(cmd_list):
    joined = " ".join(cmd_list or "")
    low = joined.lower()
    if "author" in low or "main.js" in low:
        return "author"
    if "runner.js" in low or ("runner" in low and "author" not in low):
        return "run"
    return "unknown"

def extract_run_id(obj, cid):
    # 僅取 labels / name / cmd 中的 run 識別，不碰 Env 值
    labels = {}
    try:
        labels = (obj.get("Config") or {}).get("Labels") or {}
    except Exception:
        labels = {}
    for k, v in labels.items():
        kl = str(k).lower()
        if "run" in kl and v:
            return str(v)[:64]
    name = obj.get("Name") or ""
    if name:
        return name.strip("/  ")[:64]
    return f"container-{cid[:12]}"

def has_nonempty_key(env_list):
    for item in env_list or []:
        if not isinstance(item, str):
            continue
        if item.startswith("OPENCODE_API_KEY="):
            return len(item.split("=", 1)[1]) > 0
    return False

def main():
    seen = set()
    seen_author = 0
    seen_run = 0
    start = time.time()
    while time.time() - start < DEADLINE_S:
        try:
            cids = docker_ps()
        except Exception as e:
            print(f"poll ps failed retry err={type(e).__name__}", flush=True)
            time.sleep(1)
            continue
        for cid in cids:
            if cid in seen:
                continue
            seen.add(cid)
            try:
                obj = docker_inspect(cid)
            except Exception:
                continue  # 已刪或瞬態，跳過
            if obj is None:
                continue  # 已刪，跳過
            cfg = obj.get("Config") or {}
            kind = classify(cfg.get("Cmd") or cfg.get("Entrypoint") or [])
            if kind == "unknown":
                print(f"runId={extract_run_id(obj, cid)} kind=unknown keyPresent=skip", flush=True)
                continue
            key_present = has_nonempty_key(cfg.get("Env") or [])
            print(
                f"runId={extract_run_id(obj, cid)} kind={kind} "
                f"keyPresent={'true' if key_present else 'false'}",
                flush=True,
            )
            if kind == "author":
                if not key_present:
                    print("FAIL author missing OPENCODE_API_KEY", flush=True)
                    return 1
                seen_author += 1
            elif kind == "run":
                if key_present:
                    print("FAIL run leaked OPENCODE_API_KEY", flush=True)
                    return 1
                seen_run += 1
            if seen_author >= 1 and seen_run >= 1:
                print(f"DONE author={seen_author} run={seen_run}", flush=True)
                return 0
        if seen_author >= 1 and seen_run >= 1:
            print(f"DONE author={seen_author} run={seen_run}", flush=True)
            return 0
        time.sleep(1)
    print(f"FAIL timeout author={seen_author} run={seen_run}", flush=True)
    return 1

if __name__ == "__main__":
    sys.exit(main())
