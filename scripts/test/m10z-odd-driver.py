#!/usr/bin/env python3
"""M10.Z odd cases: checkpointed public-API driver; safe metadata only."""

import argparse
import hashlib
import http.cookiejar
import json
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BASE = Path("/private/tmp/whippet-m10z-20261114")
OUT = BASE / "odd"
OUT.mkdir(parents=True, exist_ok=True)
STATE_FILE = OUT / "driver-state.json"
EVENTS_FILE = OUT / "driver-events.jsonl"
ENV = json.loads((BASE / "environment.json").read_text())
FIXTURE = json.loads((BASE / "business-fixture.json").read_text())
API = ENV["api"].rstrip("/")
if API != "https://127.0.0.1:19889" or ENV["target"] != FIXTURE["target"]:
    raise SystemExit("isolated_environment_mismatch")
WORKSPACE = FIXTURE["workspaceId"]
TARGET = FIXTURE["target"].rstrip("/")
SLUG = "m10z-odd-open-order-search"
TERMINAL = {"succeeded", "failed", "timed_out", "cancelled", "interrupted"}
RETRY_CONTENT = (
    "請在原 s2-query Stage 的既有 Module session 續修。前次已探索訂單頁，現在優先完成可執行候選，"
    "不要反覆重新探索。Module 使用單物件 run({page}) ABI；從目前頁面 #order-form 的 #order-id "
    "依序查詢 W3-OK 與 MISSING，從 #result 的實際 DOM 擷取 found、orderId、total、currency、status，"
    "回傳兩筆完整查詢結果給後續 verify Stage。不得把預期的 320 或 found 常數硬編碼作為查詢結果。"
    "Harness 必須對實際頁面查詢 W3-OK/MISSING 並精確斷言，錯 total/found 要失敗。"
    "請依 module-authoring 指引用有界 script/harness 分段工具提交候選並自試，再要求正式驗證；"
    "保持固定預算，不延長時間或調高模型輸出上限。"
)
state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}


def save(label, **fields):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    entry = {"event": label, "at": round(time.time(), 3), **fields}
    with EVENTS_FILE.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(json.dumps(entry, ensure_ascii=False))


class APIError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(f"http_{status}:{code}")


jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ENV["ca"])),
)


def call(method, path, payload=None):
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        save("request_intent", method=method, path=path)
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(API + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
    start = time.perf_counter()
    try:
        with opener.open(request, timeout=20) as response:
            body = response.read(8 << 20)
            result = json.loads(body) if body else {}
            return response.status, result, round(time.perf_counter() - start, 3)
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read(65536))
            code = body.get("error", {}).get("code", "http_error")
        except (ValueError, AttributeError):
            code = "http_error"
        raise APIError(error.code, code) from None
    except (urllib.error.URLError, TimeoutError):
        save("transport_unknown", method=method, path=path)
        raise SystemExit("transport_unknown; inspect server state before retry") from None


def login():
    status, _, _ = call("POST", "/api/dev-login", {})
    if status != 200:
        raise SystemExit("dev_login_failed")


def run_status(run_id):
    _, run, seconds = call("GET", "/api/runs/" + run_id)
    return {"id": run_id, "status": run.get("status"), "kind": run.get("kind"),
            "scriptOrigin": run.get("scriptOrigin"), "reportReady": bool(run.get("reportUrl")),
            "partial": bool(run.get("authorPartial")), "seconds": seconds}


def require_run_done(run_id):
    item = run_status(run_id)
    if item["status"] != "succeeded" or not item["reportReady"]:
        raise SystemExit("required_formal_run_not_ready:" + str(item["status"]))
    return item


def run_evidence(run_id):
    item = require_run_done(run_id)
    _, artifact, _ = call("GET", "/api/runs/" + run_id + "/artifacts/results.json")
    stats = artifact.get("stats", {})
    counts = {key: stats.get(key) for key in ("expected", "unexpected", "flaky", "skipped")}
    success = isinstance(counts["expected"], int) and counts["expected"] > 0 and all(
        counts[key] == 0 for key in ("unexpected", "flaky", "skipped"))
    save("formal_run_evidence", runId=run_id, kind=item["kind"], counts=counts,
         reportReady=item["reportReady"], assertionsPass=success)
    if not success:
        raise SystemExit("formal_result_counts_not_green")


