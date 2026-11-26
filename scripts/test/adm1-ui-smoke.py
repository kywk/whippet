#!/usr/bin/env python3
"""Run ADM browser acceptance against an isolated production Web and Server."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


def checked(response, status, code=None):
    if response.status != status:
        error = ""
        if response.status >= 400 and "application/json" in response.headers.get("content-type", ""):
            candidate = response.json().get("error", {}).get("code", "")
            if isinstance(candidate, str) and candidate.replace("_", "").isalnum() and len(candidate) < 48:
                error = f" ({candidate})"
        raise AssertionError(f"{urlsplit(response.url).path}: HTTP {response.status}{error}, expected {status}")
    if status == 204:
        return None
    payload = response.json()
    if code is not None:
        actual = payload.get("error", {}).get("code")
        assert actual == code, (urlsplit(response.url).path, actual, code)
    return payload


def login(browser, base, key, user, route="", narrow=False):
    viewport = {"width": 390, "height": 844} if narrow else {"width": 1440, "height": 900}
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    page.goto(base + "/" + route, wait_until="networkidle")
    page.get_by_label("開發身分").select_option(user)
    page.get_by_label("管理 key", exact=False).fill(key)
    with page.expect_response(lambda response: response.url.endswith("/api/dev-login")) as login_response:
        page.get_by_role("button", name="登入", exact=True).click()
    assert checked(login_response.value, 200)["user"]["id"] == user
    expect(page.get_by_role("button", name="登入", exact=True)).to_have_count(0)
    return page


def api(page, base, method, path, status, data=None, code=None):
    parsed = urlsplit(base)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    response = page.request.fetch(base + path, method=method, headers={"Origin": origin}, data=data)
    return checked(response, status, code)


def management_id(page):
    return parse_qs(urlsplit(page.url).query)["workspace"][0]


def create_workspace(page, name):
    page.get_by_role("link", name="Workspace 管理", exact=True).click()
    page.get_by_role("link", name="建立 Workspace", exact=True).click()
    page.get_by_label("Workspace 名稱（選填）").fill(name)
    with page.expect_response(
        lambda response: response.url.endswith("/api/workspaces") and response.request.method == "POST"
    ) as created:
        page.get_by_role("button", name="建立 Workspace", exact=True).click()
    item = checked(created.value, 201)
    expect(page.get_by_role("heading", name="Workspace 成員管理")).to_be_visible()
    expect(page.get_by_text(name, exact=True)).to_be_visible()
    assert management_id(page) == item["id"]
    assert item["management"]["state"] == "active" and item["management"]["revision"] == 1
    return item["id"]


def change_member(page, workspace, role):
    page.get_by_role("searchbox", name="搜尋帳號").fill("dev-qa")
    row = page.get_by_role("listitem").filter(has=page.get_by_text("dev-qa", exact=True))
    expect(row).to_have_count(1)
    row.get_by_role("combobox").select_option(role)
    with page.expect_response(
        lambda response: response.url.endswith(f"/api/workspaces/{workspace}/members/dev-qa")
        and response.request.method == "PUT"
    ) as saved:
        row.get_by_role("button", name="儲存 QA User 的角色").click()
    assert checked(saved.value, 200)["member"]["role"] == role
    expect(page.get_by_role("status").filter(has_text="已儲存 QA User")).to_be_visible()


def workspace_management(page, base, workspace, name, mode, evidence):
    page.goto(f"{base}/?admin=workspace&workspace={workspace}")
    expect(page.get_by_role("heading", name=name, exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name="封存影響")).to_be_visible()
    impact = api(page, base, "GET", f"/api/admin/workspaces/{workspace}", 200)["impact"]
    assert set(impact) == {
        "queuedRuns", "activeRuns", "externalClaims", "browserLeases", "unreleasedRunSlots", "provisionJobs"
    }
    assert all(count == 0 for count in impact.values())
    page.get_by_role("button", name="封存 Workspace", exact=True).click()
    dialog = page.get_by_role("dialog", name="封存 Workspace")
    dialog.get_by_label("等候結束" if mode == "drain" else "取消並等待回收").check()
    if evidence is not None and mode == "drain":
        page.screenshot(path=evidence / "adm1-archive-preview.png")
    with page.expect_response(lambda response: response.url.endswith(f"/{workspace}/archive")) as archived:
        dialog.get_by_role("button", name="確認封存").click()
    management = checked(archived.value, 200)["workspace"]["management"]
    assert management["state"] == "archived" and management["archiveMode"] == mode
    expect(page.get_by_text("Workspace 已封存。", exact=True)).to_be_visible()
    api(page, base, "GET", f"/api/workspaces/{workspace}/members", 200)
    api(page, base, "POST", f"/api/workspaces/{workspace}/tests", 409, {"name": "blocked"}, "workspace_archived")
    api(page, base, "POST", f"/api/admin/workspaces/{workspace}/restore", 409, {"revision": 1}, "stale_revision")

    page.get_by_role("link", name="Workspace 管理", exact=True).click()
    page.get_by_label("Workspace 狀態").select_option("archived")
    page.get_by_role("link", name=f"查看詳情（{name}）").click()
    expect(page.get_by_role("heading", name=name, exact=True)).to_be_visible()
    page.get_by_role("button", name="還原 Workspace").click()
    restore = page.get_by_role("dialog", name="還原 Workspace")
    with page.expect_response(lambda response: response.url.endswith(f"/{workspace}/restore")) as restored:
        restore.get_by_role("button", name="確認還原").click()
    current = checked(restored.value, 200)["workspace"]["management"]
    assert current["state"] == "active" and current["revision"] == management["revision"] + 1
    assert all(current[key] is None for key in ("archiveMode", "archiveStartedAt", "archivedAt"))
    expect(page.get_by_text("Workspace 已還原。", exact=True)).to_be_visible()
    return {"workspaceId": workspace, "mode": mode, "archived": management, "restored": current, "impact": impact}


def smoke(browser, base, admin_key, evidence):
    site = login(browser, base, admin_key, "dev-site-admin")
    site.get_by_role("button", name="更多功能").click()
    site.get_by_role("button", name="全站管理", exact=True).click()
    expect(site.get_by_role("heading", name="Workspace 管理")).to_be_visible()
    expect(site.get_by_role("link", name="全站角色", exact=True)).to_have_count(0)

    suffix = uuid4().hex[:8]
    name_a, name_b = f"ADM-1 {suffix} A", f"ADM-1 {suffix} B"
    workspace_a = create_workspace(site, name_a)
    change_member(site, workspace_a, "workspace_admin")
    change_member(site, workspace_a, "qa")
    workspace_b = create_workspace(site, name_b)
    change_member(site, workspace_b, "none")
    change_member(site, workspace_b, "qa")
    assert workspace_a != workspace_b
    matches = api(site, base, "GET", "/api/users?q=%20DEV-QA%20", 200)["items"]
    assert [item["id"] for item in matches] == ["dev-qa"]
    api(site, base, "PATCH", "/api/users/dev-qa/role", 403, {"role": "site_admin"}, "forbidden")
    api(site, base, "GET", "/api/admin/ai/resources", 403, code="forbidden")
    site.goto(base + "/?admin=roles")
    expect(site.get_by_text("全站角色由 Super Admin 管理。")).to_be_visible()

    qa = login(browser, base, admin_key, "dev-qa", "?admin=workspaces", narrow=True)
    expect(qa.get_by_role("heading", name="無法開啟管理頁面")).to_be_visible()
    api(qa, base, "GET", "/api/admin/workspaces", 403, code="forbidden")
    api(qa, base, "GET", f"/api/workspaces/{workspace_a}", 200)
    api(qa, base, "GET", f"/api/workspaces/{workspace_b}", 200)
    if evidence is not None:
        qa.screenshot(path=evidence / "adm1-qa-narrow-denied.png")
    site.goto(f"{base}/?admin=members&workspace={workspace_a}")
    change_member(site, workspace_a, "none")
    api(qa, base, "GET", f"/api/workspaces/{workspace_a}", 404, code="not_found")
    api(qa, base, "GET", f"/api/workspaces/{workspace_b}", 200)
    change_member(site, workspace_a, "qa")

    workspace_admin = login(browser, base, admin_key, "dev-workspace-admin")
    workspace_admin.get_by_role("button", name="更多功能").click()
    expect(workspace_admin.get_by_role("button", name="全站管理", exact=True)).to_have_count(0)
    workspace_admin.get_by_role("button", name="Workspace 成員管理").click()
    expect(workspace_admin.get_by_role("heading", name="Workspace 成員管理")).to_be_visible()
    workspace_admin.get_by_role("searchbox", name="搜尋帳號").fill("dev-qa")
    qa_role = workspace_admin.get_by_role("listitem").filter(has=workspace_admin.get_by_text("dev-qa", exact=True))
    expect(qa_role.locator('option[value="workspace_admin"]')).to_have_count(0)
    api(workspace_admin, base, "GET", "/api/admin/workspaces", 403, code="forbidden")
    api(workspace_admin, base, "PUT", f"/api/workspaces/{workspace_a}/members/dev-qa", 403,
        {"role": "workspace_admin"}, "forbidden")

    super_admin = login(browser, base, admin_key, "dev-admin", "?admin=roles")
    expect(super_admin.get_by_role("heading", name="全站角色管理")).to_be_visible()
    super_admin.get_by_role("searchbox", name="搜尋帳號").fill("dev-admin")
    admin_row = super_admin.get_by_role("listitem").filter(has=super_admin.get_by_text("dev-admin", exact=True))
    admin_row.get_by_role("combobox").select_option("none")
    with super_admin.expect_response(lambda response: response.url.endswith("/api/users/dev-admin/role")) as protected:
        admin_row.get_by_role("button", name="儲存 Super Admin 的角色").click()
    checked(protected.value, 409, "last_super_admin")
    expect(super_admin.get_by_text("至少需要保留一位 Super Admin。")).to_be_visible()

    site.goto(f"{base}/?admin=workspace&workspace={workspace_a}")
    site.get_by_role("button", name="變更名稱").click()
    renamed = name_a + " 改名"
    site.get_by_label("Workspace 名稱", exact=True).fill(renamed)
    with site.expect_response(lambda response: response.url.endswith(workspace_a) and response.request.method == "PATCH") as rename:
        site.get_by_role("button", name="儲存名稱").click()
    assert checked(rename.value, 200)["workspace"]["name"] == renamed
    expect(site.get_by_role("heading", name=renamed, exact=True)).to_be_visible()
    assert api(qa, base, "GET", f"/api/workspaces/{workspace_a}", 200)["name"] == renamed
    cases = [
        workspace_management(site, base, workspace_a, renamed, "drain", evidence),
        workspace_management(site, base, workspace_b, name_b, "cancel", evidence),
    ]
    api(qa, base, "GET", f"/api/workspaces/{workspace_a}", 200)
    site.goto(base + "/?admin=ai")
    expect(site.get_by_text("AI Manager 由 Super Admin 管理。")).to_be_visible()
    super_admin.get_by_role("link", name="AI Manager", exact=True).click()
    expect(super_admin.get_by_role("heading", name="AI Manager", exact=True)).to_be_visible()
    # Probe ADM-4 readiness without exercising or modifying unpublished controls.
    admin_routes = ("/resources", "/agents", f"/options?workspaceId={workspace_a}")
    readiness = {path: super_admin.request.get(base + "/api/admin/ai" + path).status for path in admin_routes}
    return {
        "A1": {"status": "passed", "workspaces": [workspace_a, workspace_b], "identities": 4},
        "A2": {"status": "zero-impact smoke passed", "cases": cases},
        "ADM4 admin route preflight": readiness,
    }


def wait_for(fetch, matches, label, timeout=65):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = fetch()
        if matches(value):
            return value
        time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for {label}: {value}")


class MCP:
    def __init__(self, request, base, token):
        self.request, self.base, self.sequence = request, base, 0
        self.headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"}
        reply = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "adm4-a2", "version": "1"}})
        self.headers["MCP-Protocol-Version"] = reply["result"]["protocolVersion"]

    def rpc(self, method, params):
        self.sequence += 1
        body = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params}
        response = self.request.post(self.base + "/mcp", headers=self.headers, data=body)
        if response.status == 429:
            time.sleep(1.1)
            response = self.request.post(self.base + "/mcp", headers=self.headers, data=body)
        return checked(response, 200)

    def tool(self, name, arguments, meta=None):
        params = {"name": name, "arguments": arguments}
        if meta is not None:
            params["_meta"] = meta
        return self.rpc("tools/call", params)["result"]

    def call(self, name, arguments, code=None, meta=None):
        result = self.tool(name, arguments, meta)
        data = result.get("structuredContent", {})
        assert result.get("isError", False) == (code is not None), (name, result)
        if code is not None:
            assert data.get("error") == code, (name, result)
        return data


def live_a2(browser, base, admin_key, evidence):
    workspace = "00000000-0000-4000-8000-000000000001"
    fast = "10000000-0000-4000-8000-000000000001"
    slow = "10000000-0000-4000-8000-000000000002"
    path = f"/api/admin/workspaces/{workspace}"
    site = login(browser, base, admin_key, "dev-site-admin", f"?admin=workspace&workspace={workspace}")
    admin = login(browser, base, admin_key, "dev-admin", "?admin=workspaces")
    agent = api(admin, base, "POST", f"/api/workspaces/{workspace}/agent-tokens", 201, {"name": "ADM-4 A2"})
    mcp = MCP(admin.request, base, agent["token"])

    def detail():
        return api(site, base, "GET", path, 200)

    def enqueue(test_id):
        return api(site, base, "POST", f"/api/tests/{test_id}/runs", 202)["id"]

    def status(run_id):
        return api(site, base, "GET", f"/api/runs/{run_id}", 200)["status"]

    def run_case(mode):
        lease = mcp.call("browser_session_open", {"requestId": str(uuid4())})
        ids = {"sessionId": lease["sessionId"], "leaseId": lease["leaseId"]}
        wait_for(lambda: mcp.call("browser_session_status", ids), lambda value: value["state"] == "ready", "browser lease")
        active = enqueue(slow)
        wait_for(lambda: status(active), lambda value: value == "running", "real Worker running")
        queued = [enqueue(slow), enqueue(slow)]
        expect_before = {"queuedRuns": 2, "activeRuns": 1, "externalClaims": 0, "browserLeases": 1,
                         "unreleasedRunSlots": 1, "provisionJobs": 0}
        assert detail()["impact"] == expect_before
        site.reload()
        expect(site.get_by_role("heading", name="封存影響")).to_be_visible()
        site.get_by_role("button", name="封存 Workspace", exact=True).click()
        dialog = site.get_by_role("dialog", name="封存 Workspace")
        dialog.get_by_label("等候結束" if mode == "drain" else "取消並等待回收").check()
        if evidence is not None:
            site.screenshot(path=evidence / f"adm4-a2-{mode}-preview.png")
        with site.expect_response(lambda response: response.url.endswith(f"/{workspace}/archive")) as request:
            dialog.get_by_role("button", name="確認封存").click()
        started = checked(request.value, 202)
        assert started["workspace"]["management"]["state"] == "archiving" and started["impact"]["queuedRuns"] == 0
        assert all(status(run) == "cancelled" for run in queued)
        api(site, base, "POST", f"/api/tests/{slow}/runs", 409, code="workspace_archiving")
        mcp.call("task_claim", {"requestId": str(uuid4())}, "workspace_archiving")
        mcp.call("browser_session_open", {"requestId": str(uuid4())}, "workspace_archiving")
        terminal = "succeeded" if mode == "drain" else "cancelled"
        wait_for(lambda: status(active), lambda value: value == terminal, "running Worker terminal outcome")
        if mode == "drain":
            assert mcp.call("browser_session_status", ids)["state"] == "ready"
            assert detail()["workspace"]["management"]["state"] == "archiving"
            mcp.call("browser_session_close", ids)
        finished = wait_for(detail, lambda value: value["workspace"]["management"]["state"] == "archived", "Docker reclaim")
        assert all(count == 0 for count in finished["impact"].values())
        assert mcp.call("browser_session_status", ids)["reclaimed"] is True
        mcp.call("task_claim", {"requestId": str(uuid4())}, "workspace_archived")
        expect(site.get_by_role("button", name="還原 Workspace")).to_be_visible(timeout=10000)
        site.get_by_role("button", name="還原 Workspace").click()
        with site.expect_response(lambda response: response.url.endswith(f"/{workspace}/restore")) as restored:
            site.get_by_role("dialog", name="還原 Workspace").get_by_role("button", name="確認還原").click()
        assert checked(restored.value, 200)["workspace"]["management"]["state"] == "active"
        assert all(status(run) == "cancelled" for run in queued)
        return {"mode": mode, "before": expect_before, "after": finished["impact"],
                "runId": active, "queuedRunIds": queued, "status": terminal, "browser": ids}

    historical = enqueue(fast)
    wait_for(lambda: status(historical), lambda value: value == "succeeded", "historical Playwright report")
    wait_for(detail, lambda value: value["impact"]["unreleasedRunSlots"] == 0, "historical Worker slot")
    modes = [run_case("drain"), run_case("cancel")]
    after_restore = enqueue(fast)
    wait_for(lambda: status(after_restore), lambda value: value == "succeeded", "restored Worker's new Run")
    report_path = f"/api/runs/{historical}/artifacts/report.html"
    report = site.request.get(base + report_path)
    assert report.status == 200 and "text/html" in report.headers["content-type"] and len(report.body()) > 100
    api(admin, base, "DELETE", f"/api/workspaces/{workspace}/agent-tokens/{agent['agentToken']['id']}", 204)
    denied = admin.request.post(base + "/mcp", headers=mcp.headers,
                                data={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    checked(denied, 401, "unauthorized")
    return {"A2": {"workspaceId": workspace, "cases": modes,
                   "historicalReport": report_path, "newRunId": after_restore, "status": "passed"},
            "A5 MCP interaction": {"browserLease": "ready, draining, and reclaimed",
                                   "revokedTokenHTTP": 401, "model": None}}


def concurrent_post(url, headers, body):
    request = Request(url, data=json.dumps(body).encode(),
                      headers={**headers, "Content-Type": "application/json"}, method="POST")
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, json.load(response)
    except HTTPError as response:
        return response.status, json.load(response)


def author_draft(page, base, workspace, label):
    test = api(page, base, "POST", f"/api/workspaces/{workspace}/tests", 201, {"name": label})
    route = f"/api/tests/{test['id']}"
    session = api(page, base, "POST", route + "/editing-session", 201, {})["session"]
    draft = api(page, base, "GET", route + "/draft", 200)
    assert draft["editingSessionId"] == session["id"]
    return route, {"editingSessionId": session["id"], "revision": draft["revision"]}


def post_author(page, base, route, draft, content):
    return api(page, base, "POST", route + "/messages", 202, {**draft, "content": f"ADM-4 {content}"})["run"]


def live_a3(browser, base, admin_key, evidence):
    root = "/api/admin/ai"
    workspace = "00000000-0000-4000-8000-000000000001"
    fast = "10000000-0000-4000-8000-000000000001"
    slow = "10000000-0000-4000-8000-000000000002"
    admin = login(browser, base, admin_key, "dev-admin", "?admin=ai")
    site = login(browser, base, admin_key, "dev-site-admin", "?admin=workspaces")
    target = create_workspace(site, "ADM-4 resource reassignment")

    def resources():
        return api(admin, base, "GET", root + "/resources", 200)["items"]

    def manager_resource():
        items = [item for item in resources() if item["source"] == "manager"]
        assert len(items) <= 1, "Manager identity duplicated on reconnect"
        return items[0] if items else None

    def online(item):
        return item and item["connection"] == "online" and item["capabilities"]["engines"]

    manager = wait_for(manager_resource, online, "v14 Manager capability report")
    manager_action = f"{root}/resources/{quote(manager['id'], safe='')}/actions"
    token = api(admin, base, "POST", f"/api/workspaces/{workspace}/agent-tokens", 201, {"name": "ADM-4 A3"})
    other = api(admin, base, "POST", f"/api/workspaces/{target}/agent-tokens", 201, {"name": "ADM-4 other"})
    mcp, foreign = MCP(admin.request, base, token["token"]), MCP(admin.request, base, other["token"])
    registered = mcp.rpc("whippet/agent/register", {"engine": "pi", "provider": "opencode",
                         "model": "fixture-model", "skillIds": ["test-author"]})["result"]
    assert registered["challenge"] is None
    lease = mcp.call("browser_session_open", {"requestId": str(uuid4())})
    lease_ids = {key: lease[key] for key in ("sessionId", "leaseId")}
    wait_for(lambda: mcp.call("browser_session_status", lease_ids),
             lambda item: item["state"] == "ready", "MCP browser readiness")
    origin = os.environ["ADM4_BROWSER_ORIGIN"]
    navigation = mcp.tool("browser_navigate", {"url": origin}, meta={"whippet": {**lease_ids, "callId": str(uuid4())}})
    snapshot = mcp.tool("browser_snapshot", {}, meta={"whippet": {**lease_ids, "callId": str(uuid4())}})
    snapshot_result = {"navigation": not navigation.get("isError", False), "snapshot": not snapshot.get("isError", False),
                       "fixtureText": "ADM-4 scoped browser fixture" in json.dumps(snapshot)}
    (evidence / "browser-snapshot.json").write_text(json.dumps({**lease_ids, **snapshot_result}) + "\n")
    assert all(snapshot_result.values()), snapshot_result
    assert foreign.tool("browser_session_status", lease_ids)["isError"] is True

    def run_status(run_id):
        return api(site, base, "GET", f"/api/runs/{run_id}", 200)["status"]

    run = api(site, base, "POST", f"/api/tests/{slow}/runs", 202)["id"]
    wait_for(lambda: run_status(run), lambda status: status == "running", "managed Runner")
    details = api(site, base, "GET", f"/api/workspaces/{workspace}", 200)
    api(site, base, "PATCH", f"/api/workspaces/{workspace}/author-engine", 200,
        {"revision": details["revision"], "authorEngine": "external"})
    route, draft = author_draft(site, base, workspace, "ADM-4 A3 claim")
    external = post_author(site, base, route, draft, "確認固定測試的回應")["id"]
    token_id = f"mcp:{token['agentToken']['id']}"
    token_path = f"{root}/resources/{quote(token_id, safe='')}"
    token_action = token_path + "/actions"
    current = api(admin, base, "GET", token_path, 200)
    paused = api(admin, base, "POST", token_action + "/pause_claim", 200, {"revision": current["revision"]})
    mcp.call("task_claim", {"requestId": str(uuid4())}, "claim_paused")
    resumed = api(admin, base, "POST", token_action + "/resume_claim", 200, {"revision": paused["revision"]})
    claim_args = {"requestId": str(uuid4())}
    cookies = "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in admin.context.cookies())
    with ThreadPoolExecutor(max_workers=2) as pool:
        pause = pool.submit(concurrent_post, base + token_action + "/pause_claim",
                            {"Origin": base, "Cookie": cookies}, {"revision": resumed["revision"]})
        claim = pool.submit(concurrent_post, base + "/mcp", mcp.headers,
                            {"jsonrpc": "2.0", "id": 100, "method": "tools/call",
                             "params": {"name": "task_claim", "arguments": claim_args}})
        pause_http, paused = pause.result()
        claim_http, claim_payload = claim.result()
    assert pause_http == 200 and paused["control"] == "paused" and claim_http == 200
    race = claim_payload["result"]
    if race.get("isError"):
        assert race["structuredContent"]["error"] == "claim_paused"
        winner = "pause"
        resumed = api(admin, base, "POST", token_action + "/resume_claim", 200, {"revision": paused["revision"]})
        claim_args = {"requestId": str(uuid4())}
        active = mcp.call("task_claim", claim_args)["task"]
        paused = api(admin, base, "POST", token_action + "/pause_claim", 200, {"revision": resumed["revision"]})
    else:
        winner = "claim"
        active = race["structuredContent"]["task"]
    assert active["runId"] == external
    assert mcp.call("task_claim", claim_args)["task"]["attemptId"] == active["attemptId"]
    claim_ids = {key: active[key] for key in ("runId", "attemptId", "leaseId")}
    mcp.call("task_heartbeat", claim_ids)
    assert foreign.tool("task_heartbeat", claim_ids)["isError"] is True
    mcp.call("task_claim", {"requestId": str(uuid4())}, "claim_paused")
    api(admin, base, "POST", token_action + "/reissue_access", 409,
        {"revision": paused["revision"], "workspaceId": target, "requestId": str(uuid4())}, "resource_busy")

    inventory = {item["id"]: item for item in resources()}
    managed, external_resource = inventory[manager["id"]], inventory[token_id]
    assert {"mcp_interactive", "mcp_claim"}.issubset(external_resource["capabilities"]["modes"])
    assert external_resource["capacity"] == {"total": 1, "occupied": 1, "available": 0}
    assert external_resource["interactiveAt"] is not None and external_resource["claimAt"] is not None
    assert [item["runId"] for item in external_resource["attempts"]] == [external]
    assert managed["capacity"]["occupied"] == 2
    reassigned = api(admin, base, "POST", manager_action + "/assign", 200,
                     {"revision": managed["revision"], "workspaceIds": [target]})
    assert reassigned["workspaceIds"] == [target]
    assert [item["workspaceId"] for item in reassigned["attempts"]] == [workspace]
    assert [item["workspaceId"] for item in reassigned["browserLeases"]] == [workspace]
    awaiting = api(site, base, "POST", f"/api/tests/{fast}/runs", 202)["id"]
    result = {"message": "ADM-4 接單完成", "requestValidation": False}
    mcp.call("task_submit", {**claim_ids, "submitId": str(uuid4()), "output": result})
    mcp.call("browser_session_close", lease_ids)
    reclaimed = wait_for(lambda: mcp.call("browser_session_status", lease_ids), lambda item: item["reclaimed"],
                         "MCP browser reclaim")
    wait_for(lambda: run_status(run), lambda status: status == "succeeded", "original assigned Run")
    drained = wait_for(manager_resource, lambda item: item and item["capacity"]["occupied"] == 0, "Manager reclaim")
    assert run_status(awaiting) == "queued"
    api(admin, base, "POST", manager_action + "/assign", 200,
        {"revision": drained["revision"], "workspaceIds": None})
    wait_for(lambda: run_status(awaiting), lambda status: status == "succeeded", "new authorized Run")
    wait_for(manager_resource, lambda item: item and item["capacity"]["occupied"] == 0, "final Manager reclaim")

    os.kill(int(os.environ["ADM4_MANAGER_PID"]), signal.SIGTERM)
    wait_for(manager_resource, lambda item: item and item["connection"] == "offline", "Manager disconnect")
    manager_env = json.loads(os.environ["ADM4_MANAGER_ENV"])
    with (evidence / "manager.log").open("a") as log:
        replacement = subprocess.Popen([os.environ["ADM4_MANAGER_BIN"]], env=manager_env, stdout=log, stderr=log)
        try:
            reconnected = wait_for(manager_resource, online, "same-ID WSS reconnect")
            assert reconnected["id"] == manager["id"]
        finally:
            replacement.terminate()
            replacement.wait(timeout=20)
    return {"A3": {"manager": manager["id"], "resourceCount": len(inventory), "reconnect": reconnected["connection"],
                   "pauseClaimRaceWinner": winner, "managedRun": run, "claim": claim_ids, "browser": lease_ids,
                   "assignmentFrom": workspace, "assignmentTo": target, "newRun": awaiting},
            "A5 MCP interaction": {"browser": snapshot_result, "foreignLease": "denied",
                                   "foreignClaim": "denied", "reclaimed": reclaimed["reclaimed"]}}


def live_proposal(browser, base, admin_key, evidence):
    path = "/api/admin/ai/agents/proposal"
    admin = login(browser, base, admin_key, "dev-admin", "?admin=ai&view=create")
    site = login(browser, base, admin_key, "dev-site-admin", "?admin=workspaces")
    workspace = create_workspace(site, "ADM-4 提案 Workspace")
    agent_list = f"/api/admin/ai/agents?workspaceId={workspace}"
    token_list = f"/api/workspaces/{workspace}/agent-tokens"
    calls_path = evidence / "intent-fixture/proposal-requests.jsonl"
    key = "adm-synthetic-key-a"

    def model_calls():
        return [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []

    def browser_proposal(instruction, status, code=None):
        admin.get_by_label("描述要建立的 Agent").fill(instruction)
        with admin.expect_response(lambda res: res.url.endswith(path) and res.request.method == "POST") as proposal:
            admin.get_by_role("button", name="請 AI Manager 提案").click()
        response = proposal.value
        assert response.request.post_data_json == {"workspaceId": workspace, "instruction": instruction}
        assert key not in response.text()
        return checked(response, status, code)

    admin.get_by_label("Workspace", exact=True).select_option(workspace)
    api(site, base, "POST", path, 403, {"workspaceId": workspace, "instruction": "ADM-4 請提案"}, "forbidden")
    browser_proposal(f"ADM-4 API key = {key}", 422, "sensitive_input")
    assert model_calls() == [], "role or sensitive input reached the provider"
    browser_proposal("ADM-4 請提案選項外的配置", 422, "proposal_rejected")
    browser_proposal("ADM-4 確認供應商失敗", 503, "proposal_unavailable")
    assert len(model_calls()) == 2

    self_managed = browser_proposal("ADM-4 用 Pi 建立自管 Agent，模型 fixture-model", 200)["proposal"]
    assert self_managed == {"workspaceId": workspace, "name": "ADM-4 自管提案", "mode": "self_managed",
                            "engine": "pi", "provider": "openai-responses", "model": "fixture-model", "profileId": None}
    expect(admin.get_by_label("自管 MCP", exact=True)).to_be_checked()
    expect(admin.get_by_label("執行引擎")).to_have_value("pi")
    expect(admin.get_by_label("模型識別")).to_have_value("fixture-model")
    assert len(model_calls()) == 3

    managed = browser_proposal("ADM-4 建立代管驗收 Agent，使用內建引擎", 200)["proposal"]
    assert managed == {"workspaceId": workspace, "name": "ADM-4 代管提案", "mode": "managed", "engine": "builtin",
                       "provider": "opencode", "model": "fixture-model", "profileId": "adm-builtin"}
    expect(admin.get_by_label("代管設定")).to_have_value("adm-builtin")
    expect(admin.get_by_label("Agent 名稱")).to_have_value(managed["name"])
    revised = "ADM-4 人工確認後的代管 Agent"
    admin.get_by_label("Agent 名稱").fill(revised)
    admin.get_by_role("button", name="檢視設定").click()
    expect(admin.get_by_role("heading", name="確認 Agent 設定")).to_be_visible()
    expect(admin.get_by_text(revised, exact=True)).to_be_visible()
    expect(admin.get_by_label("模型 API Key", exact=True)).to_have_value("")
    assert api(admin, base, "GET", agent_list, 200)["items"] == []
    assert api(admin, base, "GET", token_list, 200)["items"] == []
    assert api(site, base, "GET", f"/api/admin/workspaces/{workspace}", 200)["impact"]["provisionJobs"] == 0
    assert len(model_calls()) == 4
    admin.screenshot(path=evidence / "adm4-agent-proposal-review.png")

    admin.get_by_label("模型 API Key", exact=True).fill(key)
    with admin.expect_response(lambda res: res.url.endswith("/api/admin/ai/agents") and res.request.method == "POST") as created:
        admin.get_by_role("button", name="確認建立 Agent").click()
    response = created.value
    assert key not in response.text()
    request = response.request.post_data_json
    assert request["name"] == revised and request["apiKey"] == key
    agent = checked(response, 201)["agent"]
    ready = wait_for(lambda: api(admin, base, "GET", f"/api/admin/ai/agents/{agent['id']}", 200),
                     lambda item: item["status"] == "ready", "confirmed Agent probe")

    retiring = create_workspace(site, "ADM-4 提案中封存 Workspace")
    cookies = "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in admin.context.cookies())
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(concurrent_post, base + path, {"Origin": base, "Cookie": cookies},
                              {"workspaceId": retiring, "instruction": "ADM-4 代管提案等待封存"})
        wait_for(model_calls, lambda values: len(values) == 5, "proposal provider in flight", timeout=8)
        workspace_path = f"/api/admin/workspaces/{retiring}"
        revision = api(site, base, "GET", workspace_path, 200)["workspace"]["management"]["revision"]
        archive = api(site, base, "POST", workspace_path + "/archive", 200, {"revision": revision, "mode": "cancel"})
        assert archive["workspace"]["management"]["state"] == "archived"
        status, denied = pending.result()
    assert status == 409 and denied["error"]["code"] == "workspace_archived"
    assert model_calls() == [{"toolCount": 0, "store": False, "maxOutputTokens": 1024}] * 5
    return {"A4 natural-language proposal": {"managed": managed, "selfManaged": self_managed,
                                            "confirmedAgent": ready["id"], "probeId": ready["probeId"],
                                            "beforeConfirmation": {"agents": 0, "tokens": 0, "provisionJobs": 0},
                                            "deniedRole": "403 forbidden", "sensitiveInput": "422 sensitive_input",
                                            "sensitiveProviderCalls": 0, "unsupported": "422 proposal_rejected",
                                            "providerFailure": "503 proposal_unavailable",
                                            "archivedWhileInFlight": "409 workspace_archived", "providerCalls": 5}}


def live_ai_smoke(browser, base, admin_key, evidence, case="full"):
    """Exercise managed Agent probes, per-Workspace routing and the Web author entrance."""
    root = "/api/admin/ai"
    admin = login(browser, base, admin_key, "dev-admin", "?admin=ai")
    expect(admin.get_by_role("heading", name="AI Manager", exact=True)).to_be_visible()

    def manager_resource():
        items = api(admin, base, "GET", root + "/resources", 200)["items"]
        managers = [item for item in items if item["source"] == "manager"]
        assert len(managers) <= 1, "duplicate Manager resources"
        return managers[0] if managers else None

    def capacity_ready(resource):
        return resource and resource["connection"] == "online" and (resource["capacity"]["available"] or 0) > 0

    manager = wait_for(manager_resource, capacity_ready, "managed capacity over WSS")
    assert "builtin" in manager["capabilities"]["engines"]
    resource = f"{root}/resources/{quote(manager['id'], safe='')}/actions"
    site = login(browser, base, admin_key, "dev-site-admin", "?admin=workspaces")
    suffix = uuid4().hex[:8]
    first_name, second_name = f"ADM-4 {suffix} A", f"ADM-4 {suffix} B"
    first_workspace = create_workspace(site, first_name)
    second_workspace = create_workspace(site, second_name) if case != "revoked" else None
    fixture_keys = ("adm-synthetic-key-wrong", "adm-synthetic-key-a", "adm-synthetic-key-b")

    def clean_payload(response):
        for key in fixture_keys:
            assert key not in response.text(), "model Key leaked into an HTTP response"
        return response

    def clean_api(page, method, path, status, body=None, code=None):
        response = page.request.fetch(base + path, method=method, headers={"Origin": base}, data=body)
        return checked(clean_payload(response), status, code)

    def create_agent(workspace, name, key, engine="builtin"):
        wait_for(manager_resource, capacity_ready, "capacity for Agent provisioning")
        admin.goto(base + "/?admin=ai&view=create")
        admin.get_by_label("Workspace", exact=True).select_option(workspace)
        admin.get_by_label("Agent 名稱").fill(name)
        admin.get_by_label("代管設定").select_option(f"adm-{engine}")
        admin.get_by_role("button", name="檢視設定").click()
        admin.get_by_label("模型 API Key", exact=True).fill(key)
        with admin.expect_response(lambda response: response.url.endswith(root + "/agents")
                                   and response.request.method == "POST") as created:
            admin.get_by_role("button", name="確認建立 Agent").click()
        response = clean_payload(created.value)
        return checked(response, 201)["agent"], response.request.post_data_json

    def agent_detail(agent):
        return clean_api(admin, "GET", f"{root}/agents/{agent['id']}", 200)

    def select(workspace, agent, status=200, code=None):
        path = f"{root}/workspaces/{workspace}/agent-routing"
        routing = clean_api(admin, "GET", path, 200)
        result = clean_api(admin, "PATCH", path, status,
                           {"revision": routing["revision"], "skillId": "test-author", "agentId": agent["id"]}, code)
        if status == 200:
            assert result["agents"]["test-author"] == agent["id"] and result["revision"] == routing["revision"] + 1

    def open_conversation(workspace, workspace_name, test_name):
        route, draft = author_draft(site, base, workspace, test_name)
        site.goto(base + "/")
        site.get_by_role("button", name="更多功能").click()
        picker = site.get_by_role("group", name="切換 Workspace")
        picker.get_by_role("button", name=workspace_name, exact=True).click()
        rail = site.get_by_role("navigation", name="Workspace 與測試")
        rail.get_by_role("button").filter(has=site.get_by_text(test_name, exact=True)).click()
        return route, draft

    def conversation_send(route, content, status=202, code=None):
        site.get_by_label("測試需求或修改訊息").fill(f"ADM-4 {content}")
        with site.expect_response(lambda response: response.url.endswith(route + "/messages")
                                  and response.request.method == "POST") as created:
            site.get_by_role("button", name="送出訊息", exact=True).click()
        return checked(clean_payload(created.value), status, code)

    def completed(run_id, label):
        terminal = {"succeeded", "failed", "cancelled", "timed_out", "interrupted"}
        run = wait_for(lambda: clean_api(site, "GET", f"/api/runs/{run_id}", 200),
                       lambda item: item["status"] in terminal, label)
        assert run["status"] == "succeeded", (label, run["id"], run["status"], run.get("error"))
        return run

    def create_ready(workspace, engine, key):
        agent, _ = create_agent(workspace, f"ADM-4 {engine} boundary", key, engine)
        return wait_for(lambda: agent_detail(agent), lambda item: item["status"] == "ready", f"{engine} provision")

    def revoke(agent):
        return clean_api(admin, "DELETE", f"{root}/agents/{agent['id']}/model-key", 200,
                         {"confirmed": True, "expectedSecretVersion": agent["modelKey"]["version"]})

    if case == "revoked":
        agent = create_ready(first_workspace, "vercel", fixture_keys[1])
        select(first_workspace, agent)
        disabled = revoke(agent)
        assert disabled["status"] == "disabled" and disabled["reason"] == "key_missing"
        route, _ = open_conversation(first_workspace, first_name, "ADM-4 revoked author admission")
        payload = conversation_send(route, "撤銷後不可使用舊金鑰", 409)
        actual = payload["error"]["code"]
        assert actual == "agent_not_ready", f"HTTP 409 {actual}, expected agent_not_ready"
        return {"A4 revoked selection": {"agentId": agent["id"], "workspaceId": first_workspace,
                                         "http": 409, "expected": "agent_not_ready", "actual": actual}}

    if case == "boundary":
        def write_fixture(name, payload):
            (evidence / name).write_text(json.dumps(payload) + "\n")

        def held_run(agent, workspace):
            (evidence / "broker-held.json").unlink(missing_ok=True)
            (evidence / "broker-release").unlink(missing_ok=True)
            write_fixture("broker-case.json", {"holdAgentId": agent["id"]})
            route, draft = author_draft(site, base, workspace, f"ADM-4 {agent['engine']} live gate")
            queued = post_author(site, base, route, draft, "驗證代管作者執行閘門")
            held_path = evidence / "broker-held.json"
            wait_for(held_path.exists, bool, "active Manager Key request", timeout=25)
            held = json.loads(held_path.read_text())
            assert held["runId"] == queued["id"] and queued["agentId"] == agent["id"]
            return route, draft, held

        def broker_recheck(held, expected):
            request = Request(os.environ["ADM4_BROKER_URL"] + "/fixture/recheck", method="POST",
                              headers={"Content-Type": "application/json"},
                              data=json.dumps({"runId": held["runId"]}).encode())
            context = ssl.create_default_context(cafile=os.environ["ADM4_BROKER_CA"])
            with build_opener(ProxyHandler({}), HTTPSHandler(context=context)).open(request, timeout=6) as reply:
                result = json.load(reply)
            assert result == expected, (held, result, expected)
            return result

        vercel = create_ready(first_workspace, "vercel", fixture_keys[1])
        pi = create_ready(second_workspace, "pi", fixture_keys[2])
        path = f"{root}/agents/{vercel['id']}"
        changed = clean_api(admin, "PUT", path + "/model-key", 200,
                            {"apiKey": fixture_keys[1], "expectedSecretVersion": vercel["modelKey"]["version"]})
        assert changed["modelKey"]["version"] == 2 and changed["reason"] == "verification_required"
        wait_for(manager_resource, capacity_ready, "rotation provision capacity")
        clean_api(admin, "POST", path + "/retry", 202, {"revision": changed["revision"]})
        vercel = wait_for(lambda: agent_detail(vercel), lambda item: item["status"] == "ready", "Vercel v2 probe")
        select(first_workspace, vercel)
        select(second_workspace, pi)
        write_fixture("broker-case.json", {"agentId": vercel["id"], "foreignAgentId": pi["id"]})
        route, draft = author_draft(site, base, first_workspace, "ADM-4 broker scope")
        scoped = post_author(site, base, route, draft, "驗證同一 attempt 的模型 Key")
        completed(scoped["id"], "Vercel with valid version and foreign requests")
        broker = json.loads((evidence / "broker-checks.jsonl").read_text().strip())
        assert broker["runId"] == scoped["id"] and broker["agentId"] == vercel["id"]
        assert broker["foreignAgent"] == {"status": 404, "code": "not_found"}
        assert broker["staleVersion"] == {"status": 409, "code": "credential_unavailable"}
        assert broker["ownKey"] == {"status": 200, "noStore": True}
        assert broker["allowedTool"] == {"status": 200}
        assert broker["deniedTool"] == {"status": 409, "code": "history_unavailable"}

        unavailable = {"status": 409, "code": "credential_unavailable"}
        _, _, live_vercel = held_run(vercel, first_workspace)
        try:
            broker_recheck(live_vercel, {"status": 200})
            assert revoke(vercel)["status"] == "disabled"
            revoked = broker_recheck(live_vercel, unavailable)
        finally:
            (evidence / "broker-release").touch()
        wait_for(lambda: clean_api(site, "GET", f"/api/runs/{live_vercel['runId']}", 200),
                 lambda item: item["status"] == "cancelled", "revoked Vercel attempt")

        route, draft, live_pi = held_run(pi, second_workspace)
        workspace_path = f"/api/admin/workspaces/{second_workspace}"
        try:
            broker_recheck(live_pi, {"status": 200})
            revision = clean_api(site, "GET", workspace_path, 200)["workspace"]["management"]["revision"]
            archived = clean_api(site, "POST", workspace_path + "/archive", 202, {"revision": revision, "mode": "cancel"})
            assert archived["workspace"]["management"]["state"] == "archiving"
            archived_key = broker_recheck(live_pi, unavailable)
        finally:
            (evidence / "broker-release").touch()
        workspace = wait_for(lambda: clean_api(site, "GET", workspace_path, 200),
                             lambda item: item["workspace"]["management"]["state"] == "archived", "Pi reclaim")
        assert all(count == 0 for count in workspace["impact"].values())
        assert clean_api(site, "GET", f"/api/runs/{live_pi['runId']}", 200)["status"] == "cancelled"
        clean_api(site, "POST", route + "/messages", 409, {**draft, "content": "ADM-4 封存後拒絕新派工"}, "workspace_archived")
        return {"A4 active attempt broker": broker,
                "A5 managed cancellation": {"revokedVercel": {**live_vercel, **revoked, "runStatus": "cancelled"},
                                            "archivedPi": {**live_pi, **archived_key, "runStatus": "cancelled",
                                                           "workspaceState": "archived", "impact": workspace["impact"]}}}

    paused = api(admin, base, "POST", resource + "/pause_dispatch", 200, {"revision": manager["revision"]})
    assert paused["control"] == "paused" and paused["capacity"]["available"] == 0
    resumed = api(admin, base, "POST", resource + "/resume_dispatch", 200, {"revision": paused["revision"]})
    assert resumed["id"] == manager["id"] and resumed["control"] == "enabled"

    def author_turn(workspace, workspace_name, agent, expected_marker, label):
        route, draft = open_conversation(workspace, workspace_name, label)
        if agent["engine"] == "pi":
            current = manager_resource()
            hold = clean_api(admin, "POST", resource + "/pause_dispatch", 200, {"revision": current["revision"]})
            assert hold["capacity"]["available"] == 0
        queued = conversation_send(route, f"確認 {label} 能描述 Playwright 驗證方式。")["run"]
        assert queued["agentId"] == agent["id"] and queued["authorEngine"] == "builtin"
        if agent["engine"] == "pi":
            time.sleep(2)
            assert clean_api(site, "GET", f"/api/runs/{queued['id']}", 200)["status"] == "queued"
            clean_api(admin, "POST", resource + "/resume_dispatch", 200, {"revision": hold["revision"]})
        run = completed(queued["id"], label)
        assert run["agentId"] == agent["id"] and run["authorRepliedOnly"] is True
        conversation = clean_api(site, "GET", route + "/conversation", 200)
        assistant = [item["content"] for item in conversation["messages"]
                     if item["role"] == "assistant" and item.get("runId") == run["id"]]
        assert assistant == [expected_marker], (label, run["id"], assistant)
        expect(site.get_by_text(expected_marker, exact=True)).to_be_visible(timeout=18000)
        return {"engine": agent["engine"], "runId": run["id"], "agentId": agent["id"],
                "workspaceId": workspace, "status": run["status"], "marker": expected_marker}, route, draft

    first, original = create_agent(first_workspace, "ADM-4 Agent A", fixture_keys[0])
    failed = wait_for(lambda: agent_detail(first), lambda item: item["status"] == "failed", "invalid Key probe")
    assert failed["reason"] == "provider_auth_failed"
    replay = clean_payload(admin.request.post(base + root + "/agents", headers={"Origin": base}, data=original))
    replayed = checked(replay, 200)["agent"]
    assert (replayed["id"], replayed["probeId"], replayed["reason"]) == (first["id"], first["probeId"], failed["reason"])
    mismatch = clean_payload(admin.request.post(base + root + "/agents", headers={"Origin": base},
                                                data={**original, "apiKey": fixture_keys[1]}))
    checked(mismatch, 409, "idempotency_conflict")
    select(first_workspace, first, 409, "agent_not_ready")
    second, _ = create_agent(second_workspace, "ADM-4 Agent B", fixture_keys[2])
    ready_b = wait_for(lambda: agent_detail(second), lambda item: item["status"] == "ready", "Agent B probe")
    select(first_workspace, second, 404, "not_found")
    select(second_workspace, ready_b)
    b_run, _, _ = author_turn(second_workspace, second_name, ready_b, "Agent B", "ADM-4 Builtin B")
    assert agent_detail(first)["status"] == "failed"

    admin.goto(f"{base}/?admin=ai&view=agent&id={first['id']}")
    admin.get_by_role("button", name="輪替模型金鑰").click()
    dialog = admin.get_by_role("dialog", name="輪替模型金鑰")
    dialog.get_by_label("新的模型 API Key").fill(fixture_keys[1])
    with admin.expect_response(lambda response: response.url.endswith("/model-key")) as rotated:
        dialog.get_by_role("button", name="儲存新金鑰").click()
    updated = checked(clean_payload(rotated.value), 200)
    assert updated["reason"] == "verification_required"
    assert updated["modelKey"]["version"] == failed["modelKey"]["version"] + 1
    wait_for(manager_resource, capacity_ready, "capacity for Agent A retry")
    with admin.expect_response(lambda response: response.url.endswith(f"/agents/{first['id']}/retry")) as retried:
        admin.get_by_role("button", name="重新驗證").click()
    checked(clean_payload(retried.value), 202)
    ready_a = wait_for(lambda: agent_detail(first), lambda item: item["status"] == "ready", "Agent A retry")
    assert agent_detail(second)["verifiedAt"] == ready_b["verifiedAt"]
    if evidence is not None:
        admin.screenshot(path=evidence / "adm4-agent-rotation.png")
    select(first_workspace, ready_a)
    a_run, route, draft = author_turn(first_workspace, first_name, ready_a, "Agent A", "ADM-4 Builtin A")

    # The provided model fixture replies in chat. Save a separate offline spec to exercise formal validation.
    script = """import { test, expect } from '@playwright/test';
