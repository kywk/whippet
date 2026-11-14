#!/usr/bin/env python3
"""Project two Stage author attempts through fixed event/diagnostic allowlists."""

import http.cookiejar
import importlib.util
import json
import os
import re
import ssl
import stat
import subprocess
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
OLD = "0210dcf3-316f-415b-86e0-13051f3e4420"
NEW = "c70331fd-acfa-47f8-87b3-ac23f52c154f"
receipt = json.loads((BASE / "postgres.json").read_text())
if receipt["name"] != "whippet-m10z-20261114-pg":
    raise SystemExit("isolated_pg_mismatch")
registry = json.loads((ROOT / "contracts/tools/registry.json").read_text())
names = [tool["name"] for tool in registry["tools"]]
if not names or not all(re.fullmatch(r"[a-z][a-z0-9_]*", name) for name in names):
    raise SystemExit("registry_names_invalid")
model = r"^author:model:([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)$"
tool = r"^author:tool:([1-9]|1[0-9]|20):(" + "|".join(names) + r"):(started|succeeded|failed|heartbeat)$"
observation = (r"^author:observe:([1-8]):(started|fetchInvoked|headersReceived|bodyParsed|"
               r"responseAccepted|failed|timeoutProviderWait|timeoutBodyWait|cancelled|timeoutToolWait|"
               r"toolCancelled|timeoutOther|feedbackFrameAccepted|feedbackQueued|feedbackIncludedAtFetch|"
               r"toolsIncludedAtFetch|functionCallObserved)$")


def query(sql):
    proc = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                           "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c",
                           "BEGIN TRANSACTION READ ONLY; " + sql + " COMMIT;"],
                          capture_output=True, text=True)
    if proc.returncode:
        raise SystemExit("safe_db_projection_failed")
    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    if len(rows) != 1:
        raise SystemExit("safe_db_row_missing")
    return rows[0]


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("fixed_decoder", ROOT / "services/server/m10_shop_t4t_observe.py")
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)


def sidecar(attempt):
    if not attempt:
        return {"status": "missing"}
    attempt = str(uuid.UUID(attempt))
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
            raise ValueError("unsafe_diagnostic")
        d = decoder.decode_diagnostic(os.read(fd, 4097))
        return {"status": "validated", "schemaVersion": d["schemaVersion"],
                "workerObserved": d["workerObserved"], "worker": d["worker"], "manager": d["manager"]}
    except FileNotFoundError:
        return {"status": "missing"}
    except (ValueError, OSError):
        return {"status": "unsafe_or_invalid"}
    finally:
        for fd in reversed(fds):
            os.close(fd)


environment = json.loads((BASE / "environment.json").read_text())
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=environment["ca"])))
opener.open(urllib.request.Request(environment["api"] + "/api/dev-login", data=b"{}",
                                   headers={"Content-Type": "application/json"})).read()


def public(path):
    with opener.open(environment["api"] + path) as response:
        return json.load(response)


