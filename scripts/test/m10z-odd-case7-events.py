#!/usr/bin/env python3
"""Capture only fixed model/tool event grammar for the two true partial Runs."""

import json
import re
import subprocess
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
state = json.loads((OUT / "driver-state.json").read_text())
receipt = json.loads((BASE / "postgres.json").read_text())
registry = json.loads((ROOT / "contracts/tools/registry.json").read_text())
names = [item["name"] for item in registry["tools"]]
if not names or not all(re.fullmatch(r"[a-z][a-z0-9_]*", x) for x in names):
    raise SystemExit("registry_tool_names_invalid")
model = r"^author:model:([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)$"
tool = r"^author:tool:([1-9]|1[0-9]|20):(" + "|".join(names) + r"):(started|succeeded|failed|heartbeat)$"
observation = (r"^author:observe:([1-8]):(started|fetchInvoked|headersReceived|bodyParsed|"
               r"responseAccepted|failed|timeoutProviderWait|timeoutBodyWait|cancelled|timeoutToolWait|"
               r"toolCancelled|timeoutOther|feedbackFrameAccepted|feedbackQueued|feedbackIncludedAtFetch|"
               r"toolsIncludedAtFetch|functionCallObserved)$")


def inspect(run):
    run = str(uuid.UUID(run))
    sql = f"""BEGIN TRANSACTION READ ONLY;
WITH events AS (
 SELECT row_number() OVER (ORDER BY created_at,event_id) AS seq,
 regexp_match(message,'{model}') AS model,
 regexp_match(message,'{tool}') AS tool,
 regexp_match(message,'{observation}') AS observation
 FROM run_events WHERE run_id='{run}'::uuid
), safe AS (
 SELECT seq,
 CASE WHEN model IS NOT NULL THEN 'model' WHEN tool IS NOT NULL THEN 'tool' ELSE 'observation' END AS kind,
 CASE WHEN model IS NOT NULL THEN model[1]::int WHEN tool IS NOT NULL THEN tool[1]::int ELSE observation[1]::int END AS ordinal,
 CASE WHEN tool IS NOT NULL THEN tool[2] END AS tool_name,
 CASE WHEN model IS NOT NULL THEN model[2] WHEN tool IS NOT NULL THEN tool[3] ELSE observation[2] END AS status
 FROM events WHERE model IS NOT NULL OR tool IS NOT NULL OR observation IS NOT NULL)
SELECT json_build_object('events',COALESCE((SELECT json_agg(row_to_json(s) ORDER BY seq) FROM safe s),'[]'::json),
 'unmatchedCount',(SELECT count(*) FROM events WHERE model IS NULL AND tool IS NULL AND observation IS NULL));
COMMIT;"""
    proc = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                           "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                          capture_output=True, text=True)
    if proc.returncode:
        raise SystemExit("fixed_event_query_failed")
    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    if len(rows) != 1:
        raise SystemExit("fixed_event_row_missing")
    result = rows[0]
    events = result["events"]
    model_success = [e["ordinal"] for e in events if e["kind"] == "model" and e["status"] == "succeeded"]
    tool_started = [{"ordinal": e["ordinal"], "name": e["tool_name"]} for e in events
                    if e["kind"] == "tool" and e["status"] == "started"]
    tool_success = [{"ordinal": e["ordinal"], "name": e["tool_name"]} for e in events
                    if e["kind"] == "tool" and e["status"] == "succeeded"]
    update_calls = sum(x["name"] == "update_draft" for x in tool_started)
    model7 = next((e["seq"] for e in events if e["kind"] == "model" and
                   e["ordinal"] == 7 and e["status"] == "started"), None)
    tools_before_7 = sum(e["kind"] == "tool" and e["status"] == "started" and
                         e["seq"] < model7 for e in events) if model7 is not None else None
    warning_7 = (12 - tools_before_7 <= 2) if tools_before_7 is not None else None
    return {"runId": run, "modelSucceededOrdinals": model_success,
            "toolStarted": tool_started, "toolSucceeded": tool_success,
            "updateDraftCallCount": update_calls,
            "selfTestCountTrusted": None,
            "selfTestEvidenceAvailable": False,
            "toolsBeforeRequest7": tools_before_7,
            "request7BudgetWarningExpectedByEngineCode": warning_7,
            "request8BudgetWarningExpectedByEngineCode": len(model_success) >= 8,
            "budgetWarningCodeLine": "runtimes/worker/src/author/engine.ts:88",
            "lastRequestBudgetWarningObserved": None,
            "unmatchedEventCount": result["unmatchedCount"]}


out = {"registryVersion": registry["version"],
       "source": inspect(state["partialSourceRunId"]),
       "continue": inspect(state["partialContinueRunId"]),
       "fix3Continue": inspect(state["partialSecondContinueRunId"]),
       "limitations": ["Only fixed event grammar, unmatched messages counted",
                       "No v3 sidecar: self-test count and actual provider warning are not observable",
                       "Engine code injects warning on request 8 of 8 or when remaining tools <= 2; provider receipt cannot be proved"]}
(OUT / "case7-safe-events-three-runs.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "case7-safe-events-three-runs.json"),
                  "sourceModelSucceeded": len(out["source"]["modelSucceededOrdinals"]),
                  "continueModelSucceeded": len(out["continue"]["modelSucceededOrdinals"]),
                  "fix3ContinueModelSucceeded": len(out["fix3Continue"]["modelSucceededOrdinals"]),
                  "sourceUpdateDraftCalls": out["source"]["updateDraftCallCount"],
                  "continueUpdateDraftCalls": out["continue"]["updateDraftCallCount"],
                  "fix3ContinueUpdateDraftCalls": out["fix3Continue"]["updateDraftCallCount"],
                  "sourceTools": [x["name"] for x in out["source"]["toolStarted"]],
                  "continueTools": [x["name"] for x in out["continue"]["toolStarted"]],
                  "fix3ContinueTools": [x["name"] for x in out["fix3Continue"]["toolStarted"]]}, ensure_ascii=False))
