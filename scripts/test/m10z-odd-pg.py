#!/usr/bin/env python3
"""Run isolated PostgreSQL integration tests and cross-build binaries without logs."""

import argparse
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
OUT.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument("--output", default="pg-and-binaries.json", choices=("pg-and-binaries.json", "final-pg.json"))
parser.add_argument("--integration-only", action="store_true")
args = parser.parse_args()
result_path = OUT / args.output
receipt = json.loads((BASE / "postgres.json").read_text())
if receipt.get("name") != "whippet-m10z-20261114-pg" or receipt.get("port") != 32782 or not receipt.get("ready"):
    raise SystemExit("isolated_pg_receipt_mismatch")

SAFE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_./-]{0,119}$")


def run(label, cwd, args, pg=False, cross=False):
    clean_env = os.environ.copy()
    for key in tuple(clean_env):
        if key.startswith("WHIPPET_") or key in ("TEST_DATABASE_URL", "DATABASE_URL"):
            clean_env.pop(key, None)
    if pg:
        clean_env["TEST_DATABASE_URL"] = receipt["dsn"]
    if cross:
        clean_env.update(GOOS="linux", GOARCH="arm64", CGO_ENABLED="0")
    start = time.perf_counter()
    proc = subprocess.run(args, cwd=cwd, env=clean_env, capture_output=True, text=True, errors="replace")
    item = {"label": label, "command": args, "exit": proc.returncode,
            "seconds": round(time.perf_counter() - start, 3)}
    if pg:
        tests = {}
        for line in proc.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            name, action = event.get("Test"), event.get("Action")
            if isinstance(name, str) and SAFE_NAME.fullmatch(name) and action in ("pass", "fail", "skip"):
                tests[name] = action
        item["tests"] = {action: sorted(n for n, a in tests.items() if a == action)
                         for action in ("pass", "fail", "skip")}
    return item


checks = [run("server-pg-integration", ROOT / "services/server",
              ["go", "test", "-json", "-tags=integration", "./..."], pg=True)]
for name in (() if args.integration_only else ("server", "manager")):
    target = OUT / f"{name}-linux-arm64"
    checks.append(run(f"{name}-linux-arm64", ROOT / "services" / name,
                      ["go", "build", "-o", str(target), f"./cmd/{name}"], cross=True))
    if checks[-1]["exit"] == 0 and target.exists():
        checks[-1]["artifact"] = str(target)
        checks[-1]["size_bytes"] = target.stat().st_size

result_path.write_text(json.dumps({"checks": checks}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(result_path),
                  "checks": [{"label": c["label"], "exit": c["exit"], "seconds": c["seconds"],
                              "pass": len(c.get("tests", {}).get("pass", [])),
                              "fail": c.get("tests", {}).get("fail", []),
                              "skip": c.get("tests", {}).get("skip", []),
                              "artifact": c.get("artifact")}
                             for c in checks]}, ensure_ascii=False))
sys.exit(0 if all(c["exit"] == 0 for c in checks) else 1)
