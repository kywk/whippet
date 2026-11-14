#!/usr/bin/env python3
"""Run exactly seven synthetic three-end M10 bridges against isolated PG."""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
receipt = json.loads((BASE / "postgres.json").read_text())
if receipt.get("name") != "whippet-m10z-20261114-pg" or not receipt.get("ready"):
    raise SystemExit("isolated_pg_not_ready")
names = [
    "TestM10HarnessServerBridge", "TestM10PartialServerBridge",
    "TestM105BatchSummaryServerBridge", "TestM10ModuleSummaryServerBridge",
    "TestM106PlatformServerBridge", "TestM106ModuleServerBridge",
    "TestM106BridgeRequestDiagnostics",
]
entry = ROOT / "runtimes/worker/dist/author/main.js"
manager_go = Path("/Users/kywk/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.0.darwin-arm64/bin/go")
if not entry.is_file():
    raise SystemExit("worker_dist_entry_missing")
if not manager_go.is_file():
    raise SystemExit("manager_go125_missing")
env = os.environ.copy()
for key in tuple(env):
    if key.startswith("WHIPPET_") or key in ("DATABASE_URL", "TEST_DATABASE_URL", "OPENCODE_API_KEY"):
        env.pop(key, None)
env.update(TEST_DATABASE_URL=receipt["dsn"], WHIPPET_M10_WORKER_ENTRY=str(entry),
           WHIPPET_M10_BRIDGE_WORKER_ENTRY=str(entry), WHIPPET_M10_MANAGER_GO=str(manager_go),
           GOPROXY="off", GOSUMDB="off", GOTOOLCHAIN="local")
cmd = ["go", "test", "-json", "-tags=integration,m10bridge", "-count=1", "./internal/server",
       "-run", "^(?:" + "|".join(names) + ")$"]
start = time.perf_counter()
proc = subprocess.run(cmd, cwd=ROOT / "services/server", env=env,
                      capture_output=True, text=True, errors="replace")
events = {}
for line in proc.stdout.splitlines():
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    name, action = row.get("Test"), row.get("Action")
    if name in names and action in ("pass", "fail", "skip"):
        events[name] = {"status": action, "elapsedSeconds": row.get("Elapsed")}
result = {"command": cmd, "exit": proc.returncode,
          "seconds": round(time.perf_counter() - start, 3),
          "workerEntry": str(entry), "provider": "synthetic",
          "dockerWorkerUsed": False, "tests": [{"name": name, **events.get(name, {"status": "not_observed"})}
                                         for name in names]}
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "bridge-seven.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "bridge-seven.json"), "exit": proc.returncode,
                  "seconds": result["seconds"], "tests": result["tests"]}, ensure_ascii=False))
sys.exit(0 if proc.returncode == 0 and all(x["status"] == "pass" for x in result["tests"]) else 1)
