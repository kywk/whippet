#!/usr/bin/env python3
"""Isolated M10 public API fixture; never requests AI summaries or publication."""
import json
import pathlib
import sys
import urllib.request

BASE = "http://127.0.0.1:19087/api"
STATE = pathlib.Path(__file__).with_name("m10_manual_fixture.result.json")
WORKSPACE = "00000000-0000-4000-8000-000000000001"


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def save(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def create():
    if STATE.exists():
        raise SystemExit("Existing fixture state: use inspect; do not duplicate runs.")
    state = {"base": BASE, "owner": "t4b", "modules": []}
    save(state)
    for outcome in ("success", "failure"):
        slug = "t4b-manual-" + outcome
        test = request(f"/workspaces/{WORKSPACE}/tests", {
            "kind": "module", "slug": slug, "name": slug,
            "description": "M10 isolated public API pure-computation fixture"})
        item = {"testId": test["id"], "slug": slug, "expected": outcome}
        state["modules"].append(item)
        save(state)
        session = request(f'/tests/{test["id"]}/editing-session', {})["session"]
        draft = request(f'/tests/{test["id"]}/draft')
        item["editingSessionId"] = session["id"]
        expected = "alpha" if outcome == "success" else "intentional-mismatch"
        harness = ("import {test,expect} from '@playwright/test';\n"
                   f"import {{prepare}} from '@lib/{slug}';\n"
                   "test('manual Module stages',async()=>{\n"
                   "const result=await test.step('Stage 1: prepare',()=>prepare({}));\n"
                   f"await test.step('Stage 2: verify',async()=>{{expect(result.name).toBe('{expected}');}});\n"
                   "});\n")
        body = {"editingSessionId": session["id"], "revision": draft["revision"],
                "script": "export async function prepare(_args: any){return {name:'alpha'};}\n",
                "module": {"slug": slug, "moduleKind": "step", "exportName": "prepare",
                           "signature": "prepare({ ...args })", "inputs": "No arguments required",
                           "returns": "{name: string}", "preconditions": "None",
                           "postconditions": "Returns alpha without external I/O", "harness": harness}}
        item["saveRequest"] = body
        save(state)
        draft = request(f'/tests/{test["id"]}/draft', body, "PUT")
        item["revision"] = draft["revision"]
        save(state)
        run = request(f'/tests/{test["id"]}/draft/validate', {
            "editingSessionId": session["id"], "revision": draft["revision"]})
        item["runId"] = run["id"]
        save(state)
    test = request(f"/workspaces/{WORKSPACE}/tests", {
        "kind": "usecase", "name": "t4b-manual-reuse-pending",
        "description": "Awaiting published Module; no model tasks dispatched"})
    state["usecase"] = {"testId": test["id"]}
    save(state)
    session = request(f'/tests/{test["id"]}/editing-session', {})["session"]
    state["usecase"]["editingSessionId"] = session["id"]
    state["usecase"]["plan"] = request(
        f'/tests/{test["id"]}/plan?editingSessionId={session["id"]}')
    save(state)


def inspect():
    state = json.loads(STATE.read_text())
    for item in state["modules"]:
        if "runId" in item:
            run = request('/runs/' + item["runId"])
            artifacts = request('/runs/' + item["runId"] + '/artifacts')
            item["observedRun"] = run
            item["artifacts"] = artifacts
            print(json.dumps({"testId": item["testId"], "runId": item["runId"],
                              "expected": item["expected"], "status": run["status"],
                              "artifacts": artifacts}, ensure_ascii=False))
    save(state)


if __name__ == "__main__":
    if sys.argv[1:] == ["create"]:
        create()
        inspect()
    elif sys.argv[1:] == ["inspect"]:
        inspect()
    else:
        raise SystemExit("Usage: m10_manual_fixture.py create|inspect")
