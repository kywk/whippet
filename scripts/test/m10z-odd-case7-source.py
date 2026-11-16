#!/usr/bin/env python3
"""Pin the true builtin partial source and its exact continue CAS without content."""

import http.cookiejar
import json
import ssl
import subprocess
import urllib.request
import uuid
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
state = json.loads((OUT / "driver-state.json").read_text())
environment = json.loads((BASE / "environment.json").read_text())
receipt = json.loads((BASE / "postgres.json").read_text())
run_id = str(uuid.UUID(state["partialSourceRunId"]))
test_id = str(uuid.UUID(state["partialTestId"]))
session_id = str(uuid.UUID(state["partialSessionId"]))
sql = f"""BEGIN TRANSACTION READ ONLY;
SELECT json_build_object('status',status,'slotReleased',slot_released,'attemptId',attempt_id,
 'draftRevision',draft_revision,'kind',kind,'testMatches',test_id='{test_id}'::uuid,
 'sessionMatches',editing_session_id='{session_id}'::uuid)
FROM runs WHERE id='{run_id}'::uuid;
COMMIT;"""
db = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                     "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                    capture_output=True, text=True)
if db.returncode:
    raise SystemExit("safe_source_query_failed")
rows = [json.loads(line) for line in db.stdout.splitlines() if line.startswith("{")]
if len(rows) != 1:
    raise SystemExit("source_row_missing")
row = rows[0]

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=environment["ca"])))
opener.open(urllib.request.Request(environment["api"] + "/api/dev-login", data=b"{}",
                                   headers={"Content-Type": "application/json"})).read()
with opener.open(environment["api"] + "/api/runs/" + run_id) as response:
    public = json.load(response)
with opener.open(environment["api"] + "/api/tests/" + test_id + "/editing-session") as response:
    session = json.load(response)["session"]
partial = public.get("authorPartial") or {}
revision = partial.get("appliedRevision") if partial.get("appliedRevision") is not None else public.get("draftRevision")
pins = json.loads((OUT / "run-observations.json").read_text()).get(run_id, [])
source_pin = next((x for x in pins if x.get("model") and x.get("budget")), None)
intents = [json.loads(line) for line in (OUT / "driver-events.jsonl").read_text().splitlines()]
message_path = "/api/tests/" + test_id + "/messages"
intent_count = sum(x.get("event") == "request_intent" and x.get("method") == "POST" and
                   x.get("path") == message_path for x in intents)
result = {"runId": run_id, "database": row,
          "partial": {"reason": partial.get("reason"), "checkpointPresent": bool(partial.get("checkpoint")),
                      "nextStepPresent": bool(partial.get("nextStep")),
                      "appliedRevision": partial.get("appliedRevision"),
                      "continueRevision": revision},
          "session": {"active": session["status"] == "active", "pendingRunCount": len(session["pendingRunIds"]),
                      "reclaimPending": session["reclaimPending"],
                      "draftRevision": session["draft"]["revision"]},
          "sourceMessagePostIntentCount": intent_count,
          "pins": {key: source_pin.get(key) for key in ("model", "budget", "skillId", "skillVersion", "skills",
                                                        "registryVersion", "registrySha256") if source_pin and key in source_pin},
          "continueCommand": ["python3", "scripts/test/m10z-odd-driver.py", "case7-continue"],
          "readyToContinue": row["status"] == "succeeded" and row["slotReleased"] is True and
                             partial.get("reason") == "budget_exhausted" and bool(partial.get("nextStep")) and
                             session["status"] == "active" and not session["pendingRunIds"] and
                             not session["reclaimPending"] and revision == session["draft"]["revision"] and
                             intent_count == 1,
          "limitations": ["True model partial; continued Run not yet started", "No dialog, artifact or free log read"]}
(OUT / "case7-source-evidence.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "case7-source-evidence.json"),
                  "readyToContinue": result["readyToContinue"],
                  "slotReleased": row["slotReleased"], "continueRevision": revision}, ensure_ascii=False))