def case3_audit():
    _, reply, _ = call("GET", "/api/tests/" + state["usecaseTestId"] + "/plan?" +
                       urllib.parse.urlencode({"editingSessionId": state["usecaseSessionId"]}))
    plan = reply["plan"]
    stages = plan["stages"]
    if len(stages) != 3:
        raise SystemExit("stage_count_mismatch")
    facts = []
    for stage in stages[1:]:
        test_id = stage.get("moduleTestId")
        if not test_id:
            raise SystemExit("created_module_missing")
        _, draft, _ = call("GET", "/api/tests/" + test_id + "/draft")
        body = (draft.get("script") or "") + "\n" + (draft.get("module") or {}).get("harness", "")
        facts.append({"stageId": stage["id"], "testId": test_id,
                      "hasPlaywrightExpect": "expect(" in body,
                      "assertsFound": "found" in body,
                      "assertsOrderId": "orderId" in body,
                      "assertsTotal320": "320" in body,
                      "moduleRevision": draft.get("revision"),
                      "origin": draft.get("scriptOrigin")})
    binding = stages[2].get("args", {}).get("queryResult", {})
    bound = binding.get("kind") == "binding" and binding.get("stageId") == stages[1]["id"] and binding.get("path") == []
    save("created_module_assertion_audit", modules=facts, queryReturnBoundToVerify=bound)
    if not bound or not facts[1]["hasPlaywrightExpect"] or not facts[1]["assertsTotal320"]:
        raise SystemExit("formal_assertion_not_evidenced")


def preflight():
    _, health, seconds = call("GET", "/healthz")
    _, workspace, _ = call("GET", "/api/workspaces/" + WORKSPACE)
    if workspace.get("id") != WORKSPACE or not FIXTURE.get("scopeConfirmed"):
        raise SystemExit("workspace_scope_not_ready")
    save("preflight", healthOk=True, scopeConfirmed=True, seconds=seconds)


def seed_nav():
    if state.get("seedTestId"):
        raise SystemExit("seed_already_started")
    metadata = {"slug": SLUG, "moduleKind": "setup", "exportName": "openOrderSearch",
                "signature": "openOrderSearch({page})", "inputs": "Playwright page",
                "returns": "void", "preconditions": "Workspace target is confirmed",
                "postconditions": "Order lookup form is visible",
                "harness": "import {test,expect} from '@playwright/test';\n"
                           "import {openOrderSearch} from '@lib/" + SLUG + "';\n"
                           "test('opens order lookup',async({page})=>{await openOrderSearch({page});"
                           "await expect(page.locator('#order-form')).toBeVisible();});"}
    script = "export async function openOrderSearch({page}:{page:any}) {\n" \
             + "  await page.goto('" + TARGET + "/');\n" \
             + "  await page.locator('#order-form').waitFor({state:'visible'});\n" \
             + "}\n"
    _, test, _ = call("POST", "/api/workspaces/" + WORKSPACE + "/tests",
                      {"kind": "module", "slug": SLUG, "name": "Open order lookup", "description": "Open confirmed synthetic order lookup"})
    state["seedTestId"] = test["id"]
    save("seed_test_created", testId=test["id"])
    _, reply, _ = call("POST", "/api/tests/" + test["id"] + "/editing-session", {})
    session = reply["session"]
    state["seedSessionId"] = session["id"]
    save("seed_session_started", sessionId=session["id"])
    revision = session["draft"]["revision"]
    _, draft, _ = call("PUT", "/api/tests/" + test["id"] + "/draft",
                       {"editingSessionId": session["id"], "revision": revision,
                        "script": script, "module": metadata})
    state["seedRevision"] = draft["revision"]
    save("seed_draft_saved", revision=draft["revision"], origin=draft.get("scriptOrigin"))
    _, run, _ = call("POST", "/api/tests/" + test["id"] + "/draft/validate",
                     {"editingSessionId": session["id"], "revision": draft["revision"]})
    state["seedValidationRunId"] = run["id"]
    save("seed_formal_validation_started", runId=run["id"])


def seed_summary():
    if state.get("seedSummaryRunId"):
        raise SystemExit("seed_summary_already_started")
    require_run_done(state["seedValidationRunId"])
    _, reply, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/draft/summary",
                       {"editingSessionId": state["seedSessionId"], "revision": state["seedRevision"],
                        "validationRunId": state["seedValidationRunId"]})
    state["seedSummaryRunId"] = reply["run"]["id"]
    save("seed_builtin_summary_started", runId=state["seedSummaryRunId"])


