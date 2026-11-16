#!/usr/bin/env python3
"""Recheck the eight fixed Worker failures after fix3 without overwriting baseline."""

import json
import re
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "runtimes/worker"
OUT = Path("/private/tmp/whippet-m10z-20261114/odd")
BASELINE = json.loads((OUT / "worker-regression.json").read_text())["failures"]
TARGETS = {item["test"]: item["file"] for item in BASELINE}
FILES = sorted({Path(item["file"]).name.removesuffix(".test.js") for item in BASELINE})
results = []
groups = []
for stem in FILES:
    source = (WORKER / "src/author" / f"{stem}.test.ts").read_text()
    exact = [name for name, path in TARGETS.items() if path == f"author/{stem}.test.js"]
    pattern = "^(?:" + "|".join(re.escape(name) for name in exact) + ")$"
    cmd = ["node", "--test", "--test-name-pattern=" + pattern, f"dist/author/{stem}.test.js"]
    start = time.perf_counter()
    proc = subprocess.run(cmd, cwd=WORKER, capture_output=True, text=True, errors="replace")
    lines = proc.stdout.splitlines()
    elapsed = round(time.perf_counter() - start, 3)
    seen = set()
    groups.append({"file": f"author/{stem}.test.js", "exit": proc.returncode, "seconds": elapsed})
    for i, line in enumerate(lines):
        match = re.match(r"\s*(not )?ok \d+ - (.+?)(?: # .*)?$", line)
        if not match or match.group(2) not in TARGETS or TARGETS[match.group(2)] != f"author/{stem}.test.js":
            continue
        test_name = match.group(2)
        seen.add(test_name)
        next_i = next((j for j in range(i+1, len(lines)) if re.match(r"\s*(?:not )?ok \d+ - ", lines[j])), len(lines))
        block = "\n".join(lines[i:next_i]).lower()
        status = "fail" if match.group(1) else "skip" if "# skip" in line else "pass"
        error = ("author_error" if "authorerror" in block else
                 "assertion" if "assertionerror" in block or "err_assertion" in block else
                 "type_error" if "typeerror" in block else
                 "other_fixed_failure") if status == "fail" else None
        results.append({"file": f"author/{stem}.test.js", "test": test_name,
                        "sourceLine": source[:source.find(test_name)].count("\n")+1,
                        "status": status, "failureEnum": error,
                        "fileExit": proc.returncode, "fileSeconds": elapsed})
    for test_name, path in TARGETS.items():
        if path == f"author/{stem}.test.js" and test_name not in seen:
            results.append({"file": path, "test": test_name, "status": "missing", "failureEnum": "not_observed",
                            "fileExit": proc.returncode, "fileSeconds": elapsed})
result_path = OUT / "worker-regression-after-fix3.json"
result_path.write_text(json.dumps({"targetCount": len(TARGETS), "groups": groups, "tests": results,
                                   "allEightPass": len(results) == 8 and all(x["status"] == "pass" for x in results),
                                   "allGroupsExitZero": all(x["exit"] == 0 for x in groups)},
                                  ensure_ascii=False, indent=2)+"\n")
print(json.dumps({"result": str(result_path), "targetCount": len(TARGETS),
                  "allEightPass": len(results) == 8 and all(x["status"] == "pass" for x in results),
                  "allGroupsExitZero": all(x["exit"] == 0 for x in groups)}, ensure_ascii=False))
