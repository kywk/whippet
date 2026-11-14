#!/usr/bin/env python3
"""Single bounded Manager overlay for v4 decoder and fake TLS/WS replay."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "services/manager"
W = Path("/private/tmp/whippet-m10z-20261115-wave3/even")
W.mkdir(parents=True, exist_ok=True)
sources = {
    "replay": ROOT / "scripts/test/m10z-w3-even-replay_test.go",
    "decoder": ROOT / "scripts/test/m10z-w3-even-v4_test.go",
}
product_sources = {
    "manager": MANAGER / "internal/manager/manager.go",
    "decoder": MANAGER / "internal/manager/module_diagnostics.go",
    "transport": MANAGER / "internal/manager/manager_transport_diagnostics.go",
}
samples = Path("/private/tmp/whippet-m10z-20261115-wave3/odd/payload-samples.json")
overlay = W / "final-overlay.json"
overlay.write_text(json.dumps({"Replace": {
    str(MANAGER / "internal/manager/m10z_w3_even_replay_test.go"): str(sources["replay"]),
    str(MANAGER / "internal/manager/m10z_w3_even_v4_test.go"): str(sources["decoder"]),
}}))

start = time.monotonic()
env = os.environ.copy()
env["GOCACHE"] = str(W / "go-cache")
cmd = ["go", "test", "-json", "-overlay", str(overlay), "./internal/manager", "-run", "^TestM10ZW3Even", "-count=1", "-timeout=35s"]
try:
    p = subprocess.run(cmd, cwd=MANAGER, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    actions = []
    for line in p.stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("Test", "").startswith("TestM10ZW3Even") and item.get("Action") in ("pass", "fail", "skip"):
            actions.append(item["Action"])
    outcome = "PASS" if p.returncode == 0 and actions.count("pass") == 4 and actions.count("fail") == 0 else "FAIL"
    exit_code = p.returncode
except subprocess.TimeoutExpired:
    outcome, exit_code, actions = "TIMEOUT", -1, []

report = {
    "schemaVersion": 1,
    "kind": "M10Z_W3_EVEN_FINAL_OVERLAY",
    "outcome": outcome,
    "exitCode": exit_code,
    "passCount": actions.count("pass"),
    "failCount": actions.count("fail"),
    "skipCount": actions.count("skip"),
    "durationMs": round((time.monotonic() - start) * 1000),
    "sourceSha256": {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in sources.items()},
    "productSourceSha256": {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in product_sources.items()},
    "producerSamplesSha256": hashlib.sha256(samples.read_bytes()).hexdigest(),
    "producerSampleCount": 6,
    "modelCalls": 0,
    "dockerCalls": 0,
    "dbCalls": 0,
}
(W / "final.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps(report, sort_keys=True))
sys.exit(0 if outcome == "PASS" else 1)
