#!/usr/bin/env python3
"""Recheck fixed failing Worker files without persisting test output."""

import json
import re
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "runtimes/worker"
OUT = Path("/private/tmp/whippet-m10z-20261114/odd")
FILES = ["author/schema.test.js", "author/history.test.js", "author/partial.test.js",
         "author/m7.test.js", "author/m8.test.js", "author/m8b.test.js",
         "author/engine.test.js", "author/timeout.test.js"]
results = []
for file in FILES:
    body = (WORKER / "src" / file.replace(".js", ".ts")).read_text()
    fixed = set(re.findall(r"\b(?:test|it)\(\s*['\"]([^'\"\n]{1,160})['\"]", body))
    args = ["node", "--test", "dist/" + file]
    start = time.perf_counter()
    proc = subprocess.run(args, cwd=WORKER, capture_output=True, text=True, errors="replace")
    counts = {}
    fails = []
    for line in proc.stdout.splitlines():
        match = re.fullmatch(r"# (tests|pass|fail|cancelled|skipped|todo) (\d+)", line.strip())
        if match:
            counts[match.group(1)] = int(match.group(2))
        match = re.match(r"\s*not ok \d+ - (.+?)(?: # .*)?$", line)
        if match and match.group(1) in fixed:
            fails.append(match.group(1))
    results.append({"file": file, "command": args, "exit": proc.returncode,
                    "seconds": round(time.perf_counter() - start, 3),
                    "counts": counts, "fail_names": fails})
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "worker-focus.json").write_text(json.dumps({"checks": results}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "worker-focus.json"), "checks": results}, ensure_ascii=False))
sys.exit(0 if all(c["exit"] == 0 for c in results) else 1)