def inspect(run_id):
    run_id = str(uuid.UUID(run_id))
    row = query("SELECT json_build_object('status',status,'slotReleased',slot_released,"
                "'attemptId',attempt_id,'draftRevision',draft_revision,'kind',kind) "
                "FROM runs WHERE id='" + run_id + "'::uuid;")
    sql = f"""WITH events AS (
 SELECT row_number() OVER (ORDER BY created_at,event_id) AS seq,
 regexp_match(message,'{model}') AS model,
 regexp_match(message,'{tool}') AS tool,
 regexp_match(message,'{observation}') AS observation
 FROM run_events WHERE run_id='{run_id}'::uuid
), safe AS (
 SELECT seq,
 CASE WHEN model IS NOT NULL THEN 'model' WHEN tool IS NOT NULL THEN 'tool' ELSE 'observation' END AS kind,
 CASE WHEN model IS NOT NULL THEN model[1]::int WHEN tool IS NOT NULL THEN tool[1]::int ELSE observation[1]::int END AS ordinal,
 CASE WHEN tool IS NOT NULL THEN tool[2] END AS name,
 CASE WHEN model IS NOT NULL THEN model[2] WHEN tool IS NOT NULL THEN tool[3] ELSE observation[2] END AS status
 FROM events WHERE model IS NOT NULL OR tool IS NOT NULL OR observation IS NOT NULL)
 SELECT json_build_object('events',COALESCE((SELECT json_agg(row_to_json(s) ORDER BY seq) FROM safe s),'[]'::json),
 'unmatchedCount',(SELECT count(*) FROM events WHERE model IS NULL AND tool IS NULL AND observation IS NULL));"""
    projected = query(sql)
    events = projected["events"]
    run = public("/api/runs/" + run_id)
    partial = run.get("authorPartial") or {}
    codes = [event["status"] for event in events if event["kind"] == "model"]
    tool_started = [{"ordinal": e["ordinal"], "name": e["name"]} for e in events
                    if e["kind"] == "tool" and e["status"] == "started"]
    tool_succeeded = [{"ordinal": e["ordinal"], "name": e["name"]} for e in events
                      if e["kind"] == "tool" and e["status"] == "succeeded"]
    tool_failed = [{"ordinal": e["ordinal"], "name": e["name"]} for e in events
                   if e["kind"] == "tool" and e["status"] == "failed"]
    stages = ("stage_module_candidate_part", "commit_module_candidate", "update_module_candidate",
              "request_module_validation")
    diag = sidecar(row["attemptId"])
    error = run.get("error") or {}
    code = error.get("code") if isinstance(error, dict) else None
    code = code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code) else "unknown"
    return {"runId": run_id, "status": row["status"], "slotReleased": row["slotReleased"],
            "attemptId": row["attemptId"], "draftRevision": row["draftRevision"],
            "publicErrorCode": code, "partialReason": partial.get("reason"),
            "checkpointPresent": bool(partial.get("checkpoint")),
            "modelSucceededOrdinals": [e["ordinal"] for e in events if e["kind"] == "model" and e["status"] == "succeeded"],
            "modelFailedOrdinals": [e["ordinal"] for e in events if e["kind"] == "model" and e["status"] == "failed"],
            "modelEventStatuses": codes, "toolStarted": tool_started,
            "toolSucceeded": tool_succeeded, "toolFailed": tool_failed,
            "candidateToolCounts": {name: sum(item["name"] == name for item in tool_started) for name in stages},
            "unmatchedEventCount": projected["unmatchedCount"], "diagnostic": diag}


old, new = inspect(OLD), inspect(NEW)
state = json.loads((OUT / "driver-state.json").read_text())
plan = public("/api/tests/" + state["usecaseTestId"] + "/plan?" +
              urllib.parse.urlencode({"editingSessionId": state["usecaseSessionId"]}))["plan"]
stages = [{"id": s["id"], "status": s["status"], "candidatePresent": bool(s.get("candidateVersionId")),
           "validationPresent": bool(s.get("validationRunId")), "authorRunId": s.get("authorRunId")}
          for s in plan["stages"]]
result = {"old": old, "fix3Retry": new,
          "plan": {"status": plan["status"], "revision": plan["revision"],
                   "usecaseValidationPresent": bool(plan.get("validationRunId")), "stages": stages},
          "pin": {"workerImage": json.loads((BASE / "admission.json").read_text())["workerImage"],
                  "retryBodySha256": state["queryRetryPrepared"]["bodySha256"]},
          "blocked": {"compose": True, "summary": True, "publish": True, "formal": True},
          "sourceLines": {"engineBudgetWarning": "runtimes/worker/src/author/engine.ts:88",
                          "engineModelLoop": "runtimes/worker/src/author/engine.ts:85",
                          "serverGenericFailure": "services/server/internal/server/author.go:16"},
          "limitations": ["Fixed event grammar only; unmatched events counted", "No author artifact, candidate content, free log, or dialogue read"]}
path = OUT / "stage2-fix3-safe-diagnosis.json"
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(path), "oldModelSucceeded": len(old["modelSucceededOrdinals"]),
                  "newModelSucceeded": len(new["modelSucceededOrdinals"]),
                  "oldCandidateToolCounts": old["candidateToolCounts"],
                  "newCandidateToolCounts": new["candidateToolCounts"],
                  "oldDiagnosticStatus": old["diagnostic"]["status"],
                  "newDiagnosticStatus": new["diagnostic"]["status"],
                  "planStatus": plan["status"], "stage3Status": stages[2]["status"]}, ensure_ascii=False))
