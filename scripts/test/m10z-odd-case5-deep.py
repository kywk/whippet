#!/usr/bin/env python3
"""Read-only fixed publication-gate booleans for the two case5 snapshots."""

import json
import subprocess
import uuid
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
s = json.loads((OUT / "driver-state.json").read_text())
pg = json.loads((BASE / "postgres.json").read_text())
usecase = str(uuid.UUID(s["case5UsecaseTestId"]))
version = str(uuid.UUID(s["seedVersionId"]))
sql = f"""BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
 'kind','usecase',
 'runMatchesDraftRevision',r.draft_revision=d.current_revision,
 'runMatchesDraftSession',r.editing_session_id=d.editing_session_id,
 'runScriptMatchesDraft',r.script_snapshot=dr.script,
 'runHashMatchesDraft',r.script_hash=dr.script_hash,
 'runOriginMatchesDraft',r.script_origin=dr.script_origin,
 'runSettingsMatchDraft',r.workspace_settings=dr.workspace_settings,
 'runContextMatchesDraft',r.workspace_context=dr.workspace_context,
 'runTimeoutMatchesDraft',r.timeout_ms=dr.timeout_ms,
 'runRoleBindingsEmpty',COALESCE(cardinality(r.resolved_role_ids),0)=0,
 'runBundlePresent',r.files_snapshot IS NOT NULL AND r.bundle_hash IS NOT NULL AND r.bundle_metadata IS NOT NULL,
 'runBundleEntryMatchesScript',r.files_snapshot @> jsonb_build_array(jsonb_build_object('path','tests/test.spec.ts','content',r.script_snapshot)),
 'runStatusSucceeded',r.status='succeeded',
 'runSlotReleased',r.slot_released,
 'draftModuleNull',dr.module IS NULL,
 'draftStagesCountOne',jsonb_array_length(dr.stages)=1)
FROM drafts d JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision
 JOIN runs r ON r.id=d.validation_run_id WHERE d.test_id='{usecase}'::uuid;
SELECT json_build_object(
 'kind','reuse',
 'versionModulePresent',v.module IS NOT NULL,
 'versionValidationPresent',v.validation_run_id IS NOT NULL,
 'versionRevisionMatchesRun',v.source_revision=r.draft_revision,
 'versionSessionMatchesRun',v.editing_session_id=r.editing_session_id,
 'versionOriginMatchesRun',v.script_origin=r.script_origin,
 'versionSettingsMatchRun',v.workspace_settings=r.workspace_settings,
 'versionContextMatchesRun',v.workspace_context=r.workspace_context,
 'versionTimeoutMatchesRun',v.timeout_ms=r.timeout_ms,
 'runRoleBindingsEmpty',COALESCE(cardinality(r.resolved_role_ids),0)=0,
 'versionBundleHashMatchesRun',v.bundle_hash=r.bundle_hash,
 'runHarnessMatchesVersion',r.script_snapshot=v.module->>'harness',
 'runBundlePresent',r.files_snapshot IS NOT NULL AND r.bundle_hash IS NOT NULL AND r.bundle_metadata IS NOT NULL,
 'runBundleEntryMatchesScript',r.files_snapshot @> jsonb_build_array(jsonb_build_object('path','tests/test.spec.ts','content',r.script_snapshot)),
 'runStatusSucceeded',r.status='succeeded',
 'runSlotReleased',r.slot_released)
FROM test_versions v JOIN runs r ON r.id=v.validation_run_id WHERE v.id='{version}'::uuid;
COMMIT;"""
proc = subprocess.run(["docker", "exec", pg["name"], "psql", "-X", "-U", "postgres", "-d", "postgres",
                       "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
if proc.returncode:
    raise SystemExit("safe_deep_query_failed")
rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
if len(rows) != 2:
    raise SystemExit("safe_deep_rows_missing")
out = {row.pop("kind"): row for row in rows}
if any(any(value is not True and value is not False and value is not None for value in row.values()) for row in out.values()):
    raise SystemExit("unsafe_projection_type")
(OUT / "case5-summary-deep.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"result": str(OUT / "case5-summary-deep.json"),
                  "nonTrue": {kind: sorted(key for key, value in values.items() if value is not True)
                              for kind, values in out.items()}}, ensure_ascii=False))