test('ADM-4 actual formal validation', async ({ page }) => {
  await page.setContent('<h1>ADM-4 formal validation</h1>');
  await expect(page.getByRole('heading')).toHaveText('ADM-4 formal validation');
});"""
    saved = clean_api(site, "PUT", route + "/draft", 200, {**draft, "script": script})
    saved_revision = {**draft, "revision": saved["revision"]}
    validation = clean_api(site, "POST", route + "/draft/validate", 202, saved_revision)
    validation_run = completed(validation["id"], "formal Playwright validation")
    assert validation_run["kind"] == "validation" and "agentId" not in validation_run
    report_path = f"/api/runs/{validation_run['id']}/artifacts/report.html"
    report = clean_payload(site.request.get(base + report_path))
    assert report.status == 200 and "text/html" in report.headers["content-type"] and len(report.body()) > 100
    publish = {**saved_revision, "summaryRunId": str(uuid4())}
    clean_api(site, "POST", route + "/publish", 400, {**publish, "confirmed": False}, "invalid_request")
    clean_api(site, "POST", route + "/publish", 409, {**publish, "confirmed": True}, "conflict")

    adapter_runs = []
    for engine, workspace, name, key, marker in (
            ("vercel", second_workspace, second_name, fixture_keys[2], "Agent B"),
            ("pi", first_workspace, first_name, fixture_keys[1], "Agent A")):
        adapter, _ = create_agent(workspace, f"ADM-4 {engine} Agent", key, engine)
        ready = wait_for(lambda: agent_detail(adapter), lambda item: item["status"] == "ready", f"{engine} probe")
        select(workspace, ready)
        record, _, _ = author_turn(workspace, name, ready, marker, f"ADM-4 {engine} author")
        adapter_runs.append({**record, "probeId": ready["probeId"]})

    pi = adapter_runs[-1]
    wait_for(manager_resource, lambda item: item and item["capacity"]["occupied"] == 0, "author slots reclaimed")
    route, draft = open_conversation(first_workspace, first_name, "ADM-4 archived author admission")
    workspace_path = f"/api/admin/workspaces/{first_workspace}"
    revision = clean_api(site, "GET", workspace_path, 200)["workspace"]["management"]["revision"]
    archived = clean_api(site, "POST", workspace_path + "/archive", 200, {"revision": revision, "mode": "cancel"})
    assert archived["workspace"]["management"]["state"] == "archived"
    clean_api(site, "POST", route + "/messages", 409,
              {**draft, "content": "ADM-4 封存後不可建立新作者 Run"}, "workspace_archived")
    vercel = agent_detail({"id": adapter_runs[0]["agentId"]})
    revoked = revoke(vercel)
    assert revoked["status"] == "disabled" and revoked["reason"] == "key_missing" and not revoked["modelKey"]["configured"]
    route, draft = open_conversation(second_workspace, second_name, "ADM-4 revoked author admission")
    denied = conversation_send(route, "撤銷後不可使用舊金鑰", 409)["error"]["code"]
    assert denied in ("agent_not_ready", "credential_unavailable")

    return {"A3 Manager control": {"id": manager["id"], "pause": paused["control"], "resume": resumed["control"]},
            "A4 managed probes": {"provider": "opencode synthetic responses", "firstFailure": failed["reason"],
                                  "failedProbeId": failed["probeId"], "replaySameProbe": True,
                                  "agentA": {key: ready_a[key] for key in ("id", "probeId", "status", "modelKey")},
                                  "agentB": {key: ready_b[key] for key in ("id", "probeId", "status", "modelKey")},
                                  "runtimeKeyMarkers": [b_run, a_run]},
            "A5 managed author": {"runs": [b_run, a_run, *adapter_runs], "formalValidationRun": validation_run["id"],
                                  "formalReport": report_path, "publishUnconfirmedHTTP": 400, "publishMissingSummaryHTTP": 409,
                                  "workspaceArchived": first_workspace, "pausedPiAgent": pi["agentId"],
                                  "revokedAgent": revoked["id"], "revokedAuthorExpectedCode": "agent_not_ready",
                                  "revokedAuthorActualCode": denied}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--evidence-dir", type=Path)
    stages = parser.add_mutually_exclusive_group()
    stages.add_argument("--live-a2", action="store_true", help="use the seeded Docker scenario from adm4-local.py")
    stages.add_argument("--live-ai", action="store_true", help="check Agent proposals, probes and managed authors")
    stages.add_argument("--live-a3", action="store_true", help="verify WSS, MCP and resource concurrency")
    parser.add_argument("--managed-case", choices=("full", "boundary", "revoked", "proposal"), default="full")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "::1", "localhost"):
        parser.error("use a loopback URL for the isolated smoke environment")
    key = os.environ.get("ADM_SMOKE_ADMIN_KEY")
    if not key:
        parser.error("set ADM_SMOKE_ADMIN_KEY to the isolated Server's development key")
    evidence = args.evidence_dir
    if evidence is not None:
        evidence.mkdir(parents=True, exist_ok=True)
    if (args.live_a3 or args.managed_case in ("boundary", "proposal")) and evidence is None:
        parser.error("resource, Key boundary and proposal checks require an evidence directory")

    with sync_playwright() as playwright:
        executable = str(args.browser_executable) if args.browser_executable else None
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        try:
            scenario = smoke
            name = "adm1-ui-smoke.json"
            if args.live_a2:
                scenario, name = live_a2, "adm4-a2-live.json"
            elif args.live_ai:
                scenario = live_proposal if args.managed_case == "proposal" else partial(live_ai_smoke, case=args.managed_case)
                name = f"adm4-ai-{args.managed_case}.json"
            elif args.live_a3:
                scenario, name = live_a3, "adm4-a3-live.json"
            result = scenario(browser, base, key, evidence)
        finally:
            browser.close()
    report = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if evidence is not None:
        (evidence / name).write_text(report, encoding="utf-8")
    print(report, end="")
    if args.live_ai and args.managed_case == "full":
        managed = result["A5 managed author"]
        assert managed["revokedAuthorActualCode"] == managed["revokedAuthorExpectedCode"]


if __name__ == "__main__":
    main()