def seed_publish():
    if state.get("seedVersionId"):
        raise SystemExit("seed_already_published")
    summary = run_status(state["seedSummaryRunId"])
    if summary["status"] != "succeeded":
        raise SystemExit("seed_summary_not_ready:" + str(summary["status"]))
    _, version, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/publish",
                         {"editingSessionId": state["seedSessionId"], "revision": state["seedRevision"],
                          "summaryRunId": state["seedSummaryRunId"], "confirmed": True})
    state["seedVersionId"] = version["id"]
    save("seed_published", versionId=version["id"])


def case3_start():
    if state.get("usecaseTestId"):
        raise SystemExit("usecase_already_started")
    if not state.get("seedVersionId"):
        raise SystemExit("seed_not_published")
    _, test, _ = call("POST", "/api/workspaces/" + WORKSPACE + "/tests",
                      {"kind": "usecase", "name": "M10.Z odd order lookup",
                       "description": "Confirm one existing and two new modules against synthetic orders"})
    state["usecaseTestId"] = test["id"]
    save("usecase_test_created", testId=test["id"])
    _, reply, _ = call("POST", "/api/tests/" + test["id"] + "/editing-session", {})
    session = reply["session"]
    state["usecaseSessionId"] = session["id"]
    state["usecaseRevision"] = session["draft"]["revision"]
    save("usecase_session_started", sessionId=session["id"], revision=state["usecaseRevision"])
    prompt = (
        "請建立三個線性 Module Stage 的 Use Case Plan，且必須使用 catalog_search/catalog_get："
        f"先 reuse 已發布固定版 Module {state['seedVersionId']} 導覽到訂單查詢頁；"
        "再 create query Module，於頁面實際查詢 W3-OK 與 MISSING 並回傳兩筆完整資料；"
        "最後 create verify Module，接收前一階段完整回傳並使用 Playwright expect 精確斷言 "
        "W3-OK found=true、orderId=W3-OK、total=320、currency=TWD、status=completed，"
        "以及 MISSING found=false、orderId=MISSING。"
        "Module 單物件 run({page,...}) ABI；每個 harness 必須實際驗證。"
        "Use Case 導覽前提由第一 Stage 滿足。請提出 Plan，等待我確認後再產稿。"
    )
    _, submission, _ = call("POST", "/api/tests/" + test["id"] + "/messages",
                            {"editingSessionId": session["id"], "revision": state["usecaseRevision"], "content": prompt})
    state["plannerRunId"] = submission["run"]["id"]
    save("builtin_planner_started", runId=state["plannerRunId"])


def case3_confirm():
    if state.get("planConfirmed"):
        raise SystemExit("plan_already_confirmed")
    planner = run_status(state["plannerRunId"])
    if planner["status"] != "succeeded":
        raise SystemExit("planner_not_succeeded:" + str(planner["status"]))
    _, reply, _ = call("GET", "/api/tests/" + state["usecaseTestId"] + "/plan?" +
                       urllib.parse.urlencode({"editingSessionId": state["usecaseSessionId"]}))
    plan = reply["plan"]
    if not plan or plan["status"] != "draft" or len(plan["stages"]) != 3:
        raise SystemExit("plan_shape_not_ready")
    actions = [s["action"] for s in plan["stages"]]
    if actions != ["reuse", "create", "create"] or plan["stages"][0].get("moduleVersionId") != state["seedVersionId"]:
        raise SystemExit("plan_actions_or_pin_mismatch")
    state["planId"] = plan["id"]
    save("plan_reviewed", planId=plan["id"], revision=plan["revision"], actions=actions)
    _, reply, _ = call("POST", "/api/plans/" + plan["id"] + "/confirm",
                       {"planRevision": plan["revision"], "confirmed": True})
    state["planConfirmed"] = True
    save("plan_confirmed", planId=plan["id"], revision=reply["plan"]["revision"])


def case3_status():
    _, reply, seconds = call("GET", "/api/tests/" + state["usecaseTestId"] + "/plan?" +
                             urllib.parse.urlencode({"editingSessionId": state["usecaseSessionId"]}))
    plan = reply["plan"]
    if plan is None:
        raise SystemExit("plan_missing")
    state["planId"] = plan["id"]
    state["planRevision"] = plan["revision"]
    state["usecaseValidationRunId"] = plan.get("validationRunId")
    stages = [{"id": x["id"], "action": x["action"], "status": x["status"],
               "candidateVersionId": x.get("candidateVersionId"),
               "authorRunId": x.get("authorRunId"), "validationRunId": x.get("validationRunId")}
              for x in plan["stages"]]
    save("plan_status", status=plan["status"], revision=plan["revision"], stages=stages,
         validationRunId=plan.get("validationRunId"), seconds=seconds)


