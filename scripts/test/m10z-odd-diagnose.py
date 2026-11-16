#!/usr/bin/env python3
"""Read fixed M10.Z event grammar and a validated v3 sidecar; no free logs."""

import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
RUN = "0210dcf3-316f-415b-86e0-13051f3e4420"
obs = json.loads((BASE / "observation-latest.json").read_text())
row = next((x for x in obs.get("runs", []) if x.get("id") == RUN), None)
if not row:
    raise SystemExit("run_missing_from_safe_observation")
attempt = str(uuid.UUID(row["attemptId"]))

spec = importlib.util.spec_from_file_location("old_safe_decoder", ROOT / "services/server/m10_shop_t4t_observe.py")
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)


def sidecar():
    fds = []
    try:
        fd = os.open("/private/tmp", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        for part in ("whippet-m10z-20261114", "work", "diagnostics"):
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fds.append(fd)
        fd = os.open(attempt + ".json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        fds.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
            raise ValueError("invalid_size_or_type")
        record = decoder.decode_diagnostic(os.read(fd, 4097))
        return {"status": "validated", "value": record}
    except FileNotFoundError:
        return {"status": "missing"}
    except (ValueError, OSError):
        return {"status": "unsafe_or_invalid"}
    finally:
        for fd in reversed(fds):
            os.close(fd)


registry = json.loads((ROOT / "contracts/tools/registry.json").read_text())
tools = [t["name"] for t in registry["tools"]]
if not tools or not all(re.fullmatch(r"[a-z][a-z0-9_]*", name) for name in tools):
    raise SystemExit("registry_names_invalid")
model = r"^author:model:([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)$"
observation = (r"^author:observe:([1-8]):(started|fetchInvoked|headersReceived|bodyParsed|"
               r"responseAccepted|failed|timeoutProviderWait|timeoutBodyWait|cancelled|timeoutToolWait|"
               r"toolCancelled|timeoutOther|feedbackFrameAccepted|feedbackQueued|feedbackIncludedAtFetch|"
               r"toolsIncludedAtFetch|functionCallObserved)$")
tool = r"^author:tool:([1-9]|1[0-9]|20):(" + "|".join(tools) + r"):(started|succeeded|failed|heartbeat)$"
sql = f"""BEGIN TRANSACTION READ ONLY;
WITH events AS (
 SELECT row_number() OVER (ORDER BY created_at,event_id) AS seq,
 regexp_match(message,'{model}') AS model,
 regexp_match(message,'{tool}') AS tool,
 regexp_match(message,'{observation}') AS observation
 FROM run_events WHERE run_id='{RUN}'
), safe AS (
 SELECT seq,
 CASE WHEN model IS NOT NULL THEN 'model' WHEN tool IS NOT NULL THEN 'tool' ELSE 'observation' END AS event_kind,
 CASE WHEN model IS NOT NULL THEN model[1]::int WHEN tool IS NOT NULL THEN tool[1]::int ELSE observation[1]::int END AS ordinal,
 CASE WHEN tool IS NOT NULL THEN tool[2] END AS tool_name,
 CASE WHEN model IS NOT NULL THEN model[2] WHEN tool IS NOT NULL THEN tool[3] ELSE observation[2] END AS status
 FROM events WHERE model IS NOT NULL OR tool IS NOT NULL OR observation IS NOT NULL)
SELECT json_build_object('events',COALESCE((SELECT json_agg(row_to_json(s) ORDER BY seq) FROM safe s),'[]'::json),
 'unknownEventCount',(SELECT count(*) FROM events WHERE model IS NULL AND tool IS NULL AND observation IS NULL));
COMMIT;"""
receipt = json.loads((BASE / "postgres.json").read_text())
if receipt.get("name") != "whippet-m10z-20261114-pg":
    raise SystemExit("pg_container_mismatch")
result = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                         "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                        capture_output=True, text=True)
if result.returncode:
    raise SystemExit("safe_event_query_failed")
records = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
if len(records) != 1:
    raise SystemExit("safe_event_projection_missing")
events = records[0]
diagnostic = sidecar()
classification = "unknown"
if diagnostic["status"] == "validated":
    worker = diagnostic["value"]["worker"]
    manager = diagnostic["value"]["manager"]
    if worker["terminalClass"] == "TIMEOUT":
        classification = "worker_timeout"
    elif worker["modelRequestFailureStage"] != "UNKNOWN":
        classification = "model_request_" + worker["modelRequestFailureStage"].lower()
    elif manager["disposition"] == "AUTHOR_REJECTED":
        classification = "author_artifact_rejected"
    else:
        classification = "validated_other"
elif events["events"]:
    classification = "events_only_sidecar_missing"
out = {"runId": RUN, "attemptId": attempt, "runStatus": row["status"],
       "slotReleased": row["slotReleased"], "capacityCounts": obs["counts"],
       "containerCount": obs["containerCount"], "registryVersion": registry["version"],
       "diagnostic": diagnostic, "safeEvents": events, "classification": classification,
       "limitations": ["Unmatched events counted only", "Missing sidecar cannot establish provider root cause",
                       "No author artifact or free logs read"]}
(OUT / "stage2-diagnosis.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "stage2-diagnosis.json"), "classification": classification,
                  "sidecar": diagnostic["status"], "safeEventCount": len(events["events"]),
                  "unknownEventCount": events["unknownEventCount"],
                  "slotReleased": row["slotReleased"], "capacityCounts": obs["counts"]}, ensure_ascii=False))
