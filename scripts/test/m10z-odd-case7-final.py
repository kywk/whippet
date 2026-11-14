#!/usr/bin/env python3
"""Compare three formal partial/continue Runs through bounded metadata only."""

import http.cookiejar
import json
import ssl
import subprocess
import uuid
import urllib.request
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
state = json.loads((OUT / "driver-state.json").read_text())
environment = json.loads((BASE / "environment.json").read_text())
receipt = json.loads((BASE / "postgres.json").read_text())
observations = json.loads((OUT / "run-observations.json").read_text())
events = json.loads((OUT / "case7-safe-events-three-runs.json").read_text())
if receipt["name"] != "whippet-m10z-20261114-pg":
    raise SystemExit("isolated_pg_mismatch")
ids = [state["partialSourceRunId"], state["partialContinueRunId"], state["partialSecondContinueRunId"]]
ids = [str(uuid.UUID(item)) for item in ids]
sql_ids = ",".join("'" + item + "'::uuid" for item in ids)
sql = ("BEGIN TRANSACTION READ ONLY; SELECT json_build_object('id',id,'status',status,"
       "'slotReleased',slot_released,'draftRevision',draft_revision,'kind',kind) "
       "FROM runs WHERE id IN (" + sql_ids + "); COMMIT;")
proc = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                       "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                      capture_output=True, text=True)
if proc.returncode:
    raise SystemExit("safe_run_projection_failed")
rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
if len(rows) != 3:
    raise SystemExit("run_rows_missing")
db = {row["id"]: row for row in rows}
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=environment["ca"])))
opener.open(urllib.request.Request(environment["api"] + "/api/dev-login", data=b"{}",
                                   headers={"Content-Type": "application/json"})).read()


def get(path):
    with opener.open(environment["api"] + path) as response:
        return json.load(response)


items = []
for label, run_id in zip(("source", "continue", "fix3Continue"), ids):
    run = get("/api/runs/" + run_id)
    partial = run.get("authorPartial") or {}
    pins = next((item for item in observations.get(run_id, []) if item.get("model") and item.get("budget")), None)
    if pins is None:
        raise SystemExit("pin_observation_missing")
    safe_events = events[label]
    items.append({"label": label, "runId": run_id, "status": db[run_id]["status"],
                  "slotReleased": db[run_id]["slotReleased"], "draftRevision": db[run_id]["draftRevision"],
                  "partial": bool(partial), "partialReason": partial.get("reason"),
                  "checkpointPresent": bool(partial.get("checkpoint")),
                  "nextStepPresent": bool(partial.get("nextStep")),
                  "appliedRevision": partial.get("appliedRevision"),
                  "reportReady": bool(run.get("reportUrl")),
                  "model": pins["model"], "budget": pins["budget"],
                  "skills": [{"id": skill.get("id"), "version": skill.get("version"),
                              "sha256": skill.get("sha256")} for skill in pins.get("skills", [])],
                  "registryVersion": pins.get("registryVersion"),
                  "registrySha256": pins.get("registrySha256"),
                  "modelSucceededCount": len(safe_events["modelSucceededOrdinals"]),
                  "updateDraftCallCount": safe_events["updateDraftCallCount"],
                  "toolNames": [tool["name"] for tool in safe_events["toolStarted"]],
                  "unmatchedEventCount": safe_events["unmatchedEventCount"]})
session = get("/api/tests/" + state["partialTestId"] + "/editing-session")["session"]
result = {"runs": items,
          "sameModel": all(item["model"] == items[0]["model"] for item in items),
          "sameBudget": all(item["budget"] == items[0]["budget"] for item in items),
          "sameRegistry": all(item["registrySha256"] == items[0]["registrySha256"] for item in items),
          "fix3TestAuthorSkillChanged": items[2]["skills"][0]["sha256"] != items[0]["skills"][0]["sha256"],
          "session": {"status": session["status"], "draftRevision": session["draft"]["revision"],
                      "pendingRunCount": len(session["pendingRunIds"]),
                      "reclaimPending": session["reclaimPending"]},
          "formalValidationStarted": False,
          "taskCompleted": False,
          "limitations": ["Transport succeeded on all Runs but each author result remained partial",
                          "No candidate or formal validation; no free log or dialogue read"]}
path = OUT / "case7-three-run-evidence.json"
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(path), "statuses": [item["status"] for item in items],
                  "partial": [item["partial"] for item in items],
                  "checkpoints": [item["checkpointPresent"] for item in items],
                  "sameModel": result["sameModel"], "sameBudget": result["sameBudget"],
                  "taskCompleted": result["taskCompleted"]}, ensure_ascii=False))
