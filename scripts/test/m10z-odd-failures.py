#!/usr/bin/env python3
"""Reproduce only known failures and retain fixed diagnostics, never test output."""

import json
import os
import re
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = Path("/private/tmp/whippet-m10z-20261114/odd")
RECEIPT = json.loads((OUT.parent / "postgres.json").read_text())
PG_TESTS = [
    "TestM10PostgresModuleCatalogAndDependencies", "TestM10PostgresUpgradeFromM9",
    "TestM7EditingLifecycle", "TestM8WorkspaceSliceA", "TestM9HistoryOwnersAndCutoff",
    "TestM9HistoryRealHandlerCancelledFixture", "TestM9WorkspaceHistoryAndLegacyDenial",
    "TestPostgresEvidenceArtifacts", "TestPostgresQueueAndAttemptInvariants",
    "TestPostgresWorkspaceSettingsSnapshots",
]
WORKER_FILES = ["author/schema.test.js", "author/history.test.js", "author/partial.test.js"]
PG_GROUP = {
    "TestM10PostgresModuleCatalogAndDependencies": "pg_cross_workspace_rejection",
    "TestM10PostgresUpgradeFromM9": "pg_historical_migration_count",
    "TestM7EditingLifecycle": "pg_legacy_read_invariant",
    "TestM8WorkspaceSliceA": "pg_workspace_defaults",
    "TestM9HistoryOwnersAndCutoff": "pg_history_contract",
    "TestM9HistoryRealHandlerCancelledFixture": "pg_history_contract",
    "TestM9WorkspaceHistoryAndLegacyDenial": "pg_history_contract",
    "TestPostgresEvidenceArtifacts": "pg_create_run",
    "TestPostgresQueueAndAttemptInvariants": "pg_create_run",
    "TestPostgresWorkspaceSettingsSnapshots": "pg_workspace_snapshot_subtest",
}
WORKER_GROUP = {"author/schema.test.js": "worker_registry_version_fixture",
                "author/history.test.js": "worker_history_call_id",
                "author/partial.test.js": "worker_partial_contract"}
SAFE_TEST = re.compile(r"^[A-Za-z][A-Za-z0-9_./-]{0,119}$")
SOURCE = re.compile(r"\b([A-Za-z0-9_]+_test\.go):(\d+):")


def clean_env(pg=False):
    result = os.environ.copy()
    for key in tuple(result):
        if key.startswith("WHIPPET_") or key in ("TEST_DATABASE_URL", "DATABASE_URL"):
            result.pop(key, None)
    if pg:
        result["TEST_DATABASE_URL"] = RECEIPT["dsn"]
    return result


def category(lines):
    body = "\n".join(lines).lower()
    if "no such file" in body or "enoent" in body:
        return "missing_file"
    if "migration" in body or "schema_migrations" in body:
        return "migration"
    if "connection refused" in body or "dial tcp" in body:
        return "database_connection"
    if "relation" in body and "does not exist" in body:
        return "missing_relation"
    if "duplicate key" in body:
        return "duplicate_key"
    if "assertionerror" in body or "err_assertion" in body:
        return "assertion"
    if "authorerror" in body:
        return "author_error"
    if "typeerror" in body:
        return "type_error"
    if "panic:" in body:
        return "panic"
    return "other_fixed_test_failure"


pg_args = ["go", "test", "-json", "-tags=integration", "-count=1", "./internal/server",
           "-run", "^(?:" + "|".join(PG_TESTS) + ")$"]
start = time.perf_counter()
pg = subprocess.run(pg_args, cwd=ROOT / "services/server", env=clean_env(True),
                    capture_output=True, text=True, errors="replace")
events = {}
for line in pg.stdout.splitlines():
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    name = event.get("Test")
    if not isinstance(name, str) or not SAFE_TEST.fullmatch(name):
        continue
    item = events.setdefault(name, {"status": None, "lines": []})
    if event.get("Action") in ("pass", "fail", "skip"):
        item["status"] = event["Action"]
    elif event.get("Action") == "output":
        item["lines"].append(str(event.get("Output", "")))

pg_results = []
for name in PG_TESTS:
    item = events.get(name, {"status": "not_run", "lines": []})
    sites = sorted({f"{match.group(1)}:{match.group(2)}" for line in item["lines"] for match in SOURCE.finditer(line)})
    pg_results.append({"test": name, "status": item["status"],
                       "same_root_cause_group": PG_GROUP[name],
                       "failure_enum": category(item["lines"]) if item["status"] == "fail" else None,
                       "source_sites": sites[:3]})

worker_results = []
for file in WORKER_FILES:
    args = ["node", "--test", "dist/" + file]
    start_file = time.perf_counter()
    proc = subprocess.run(args, cwd=ROOT / "runtimes/worker", env=clean_env(),
                          capture_output=True, text=True, errors="replace")
    body = (ROOT / "runtimes/worker/src" / file.replace(".js", ".ts")).read_text()
    fixed = set(re.findall(r"\b(?:test|it)\(\s*['\"]([^'\"\n]{1,160})['\"]", body))
    source_lines = {name: body[:body.find(name)].count("\n") + 1 for name in fixed}
    lines = proc.stdout.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"\s*not ok \d+ - (.+?)(?: # .*)?$", line)
        if not match or match.group(1) not in fixed:
            continue
        next_case = next((j for j in range(index + 1, len(lines)) if re.match(r"\s*(?:not )?ok \d+ - ", lines[j])), len(lines))
        diagnosis = lines[index:next_case]
        worker_results.append({"test": match.group(1), "file": file,
                               "source_line": source_lines[match.group(1)],
                               "same_root_cause_group": WORKER_GROUP[file],
                               "failure_enum": category(diagnosis),
                               "reproduce": args})
    worker_results.append({"file": file, "exit": proc.returncode,
                           "seconds": round(time.perf_counter() - start_file, 3)})

result = {"preconditions": {
    "isolated_pg_receipt_matched": RECEIPT.get("name") == "whippet-m10z-20261114-pg" and RECEIPT.get("port") == 32782,
    "registry_version_is_11_2": json.loads((ROOT / "contracts/tools/registry.json").read_text()).get("version") == "11.2",
    "no_model_or_docker_started_by_driver": True,
}, "pg": {"command": pg_args, "exit": pg.returncode, "seconds": round(time.perf_counter() - start, 3),
          "tests": pg_results}, "worker": worker_results}
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "failures.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "failures.json"), "pg_exit": pg.returncode,
                  "pg_fail": [x for x in pg_results if x["status"] == "fail"],
                  "worker_fail": [x for x in worker_results if "test" in x]}, ensure_ascii=False))
