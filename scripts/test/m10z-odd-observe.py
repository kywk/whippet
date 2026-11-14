#!/usr/bin/env python3
"""Project leader's fixed observation into bounded per-Run M10.Z evidence."""

import argparse
import json
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd" / "run-observations.json"
parser = argparse.ArgumentParser()
parser.add_argument("run_id")
args = parser.parse_args()
source = json.loads((BASE / "observation-latest.json").read_text())
item = next((r for r in source.get("runs", []) if r.get("id") == args.run_id), None)
if item is None:
    raise SystemExit("run_not_in_latest_observation")
allowed = ("id", "attemptId", "kind", "status", "slotReleased", "model", "budget", "skillId",
           "skillVersion", "skills", "registryVersion", "registrySha256", "scriptOrigin",
           "bundleHash", "scriptHash", "createdAt", "startedAt", "finishedAt")
record = {key: item.get(key) for key in allowed if key in item}
record.update(observedAt=source.get("observedAt"),
              containerCount=source.get("containerCount"),
              capacityCounts={key: source.get("counts", {}).get(key)
                              for key in ("active", "occupied", "unreclaimed")})
all_records = json.loads(OUT.read_text()) if OUT.exists() else {}
history = all_records.setdefault(args.run_id, [])
if not history or history[-1] != record:
    history.append(record)
OUT.write_text(json.dumps(all_records, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"runId": args.run_id, "status": record.get("status"),
                  "slotReleased": record.get("slotReleased"),
                  "containerCount": record.get("containerCount"),
                  "result": str(OUT)}, ensure_ascii=False))
