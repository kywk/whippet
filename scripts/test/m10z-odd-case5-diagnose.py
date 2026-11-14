#!/usr/bin/env python3
"""Project case5 summary gates as booleans; never return scripts or logs."""

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
pg = json.loads((BASE / "postgres.json").read_text())
plan = str(uuid.UUID(state["case5PlanId"]))
summary = str(uuid.UUID(state["case5ValidationRunId"]))
query = f"""BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
 'planComposed',p.status='composed',
 'planRevisionMatchesRequest',p.revision={int(state['case5PlanRevision'])},
 'baseRevisionMatchesDraft',p.base_revision=d.current_revision,
 'contextRevisionMatchesSession',p.context_revision=s.context_revision,
 'validationIdMatchesDraft',p.validation_run_id=d.validation_run_id,
 'validationIdMatchesRequest',p.validation_run_id='{summary}'::uuid,
 'validationSucceeded',r.status='succeeded',
 'validationSlotReleased',r.slot_released,
 'validationReportRowExists',EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html'),
 'validationResultsRowExists',EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='results.json'),
 'singleReadyReuseStage',jsonb_array_length(p.stages)=1 AND p.stages->0->>'action'='reuse' AND p.stages->0->>'status'='ready',
 'reusedVersionExists',EXISTS(SELECT 1 FROM test_versions v WHERE v.id=(p.stages->0->>'moduleVersionId')::uuid),
 'reusedValidationSucceededAndReleased',EXISTS(SELECT 1 FROM test_versions v JOIN runs vr ON vr.id=v.validation_run_id WHERE v.id=(p.stages->0->>'moduleVersionId')::uuid AND vr.status='succeeded' AND vr.slot_released),
 'activeAuthorInSession',EXISTS(SELECT 1 FROM runs ar WHERE ar.editing_session_id=s.id AND ar.kind='author' AND (ar.status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT ar.slot_released))
)
FROM plans p JOIN drafts d ON d.test_id=p.test_id JOIN editing_sessions s ON s.id=p.editing_session_id JOIN runs r ON r.id=p.validation_run_id
WHERE p.id='{plan}'::uuid;
COMMIT;"""
result = subprocess.run(["docker", "exec", pg["name"], "psql", "-X", "-U", "postgres", "-d", "postgres",
                         "-At", "-v", "ON_ERROR_STOP=1", "-c", query], capture_output=True, text=True)
if result.returncode:
    raise SystemExit("safe_case5_query_failed")
records = [json.loads(x) for x in result.stdout.splitlines() if x.startswith("{")]
if len(records) != 1 or not all(isinstance(x, bool) for x in records[0].values()):
    raise SystemExit("safe_case5_projection_invalid")
conditions = records[0]

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=environment["ca"])))
opener.open(urllib.request.Request(environment["api"] + "/api/dev-login", data=b"{}",
                                   headers={"Content-Type": "application/json"})).read()
with opener.open(environment["api"] + "/api/runs/" + summary + "/artifacts/results.json") as response:
    report = json.load(response)
stats = report.get("stats")
conditions["resultsStatsShapeValid"] = isinstance(stats, dict) and all(
    isinstance(stats.get(key), (int, float)) for key in ("expected", "unexpected", "flaky", "skipped", "duration"))
conditions["resultsErrorsPresentEmpty"] = report.get("errors") == []
conditions["resultsExpectedPositive"] = isinstance(stats, dict) and isinstance(stats.get("expected"), int) and stats["expected"] > 0
conditions["resultsUnexpectedZero"] = isinstance(stats, dict) and stats.get("unexpected") == 0
conditions["resultsFlakyNonnegative"] = isinstance(stats, dict) and isinstance(stats.get("flaky"), int) and stats["flaky"] >= 0
conditions["resultsSkippedNonnegative"] = isinstance(stats, dict) and isinstance(stats.get("skipped"), int) and stats["skipped"] >= 0
conditions["resultsDurationNonnegative"] = isinstance(stats, dict) and isinstance(stats.get("duration"), (int, float)) and stats["duration"] >= 0
out = {"planId": plan, "validationRunId": summary, "conditions": conditions,
       "summaryPostOnceStatus": 409, "summaryPostCode": "conflict",
       "classification": "api_contract_or_hidden_batch_gate_pending_owner_review",
       "limitations": ["No model or summary retry", "Only fixed booleans and public result stats checked"]}
(OUT / "case5-summary-diagnosis.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "case5-summary-diagnosis.json"),
                  "falseConditions": sorted(k for k, value in conditions.items() if value is False)}, ensure_ascii=False))
