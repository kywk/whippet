#!/usr/bin/env python3
"""Bounded zero-model replay QA; never prints Go output or WS data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
MANAGER = ROOT / "services/manager"
SOURCE = ROOT / "scripts/test/m10z-w3-even-replay_test.go"
W = Path("/private/tmp/whippet-m10z-20261115-wave3/even")
W.mkdir(parents=True, exist_ok=True)
OVERLAY = W / "replay-overlay.json"
OVERLAY.write_text(json.dumps({"Replace": {str(MANAGER / "internal/manager/m10z_w3_even_replay_test.go"): str(SOURCE)}}))

start = time.monotonic()
env = os.environ.copy()
env["GOCACHE"] = str(W / "go-cache")
cmd = ["go", "test", "-json", "-overlay", str(OVERLAY), "./internal/manager", "-run", "^TestM10ZW3EvenReconnectReplay$", "-count=1", "-timeout=30s"]
try:
    p = subprocess.run(cmd, cwd=MANAGER, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    actions = []
    for line in p.stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("Test") == "TestM10ZW3EvenReconnectReplay" and item.get("Action") in ("pass", "fail", "skip"):
            actions.append(item["Action"])
    outcome = "PASS" if p.returncode == 0 and actions == ["pass"] else "FAIL"
    exit_code = p.returncode
except subprocess.TimeoutExpired:
    outcome, exit_code, actions = "TIMEOUT", -1, []

report = {
    "schemaVersion": 1,
    "kind": "M10Z_W3_EVEN_FAKE_WS_REPLAY",
    "outcome": outcome,
    "exitCode": exit_code,
    "passCount": actions.count("pass"),
    "failCount": actions.count("fail"),
    "skipCount": actions.count("skip"),
    "durationMs": round((time.monotonic() - start) * 1000),
    "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "modelCalls": 0,
    "dockerCalls": 0,
    "dbCalls": 0,
}
(W / "replay.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps(report, sort_keys=True))
sys.exit(0 if outcome == "PASS" else 1)
