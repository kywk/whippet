#!/usr/bin/env python3
"""Check case5 artifact integrity and expected bundle structure without content output."""

import hashlib
import http.cookiejar
import json
import os
import ssl
import stat
import subprocess
import uuid
import urllib.error
import urllib.request
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
state = json.loads((OUT / "driver-state.json").read_text())
environment = json.loads((BASE / "environment.json").read_text())
receipt = json.loads((BASE / "postgres.json").read_text())
ids = [str(uuid.UUID(state[key])) for key in ("case5ValidationRunId", "seedValidationRunId")]
seed = str(uuid.UUID(state["seedVersionId"]))
case5 = str(uuid.UUID(state["case5UsecaseTestId"]))
sql = f"""BEGIN TRANSACTION READ ONLY;
SELECT json_build_object('runId',a.run_id,'name',a.name,'size',a.size_bytes,'sha256',a.sha256,'storageKey',a.storage_key)
FROM artifacts a JOIN runs r ON r.id=a.run_id AND r.attempt_id=a.attempt_id
WHERE a.run_id IN ('{ids[0]}'::uuid,'{ids[1]}'::uuid) AND a.name IN ('report.html','results.json');
SELECT json_build_object(
 'usecaseMetadataStagesMatchDraft',ur.bundle_metadata->'stages'=udr.stages,
 'usecaseMetadataModuleNull',ur.bundle_metadata->'module'='null'::jsonb,
 'usecaseMetadataPinnedDependency',ur.bundle_metadata->'dependencies' @> jsonb_build_array(jsonb_build_object('moduleTestId',sv.test_id,'moduleVersionId',sv.id)),
 'usecaseEntryMatchesDraft',ur.files_snapshot @> jsonb_build_array(jsonb_build_object('path','tests/test.spec.ts','content',udr.script)),
 'usecaseLibMatchesSeedVersion',ur.files_snapshot @> jsonb_build_array(jsonb_build_object('path','lib/' || (sv.module->>'slug') || '.ts','content',sv.script,'origin',sv.script_origin)),
 'reuseMetadataModuleMatchesVersion',sr.bundle_metadata->'module'=sv.module,
 'reuseMetadataStagesEmpty',sr.bundle_metadata->'stages'='[]'::jsonb,
 'reuseMetadataDependenciesEmpty',sr.bundle_metadata->'dependencies'='[]'::jsonb,
 'reuseEntryMatchesHarness',sr.files_snapshot @> jsonb_build_array(jsonb_build_object('path','tests/test.spec.ts','content',sv.module->>'harness')),
 'reuseLibMatchesVersion',sr.files_snapshot @> jsonb_build_array(jsonb_build_object('path','lib/' || (sv.module->>'slug') || '.ts','content',sv.script,'origin',sv.script_origin)),
 'reuseBundleHashMatchesPin',sr.bundle_hash=sv.bundle_hash,
 'usecaseExecutionManual',udr.script_origin='manual',
 'reuseExecutionManual',sv.script_origin='manual')
FROM drafts ud JOIN draft_revisions udr ON udr.test_id=ud.test_id AND udr.revision=ud.current_revision
 JOIN runs ur ON ur.id=ud.validation_run_id
 JOIN test_versions sv ON sv.id='{seed}'::uuid
 JOIN runs sr ON sr.id=sv.validation_run_id
WHERE ud.test_id='{case5}'::uuid;
COMMIT;"""
proc = subprocess.run(["docker", "exec", receipt["name"], "psql", "-X", "-U", "postgres",
                       "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                      capture_output=True, text=True)
if proc.returncode:
    detail = proc.stderr.lower()
    code = ("syntax" if "syntax error" in detail else
            "operator" if "operator does not exist" in detail else
            "column" if "column" in detail and "does not exist" in detail else
            "other")
    states = [x for x in __import__("re").findall(r"\b[0-9A-Z]{5}\b", proc.stderr) if x != "ERROR"]
    numbers = __import__("re").findall(r"LINE (\d+):", proc.stderr)
    invalid_type = next((kind for kind in ("uuid", "json", "integer", "boolean")
                         if "invalid input syntax for type " + kind in proc.stderr.lower()), "unknown")
    raise SystemExit("safe_artifact_query_failed:" + code + ":" + (states[0] if states else "unknown") +
                     ":line=" + (numbers[0] if numbers else "unknown") + ":type=" + invalid_type)
rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
if len(rows) != 5:
    raise SystemExit("safe_artifact_rows_missing")
metadata, structure = rows[:4], rows[4]
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=environment["ca"])))
opener.open(urllib.request.Request(environment["api"] + "/api/dev-login", data=b"{}",
                                   headers={"Content-Type": "application/json"})).read()
checks = []
for item in metadata:
    url = environment["api"] + "/api/runs/" + item["runId"] + "/artifacts/" + item["name"]
    try:
        with opener.open(url, timeout=20) as response:
            data = response.read(64 << 20)
            status = response.status
    except urllib.error.HTTPError as error:
        data, status = b"", error.code
    key_parts = Path(item["storageKey"]).parts
    if not key_parts or Path(item["storageKey"]).is_absolute() or any(x in (".", "..") for x in key_parts):
        raise SystemExit("unsafe_artifact_storage_key")
    fds = []
    try:
        fd = os.open(BASE / "artifacts", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        for part in key_parts[:-1]:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fds.append(fd)
        fd = os.open(key_parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        fds.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > (64 << 20):
            raise SystemExit("unsafe_artifact_file")
        source = os.read(fd, (64 << 20) + 1)
    finally:
        for fd in reversed(fds):
            os.close(fd)
    checks.append({"runId": item["runId"], "artifact": item["name"], "http200": status == 200,
                   "sourceSizeMatches": len(source) == item["size"],
                   "sourceSha256Matches": hashlib.sha256(source).hexdigest() == item["sha256"],
                   "httpResponseMatchesStored": None if item["name"] == "report.html" else
                       len(data) == item["size"] and hashlib.sha256(data).hexdigest() == item["sha256"]})
if not all(type(value) is bool for value in structure.values()):
    raise SystemExit("unsafe_bundle_projection")
out = {"artifactChecks": checks, "bundleForDraftStructuralChecks": structure,
       "limitations": ["Structural bundle match uses current draft/version and pinned dependency; Go canonical hash is represented by saved immutable pin equality",
                       "report.html HTTP body is transformed by storage shim; source file size/hash verified directly",
                       "ExecutionBinding manual branch confirmed; no secret or artifact content persisted"]}
(OUT / "case5-summary-artifacts.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "case5-summary-artifacts.json"),
                  "artifactChecksAllTrue": all(all(x[k] for k in ("http200", "sourceSizeMatches", "sourceSha256Matches")) and
                                               x["httpResponseMatchesStored"] is not False for x in checks),
                  "bundleNonTrue": sorted(k for k, value in structure.items() if not value)}, ensure_ascii=False))