def case3_summary():
    if state.get("batchSummaryRunId"):
        raise SystemExit("summary_already_started")
    case3_status()
    require_run_done(state["usecaseValidationRunId"])
    _, reply, _ = call("POST", "/api/plans/" + state["planId"] + "/summary",
                       {"planRevision": state["planRevision"],
                        "validationRunId": state["usecaseValidationRunId"]})
    state["batchSummaryRunId"] = reply["run"]["id"]
    save("batch_builtin_summary_started", runId=state["batchSummaryRunId"])


def case3_publish():
    if state.get("usecaseVersionId"):
        raise SystemExit("batch_already_published")
    if run_status(state["batchSummaryRunId"])["status"] != "succeeded":
        raise SystemExit("batch_summary_not_ready")
    case3_status()
    _, reply, _ = call("POST", "/api/plans/" + state["planId"] + "/publish",
                       {"planRevision": state["planRevision"], "summaryRunId": state["batchSummaryRunId"],
                        "confirmed": True})
    version = reply.get("usecaseVersion", {})
    state["usecaseVersionId"] = version.get("id")
    state["moduleVersionIds"] = [m.get("id") for m in reply.get("moduleVersions", [])]
    save("batch_published", usecaseVersionId=state["usecaseVersionId"],
         moduleVersionIds=state["moduleVersionIds"])


def case3_formal():
    if state.get("formalRunId"):
        raise SystemExit("formal_already_started")
    if not state.get("usecaseVersionId"):
        raise SystemExit("batch_not_published")
    _, run, _ = call("POST", "/api/tests/" + state["usecaseTestId"] + "/runs", {})
    state["formalRunId"] = run["id"]
    save("published_formal_run_started", runId=run["id"], versionId=run.get("versionId"))


def case3_retry_preflight():
    if state.get("queryRetryRunId"):
        raise SystemExit("query_retry_already_started")
    _, reply, _ = call("GET", "/api/plans/" + state["planId"] + "/stages/s2-query/retry")
    retry = reply["retry"]
    source = retry.get("source") or {}
    if not retry.get("eligible") or retry.get("reason") is not None or not source.get("reclaimed") or source.get("authorRunId") != "0210dcf3-316f-415b-86e0-13051f3e4420":
        raise SystemExit("query_retry_not_eligible")
    body = {"planRevision": retry["planRevision"], "moduleRevision": source["moduleRevision"],
            "moduleContextRevision": source["moduleContextRevision"], "confirmed": True,
            "content": RETRY_CONTENT}
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    state["queryRetryPrepared"] = {"planRevision": body["planRevision"],
                                   "moduleRevision": body["moduleRevision"],
                                   "moduleContextRevision": body["moduleContextRevision"],
                                   "bodySha256": digest,
                                   "expectedWorkerImage": json.loads((BASE / "admission.json").read_text())["workerImage"]}
    save("query_retry_prepared", sourceRunId=source["authorRunId"],
         sourceModuleTestId=source["moduleTestId"], prepared=state["queryRetryPrepared"])


def case3_retry():
    if state.get("queryRetryRunId"):
        raise SystemExit("query_retry_already_started")
    if not state.get("queryRetryPrepared"):
        raise SystemExit("query_retry_preflight_required")
    _, reply, _ = call("GET", "/api/plans/" + state["planId"] + "/stages/s2-query/retry")
    retry = reply["retry"]
    source = retry.get("source") or {}
    body = {"planRevision": retry["planRevision"], "moduleRevision": source.get("moduleRevision"),
            "moduleContextRevision": source.get("moduleContextRevision"), "confirmed": True,
            "content": RETRY_CONTENT}
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    prepared = state["queryRetryPrepared"]
    if not retry.get("eligible") or not source.get("reclaimed") or digest != prepared["bodySha256"]:
        raise SystemExit("query_retry_snapshot_changed")
    save("query_retry_post_intent", bodySha256=digest, planRevision=body["planRevision"],
         sourceRunId=source["authorRunId"])
    _, reply, _ = call("POST", "/api/plans/" + state["planId"] + "/stages/s2-query/retry", body)
    new_stage = next(x for x in reply["plan"]["stages"] if x["id"] == "s2-query")
    state["queryRetryRunId"] = new_stage["authorRunId"]
    save("query_retry_started", runId=state["queryRetryRunId"], planRevision=reply["plan"]["revision"])


