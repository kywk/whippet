#!/usr/bin/env python3
"""Run M10.Z offline checks and retain only bounded, structured results."""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = Path("/private/tmp/whippet-m10z-20261114/odd")
OUT.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument("--output", default="offline.json", choices=("offline.json", "final-offline.json"))
args = parser.parse_args()
result_path = OUT / args.output

SAFE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_./-]{0,119}$")


def run(label, cwd, argv, kind="command"):
    clean_env = os.environ.copy()
    for key in tuple(clean_env):
        if key.startswith("WHIPPET_") or key in ("TEST_DATABASE_URL", "DATABASE_URL"):
            clean_env.pop(key, None)
    start = time.perf_counter()
    proc = subprocess.run(argv, cwd=cwd, env=clean_env, capture_output=True, text=True, errors="replace")
    elapsed = round(time.perf_counter() - start, 3)
    result = {"label": label, "command": argv, "exit": proc.returncode, "seconds": elapsed}
    if kind == "go":
        tests = {}
        for line in proc.stdout.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            name, action = item.get("Test"), item.get("Action")
            if isinstance(name, str) and SAFE_NAME.fullmatch(name) and action in ("pass", "fail", "skip"):
                tests[name] = action
        result["tests"] = {"pass": sorted(n for n, a in tests.items() if a == "pass"),
                           "fail": sorted(n for n, a in tests.items() if a == "fail"),
                           "skip": sorted(n for n, a in tests.items() if a == "skip")}
    elif kind == "node":
        counts = {}
        for line in proc.stdout.splitlines():
            match = re.fullmatch(r"# (tests|pass|fail|cancelled|skipped|todo) (\d+)", line.strip())
            if match:
                counts[match.group(1)] = int(match.group(2))
        result["counts"] = counts
        fixed_names = set()
        for source in (ROOT / "runtimes/worker/src").rglob("*.test.ts"):
            body = source.read_text(errors="replace")
            fixed_names.update(re.findall(r"\b(?:test|it)\(\s*['\"]([^'\"\n]{1,160})['\"]", body))
        skipped = []
        failed = []
        for line in proc.stdout.splitlines():
            match = re.match(r"\s*(ok|not ok) \d+ - (.+?)(?: # (SKIP).*)?$", line)
            if match and match.group(2) in fixed_names:
                if match.group(3):
                    skipped.append(match.group(2))
                elif match.group(1) == "not ok":
                    failed.append(match.group(2))
        result["skip_names"] = sorted(set(skipped))
        result["fail_names"] = sorted(set(failed))
    return result


checks = []
for service in ("services/server", "services/manager"):
    cwd = ROOT / service
    short = service.split("/")[-1]
    checks.append(run(f"{short}-build", cwd, ["go", "build", "./..."]))
    checks.append(run(f"{short}-unit", cwd, ["go", "test", "-json", "./..."], "go"))

worker = ROOT / "runtimes/worker"
checks.append(run("worker-typecheck", worker, ["npm", "run", "typecheck"]))
checks.append(run("worker-build", worker, ["npm", "run", "build"]))
if checks[-1]["exit"] == 0:
    files = sorted(str(p.relative_to(worker)) for p in (worker / "dist").rglob("*.test.js"))
    checks.append(run("worker-unit", worker, ["node", "--test", *files], "node"))

web = ROOT / "apps/web"
checks.append(run("web-typecheck", web, ["npm", "run", "typecheck"]))
checks.append(run("web-build", web, ["npm", "run", "build"]))

report = {"scope": "offline-only; no PostgreSQL, Docker, model, or service writes", "checks": checks}
result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(result_path),
                  "checks": [{"label": c["label"], "exit": c["exit"], "seconds": c["seconds"],
                              "counts": c.get("counts"),
                              "fail_names": c.get("fail_names"),
                              "go_pass": len(c.get("tests", {}).get("pass", [])),
                              "go_skip": len(c.get("tests", {}).get("skip", []))}
                             for c in checks]}, ensure_ascii=False))
sys.exit(0 if all(c["exit"] == 0 for c in checks) else 1)