def case5_start():
    if state.get("upgradeValidationRunId"):
        raise SystemExit("upgrade_already_started")
    pinned_test = state.get("case5UsecaseTestId") or state.get("usecaseTestId")
    pinned_version = state.get("case5UsecaseVersionId") or state.get("usecaseVersionId")
    if not pinned_version:
        raise SystemExit("pinned_usecase_not_published")
    _, reply, _ = call("GET", "/api/tests/" + pinned_test + "/versions")
    version = next((v for v in reply.get("items", []) if v.get("id") == pinned_version), None)
    if not version or not version.get("stages") or version["stages"][0].get("moduleVersionId") != state["seedVersionId"]:
        raise SystemExit("original_usecase_pin_not_found")
    save("original_usecase_pin_confirmed", usecaseVersionId=version["id"],
         pinnedModuleVersionId=state["seedVersionId"])
    _, reply, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/editing-session", {})
    session = reply["session"]
    state["upgradeSessionId"] = session["id"]
    save("upgrade_session_started", sessionId=session["id"])
    draft = session["draft"]
    if not draft.get("module") or "openOrderSearch" not in draft.get("script", ""):
        raise SystemExit("seed_source_unavailable")
    changed = draft["script"].replace(
        "  await page.locator('#order-form').waitFor({state:'visible'});",
        "  await page.locator('#order-form').waitFor({state:'visible'});\n"
        "  if (!(await page.locator('#order-form').isVisible())) throw new Error('lookup form missing');")
    if changed == draft["script"]:
        raise SystemExit("upgrade_change_not_applied")
    _, updated, _ = call("PUT", "/api/tests/" + state["seedTestId"] + "/draft",
                         {"editingSessionId": session["id"], "revision": draft["revision"],
                          "script": changed, "module": draft["module"]})
    state["upgradeRevision"] = updated["revision"]
    save("upgrade_draft_saved", revision=updated["revision"], origin=updated.get("scriptOrigin"))
    _, run, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/draft/validate",
                     {"editingSessionId": session["id"], "revision": updated["revision"]})
    state["upgradeValidationRunId"] = run["id"]
    save("upgrade_formal_validation_started", runId=run["id"])


def case5_summary():
    if state.get("upgradeSummaryRunId"):
        raise SystemExit("upgrade_summary_already_started")
    require_run_done(state["upgradeValidationRunId"])
    _, reply, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/draft/summary",
                       {"editingSessionId": state["upgradeSessionId"], "revision": state["upgradeRevision"],
                        "validationRunId": state["upgradeValidationRunId"]})
    state["upgradeSummaryRunId"] = reply["run"]["id"]
    save("upgrade_builtin_summary_started", runId=state["upgradeSummaryRunId"])


def case5_publish():
    if state.get("upgradeVersionId"):
        raise SystemExit("upgrade_already_published")
    if run_status(state["upgradeSummaryRunId"])["status"] != "succeeded":
        raise SystemExit("upgrade_summary_not_ready")
    _, version, _ = call("POST", "/api/tests/" + state["seedTestId"] + "/publish",
                         {"editingSessionId": state["upgradeSessionId"], "revision": state["upgradeRevision"],
                          "summaryRunId": state["upgradeSummaryRunId"], "confirmed": True})
    state["upgradeVersionId"] = version["id"]
    if state["upgradeVersionId"] == state["seedVersionId"]:
        raise SystemExit("module_version_not_advanced")
    pinned_test = state.get("case5UsecaseTestId") or state.get("usecaseTestId")
    pinned_version = state.get("case5UsecaseVersionId") or state.get("usecaseVersionId")
    _, reply, _ = call("GET", "/api/tests/" + pinned_test + "/versions")
    original = next((v for v in reply.get("items", []) if v.get("id") == pinned_version), None)
    pinned = bool(original and original.get("stages") and
                  original["stages"][0].get("moduleVersionId") == state["seedVersionId"])
    save("module_upgraded_original_pin_checked", newVersionId=state["upgradeVersionId"],
         oldVersionId=state["seedVersionId"], originalUsecaseStillPinned=pinned)
    if not pinned:
        raise SystemExit("original_usecase_pin_changed")


def case5_create_pinned():
    if state.get("case5UsecaseTestId"):
        raise SystemExit("pinned_usecase_already_started")
    if not state.get("seedVersionId"):
        raise SystemExit("seed_not_published")
    _, test, _ = call("POST", "/api/workspaces/" + WORKSPACE + "/tests",
                      {"kind": "usecase", "name": "M10.Z odd pinned version check",
                       "description": "Single published navigation Module fixed at its original version"})
    state["case5UsecaseTestId"] = test["id"]
    save("pinned_usecase_created", testId=test["id"])
    _, reply, _ = call("POST", "/api/tests/" + test["id"] + "/editing-session", {})
    session = reply["session"]
    state["case5SessionId"] = session["id"]
    save("pinned_usecase_session_started", sessionId=session["id"])
    stage = {"id": "nav", "title": "Open order lookup", "action": "reuse",
             "moduleVersionId": state["seedVersionId"], "args": {}}
    _, reply, _ = call("PUT", "/api/tests/" + test["id"] + "/plan",
                       {"editingSessionId": session["id"], "revision": session["draft"]["revision"],
                        "planRevision": 0, "stages": [stage]})
    plan = reply["plan"]
    state["case5PlanId"] = plan["id"]
    save("pinned_plan_saved", planId=plan["id"], revision=plan["revision"])
    _, reply, _ = call("POST", "/api/plans/" + plan["id"] + "/confirm",
                       {"planRevision": plan["revision"], "confirmed": True})
    plan = reply["plan"]
    state["case5PlanRevision"] = plan["revision"]
    state["case5ValidationRunId"] = plan.get("validationRunId")
    save("pinned_plan_confirmed", planId=plan["id"], status=plan["status"],
         validationRunId=plan.get("validationRunId"))


def case5_pinned_status():
    _, reply, _ = call("GET", "/api/tests/" + state["case5UsecaseTestId"] + "/plan?" +
                       urllib.parse.urlencode({"editingSessionId": state["case5SessionId"]}))
    plan = reply["plan"]
    state["case5PlanRevision"] = plan["revision"]
    state["case5ValidationRunId"] = plan.get("validationRunId")
    save("pinned_plan_status", status=plan["status"], revision=plan["revision"],
         validationRunId=plan.get("validationRunId"))


def case5_pinned_summary():
    if state.get("case5SummaryRunId"):
        raise SystemExit("pinned_summary_already_started")
    if state.get("case5SummaryRetryPosted"):
        raise SystemExit("pinned_summary_retry_already_posted")
    if not state.get("case5SummaryPrepared"):
        raise SystemExit("pinned_summary_preflight_required")
    case5_pinned_status()
    require_run_done(state["case5ValidationRunId"])
    body = {"planRevision": state["case5PlanRevision"],
            "validationRunId": state["case5ValidationRunId"]}
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if digest != state["case5SummaryPrepared"]["bodySha256"]:
        raise SystemExit("pinned_summary_snapshot_changed")
    state["case5SummaryRetryPosted"] = True
    save("pinned_summary_retry_post_intent", bodySha256=digest)
    _, reply, _ = call("POST", "/api/plans/" + state["case5PlanId"] + "/summary",
                       body)
    state["case5SummaryRunId"] = reply["run"]["id"]
    save("pinned_builtin_summary_started", runId=state["case5SummaryRunId"])


def case5_summary_preflight():
    if state.get("case5SummaryRunId") or state.get("case5SummaryRetryPosted"):
        raise SystemExit("pinned_summary_already_submitted")
    case5_pinned_status()
    require_run_done(state["case5ValidationRunId"])
    _, reply, _ = call("GET", "/api/plans/" + state["case5PlanId"] + "/summary")
    if reply.get("summary") is not None:
        raise SystemExit("pinned_summary_already_exists")
    pg_name = json.loads((BASE / "postgres.json").read_text())["name"]
    if pg_name != "whippet-m10z-20261114-pg":
        raise SystemExit("isolated_pg_mismatch")
    sql = ("BEGIN TRANSACTION READ ONLY; SELECT json_build_object('slotReleased',r.slot_released,"
           "'summaryRowAbsent',NOT EXISTS(SELECT 1 FROM plan_summaries ps WHERE ps.plan_id='" +
           state["case5PlanId"] + "'::uuid),'validationMatches',p.validation_run_id=r.id) "
           "FROM plans p JOIN runs r ON r.id=p.validation_run_id WHERE p.id='" +
           state["case5PlanId"] + "'::uuid; COMMIT;")
    check = subprocess.run(["docker", "exec", pg_name, "psql", "-X", "-U", "postgres",
                            "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                           capture_output=True, text=True)
    rows = [json.loads(line) for line in check.stdout.splitlines() if line.startswith("{")]
    if check.returncode or len(rows) != 1 or not all(rows[0].values()):
        raise SystemExit("pinned_summary_db_preconditions_not_ready")
    events = [json.loads(line) for line in EVENTS_FILE.read_text().splitlines()]
    path = "/api/plans/" + state["case5PlanId"] + "/summary"
    prior = sum(x.get("event") == "request_intent" and x.get("path") == path for x in events)
    if prior != 1 or not any(x.get("event") == "http_rejected" and x.get("status") == 409 for x in events):
        raise SystemExit("prior_rejection_not_unique")
    body = {"planRevision": state["case5PlanRevision"],
            "validationRunId": state["case5ValidationRunId"]}
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    state["case5SummaryPrepared"] = {"bodySha256": digest,
                                     "planRevision": body["planRevision"],
                                     "validationRunId": body["validationRunId"],
                                     "priorRejectedPostCount": prior,
                                     "slotReleased": True, "summaryRowAbsent": True}
    save("pinned_summary_retry_prepared", **state["case5SummaryPrepared"])


def case5_pinned_publish():
    if state.get("case5UsecaseVersionId"):
        raise SystemExit("pinned_usecase_already_published")
    if run_status(state["case5SummaryRunId"])["status"] != "succeeded":
        raise SystemExit("pinned_summary_not_ready")
    case5_pinned_status()
    _, reply, _ = call("POST", "/api/plans/" + state["case5PlanId"] + "/publish",
                       {"planRevision": state["case5PlanRevision"], "summaryRunId": state["case5SummaryRunId"],
                        "confirmed": True})
    state["case5UsecaseVersionId"] = reply["usecaseVersion"]["id"]
    save("pinned_usecase_published", versionId=state["case5UsecaseVersionId"])


def case5_pinned_formal():
    if state.get("case5FormalRunId"):
        raise SystemExit("pinned_formal_already_started")
    if not state.get("upgradeVersionId") or not state.get("case5UsecaseVersionId"):
        raise SystemExit("immutable_versions_not_ready")
    _, run, _ = call("POST", "/api/tests/" + state["case5UsecaseTestId"] + "/runs", {})
    state["case5FormalRunId"] = run["id"]
    pinned = run.get("versionId") == state["case5UsecaseVersionId"]
    save("pinned_formal_run_started", runId=run["id"], versionId=run.get("versionId"),
         originalUsecaseVersionPinned=pinned)
    if not pinned:
        raise SystemExit("formal_run_version_not_original")


def case5_cross_workspace():
    if state.get("otherWorkspaceId"):
        raise SystemExit("other_workspace_already_created")
    _, other, _ = call("POST", "/api/workspaces", {"name": "M10.Z odd catalog isolation"})
    state["otherWorkspaceId"] = other["id"]
    save("other_workspace_created", workspaceId=other["id"])
    query = urllib.parse.urlencode({"query": SLUG})
    _, result, _ = call("GET", "/api/workspaces/" + other["id"] + "/catalog?" + query)
    items = result.get("items", [])
    absent = all(x.get("slug") != SLUG for x in items)
    save("cross_workspace_catalog_checked", foreignModuleAbsent=absent, itemCount=len(items))
    if not absent:
        raise SystemExit("cross_workspace_catalog_leak")


def case7_start():
    if state.get("partialTestId"):
        raise SystemExit("partial_already_started")
    _, test, _ = call("POST", "/api/workspaces/" + WORKSPACE + "/tests",
                      {"name": "M10.Z odd partial continuation", "description": "Fixed-budget builtin continuation"})
    state["partialTestId"] = test["id"]
    save("partial_test_created", testId=test["id"])
    _, reply, _ = call("POST", "/api/tests/" + test["id"] + "/editing-session", {})
    session = reply["session"]
    state["partialSessionId"] = session["id"]
    save("partial_session_started", sessionId=session["id"])
    prompt = ("請為已確認的合成訂單查詢頁建立 Playwright Test，先探索 W3-OK 與 MISSING，"
              "以精確斷言驗證 W3-OK 的 total=320、currency=TWD、status=completed、found=true，"
              "以及 MISSING 的 found=false。先以工具自試候選；若固定預算耗盡，保留已自試通過的"
              "checkpoint 和下一步，等待正式繼續，不要跳過驗證或弱化斷言。")
    _, submission, _ = call("POST", "/api/tests/" + test["id"] + "/messages",
                            {"editingSessionId": session["id"], "revision": session["draft"]["revision"],
                             "content": prompt})
    state["partialSourceRunId"] = submission["run"]["id"]
    save("partial_source_started", runId=state["partialSourceRunId"])


def case7_continue():
    if state.get("partialContinueRunId"):
        raise SystemExit("partial_continue_already_started")
    _, run, _ = call("GET", "/api/runs/" + state["partialSourceRunId"])
    partial = run.get("authorPartial")
    if run.get("status") != "succeeded" or not partial:
        raise SystemExit("source_is_not_succeeded_partial")
    revision = partial.get("appliedRevision") if partial.get("appliedRevision") is not None else run.get("draftRevision")
    if not isinstance(revision, int) or revision < 1:
        raise SystemExit("partial_revision_unavailable")
    _, submission, _ = call("POST", "/api/runs/" + run["id"] + "/continue",
                            {"editingSessionId": state["partialSessionId"], "revision": revision})
    state["partialContinueRunId"] = submission["run"]["id"]
    save("partial_continue_started", sourceRunId=run["id"],
         continueRunId=state["partialContinueRunId"], revision=revision)


def case7_continue_again():
    if state.get("partialSecondContinueRunId"):
        raise SystemExit("second_continue_already_started")
    source_id = state["partialContinueRunId"]
    _, run, _ = call("GET", "/api/runs/" + source_id)
    partial = run.get("authorPartial")
    if run.get("status") != "succeeded" or not partial or partial.get("reason") != "budget_exhausted":
        raise SystemExit("second_source_not_partial")
    revision = partial.get("appliedRevision") if partial.get("appliedRevision") is not None else run.get("draftRevision")
    _, session_reply, _ = call("GET", "/api/tests/" + state["partialTestId"] + "/editing-session")
    session = session_reply["session"]
    if session["status"] != "active" or session["pendingRunIds"] or session["reclaimPending"] or session["draft"]["revision"] != revision:
        raise SystemExit("second_continue_cas_not_ready")
    body = {"editingSessionId": state["partialSessionId"], "revision": revision}
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    save("second_continue_post_intent", sourceRunId=source_id, revision=revision,
         bodySha256=digest, expectedWorkerImage=json.loads((BASE / "admission.json").read_text())["workerImage"])
    _, submission, _ = call("POST", "/api/runs/" + source_id + "/continue", body)
    state["partialSecondContinueRunId"] = submission["run"]["id"]
    save("second_continue_started", sourceRunId=source_id,
         continueRunId=state["partialSecondContinueRunId"], revision=revision)


COMMANDS = {"preflight": preflight, "seed-nav": seed_nav, "seed-summary": seed_summary,
            "seed-publish": seed_publish, "case3-start": case3_start,
            "case3-confirm": case3_confirm, "case3-status": case3_status,
            "case3-summary": case3_summary, "case3-publish": case3_publish,
            "case3-formal": case3_formal, "case3-audit": case3_audit,
            "case3-retry-preflight": case3_retry_preflight,
            "case3-retry": case3_retry,
            "case5-create-pinned": case5_create_pinned,
            "case5-pinned-status": case5_pinned_status,
            "case5-summary-preflight": case5_summary_preflight,
            "case5-pinned-summary": case5_pinned_summary,
            "case5-pinned-publish": case5_pinned_publish,
            "case5-pinned-formal": case5_pinned_formal,
            "case5-start": case5_start,
            "case5-summary": case5_summary, "case5-publish": case5_publish,
            "case5-cross-workspace": case5_cross_workspace,
            "case7-start": case7_start, "case7-continue": case7_continue,
            "case7-continue-again": case7_continue_again}
parser = argparse.ArgumentParser()
parser.add_argument("command", choices=[*COMMANDS, "run-status", "run-evidence"])
parser.add_argument("--run-id")
args = parser.parse_args()
try:
    login()
    if args.command in ("run-status", "run-evidence"):
        if not args.run_id:
            raise SystemExit("run_id_required")
        if args.command == "run-status":
            save("run_status", **run_status(args.run_id))
        else:
            run_evidence(args.run_id)
    else:
        COMMANDS[args.command]()
except APIError as error:
    save("http_rejected", status=error.status, code=error.code)
    sys.exit(1)
