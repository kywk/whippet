"""Isolated M11 late-response regression. All /api and /mcp requests are intercepted."""

import argparse
import asyncio
import json
import secrets
from urllib.parse import urlparse

from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright


BASE = "http://127.0.0.1:19487"
WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
TOKEN_ID = "00000000-0000-4000-8000-000000000002"
CONVERSATION_ID = "00000000-0000-4000-8000-000000000003"
NOW = "2026-01-01T00:00:00Z"


async def main(browser_executable):
    workspace = {
        "id": WORKSPACE_ID, "name": "QA", "revision": 1, "sites": [],
        "defaultTestUrl": "", "timeoutMs": 60000, "lifecycle": "active",
        "authorizationRevision": 1, "scopeStatus": "confirmed", "settings": None,
        "conversationId": CONVERSATION_ID, "activeRunId": None,
        "currentProposal": None, "roles": [], "secretsAvailable": False,
        "executionAvailable": False, "unavailableReason": None,
    }
    conversation = {
        "id": CONVERSATION_ID, "workspaceId": WORKSPACE_ID,
        "ownerType": "workspace", "contextRevision": 1,
        "conversationSummary": None, "messages": [], "activeRunId": None,
    }
    # Generated only in process memory; never included in output or screenshots.
    created_tokens = []
    create_started = asyncio.Event()
    release_create = asyncio.Event()
    first_done = asyncio.Event()
    second_done = asyncio.Event()
    unexpected_api = 0
    create_responses = []
    create_request_failures = []

    async def route_request(route):
        nonlocal unexpected_api
        request = route.request
        path = urlparse(request.url).path
        if not (path.startswith("/api/") or path == "/mcp"):
            await route.continue_()
            return

        status, body = 404, {"error": {"code": "not_found", "message": "not found"}}
        if path == "/api/dev-login" and request.method == "POST":
            status, body = 200, {"user": {"id": "qa", "role": "superadmin"}}
        elif path == "/api/workspaces" and request.method == "GET":
            status, body = 200, {"items": [workspace]}
        elif path == f"/api/workspaces/{WORKSPACE_ID}" and request.method == "GET":
            status, body = 200, workspace
        elif path == f"/api/workspaces/{WORKSPACE_ID}/tests" and request.method == "GET":
            status, body = 200, {"items": []}
        elif path == f"/api/workspaces/{WORKSPACE_ID}/conversation" and request.method == "GET":
            status, body = 200, conversation
        elif path == f"/api/workspaces/{WORKSPACE_ID}/agent-tokens":
            if request.method == "GET":
                status, body = 200, {"items": []}
            elif request.method == "POST":
                created_tokens.append(secrets.token_urlsafe(32))
                number = len(created_tokens)
                if number == 1:
                    create_started.set()
                    await release_create.wait()
                status, body = 201, {
                    "token": created_tokens[-1],
                    "agentToken": {
                        "id": TOKEN_ID if number == 1 else "00000000-0000-4000-8000-000000000004",
                        "workspaceId": WORKSPACE_ID,
                        "name": "QA" if number == 1 else "QB", "createdAt": NOW,
                        "revokedAt": None, "lastUsedAt": None,
                    },
                }
        elif path == f"/api/workspaces/{WORKSPACE_ID}/agent-tool-audit" and request.method == "GET":
            status, body = 200, {"items": [], "nextCursor": None}
        else:
            unexpected_api += 1
        try:
            await route.fulfill(status=status, content_type="application/json", body=json.dumps(body))
        finally:
            if path == f"/api/workspaces/{WORKSPACE_ID}/agent-tokens" and request.method == "POST" and len(created_tokens) == 1:
                first_done.set()
            elif path == f"/api/workspaces/{WORKSPACE_ID}/agent-tokens" and request.method == "POST":
                second_done.set()

    async with async_playwright() as playwright:
        launch_options = {"headless": True}
        if browser_executable:
            launch_options["executable_path"] = browser_executable
        browser = await playwright.chromium.launch(**launch_options)
        page = await browser.new_page()
        def observe_response(response):
            if urlparse(response.url).path == f"/api/workspaces/{WORKSPACE_ID}/agent-tokens" and response.request.method == "POST":
                create_responses.append((response.status, response.request.post_data_json.get("name") == "QB", response))
        def observe_failure(request):
            if urlparse(request.url).path == f"/api/workspaces/{WORKSPACE_ID}/agent-tokens" and request.method == "POST":
                create_request_failures.append(request.post_data_json.get("name") == "QB")
        page.on("response", observe_response)
        page.on("requestfailed", observe_failure)
        await page.route("**/*", route_request)
        try:
            await page.goto(BASE, wait_until="networkidle")
            await page.get_by_role("button", name="以開發管理員登入").click()
            await page.get_by_role("button", name="Workspace 設定").click()
            await page.get_by_role("tab", name="正式設定與能力").click()
            await page.get_by_role("button", name="建立 Agent Token").wait_for()
            await page.get_by_label("Token 名稱").fill("QA")
            await page.get_by_role("button", name="建立 Agent Token").click()
            await asyncio.wait_for(create_started.wait(), timeout=5)
            await page.get_by_role("tab", name="登入資料").click()
            await page.get_by_role("tab", name="正式設定與能力").click()
            release_create.set()
            await asyncio.wait_for(first_done.wait(), timeout=5)
            await page.wait_for_timeout(1000)
            late_plain_visible = await page.get_by_label("新建 Agent Token（僅顯示一次）").is_visible()
            await page.get_by_label("Token 名稱").fill("QB")
            await page.get_by_role("button", name="建立 Agent Token").click()
            await asyncio.wait_for(second_done.wait(), timeout=5)
            plain = page.get_by_label("新建 Agent Token（僅顯示一次）")
            try:
                await plain.wait_for(timeout=5000)
                normal_create_visible = len(created_tokens) == 2 and await plain.input_value() == created_tokens[1]
            except PlaywrightTimeoutError:
                normal_create_visible = False
            second_response = next((response for status, is_second, response in create_responses if status == 201 and is_second), None)
            second_body = await second_response.json() if second_response else None
            second_body_shape = isinstance(second_body, dict) and second_body.get("token") == created_tokens[1] and isinstance(second_body.get("agentToken"), dict)
            second_metadata_fields = second_body_shape and all(isinstance(second_body["agentToken"].get(key), str) for key in ("id", "workspaceId", "name", "createdAt")) and all(second_body["agentToken"].get(key) is None for key in ("revokedAt", "lastUsedAt"))
            settings_selected_before_leave = await page.get_by_role("tab", name="正式設定與能力").get_attribute("aria-selected") == "true"
            agent_section_before_leave = await page.locator(".workspace-agent-access").is_visible()
            loading_before_leave = await page.get_by_text("正在讀取 Agent Token 與工具稽核…").is_visible()
            notice_text = await page.locator(".workspace-agent-access .notice").inner_text() if await page.locator(".workspace-agent-access .notice").count() else ""
            notice_code = next((code for code in ("INVALID_RESPONSE", "WORKSPACE_CONFLICT", "NETWORK_ERROR", "REQUEST_TIMEOUT", "INSECURE_TRANSPORT") if code in notice_text), "OTHER" if notice_text else "NONE")
            notice_kind = next((code for text, code in (("API 回應格式不符", "RECORD"), ("API 缺少必要欄位", "STRING"), ("Agent Token 清單含", "TOKEN_METADATA"), ("API 未依契約", "STATUS"), ("API 未回傳 JSON", "NO_JSON")) if text in notice_text), "OTHER" if notice_text else "NONE")
            await page.get_by_role("tab", name="登入資料").click()
            await page.get_by_role("tab", name="正式設定與能力").click()
            normal_leave_cleared = not await plain.is_visible()
            print(f"BROWSER_EXECUTABLE={'EXPLICIT' if browser_executable else 'PLAYWRIGHT_DEFAULT'}")
            print(f"LATE_PLAIN_VISIBLE={str(late_plain_visible).lower()}")
            print(f"NORMAL_CREATE_VISIBLE={str(normal_create_visible).lower()}")
            print(f"NORMAL_LEAVE_CLEARED={str(normal_leave_cleared).lower()}")
            print(f"CREATED_REQUESTS={len(created_tokens)}")
            print(f"SECOND_FULFILLED={str(second_done.is_set()).lower()}")
            print(f"CREATE_RESPONSE_201_COUNT={sum(status == 201 for status, _, _ in create_responses)}")
            print(f"SECOND_RESPONSE_201={str(second_response is not None).lower()}")
            print(f"SECOND_BODY_SHAPE={str(second_body_shape).lower()}")
            print(f"SECOND_METADATA_FIELDS={str(second_metadata_fields).lower()}")
            print(f"CREATE_REQUEST_FAILURES={len(create_request_failures)}")
            print(f"SECOND_REQUEST_FAILED={str(True in create_request_failures).lower()}")
            print(f"FIRST_RESPONSE_201={str(any(status == 201 and not is_second for status, is_second, _ in create_responses)).lower()}")
            print(f"SETTINGS_SELECTED_BEFORE_LEAVE={str(settings_selected_before_leave).lower()}")
            print(f"AGENT_SECTION_BEFORE_LEAVE={str(agent_section_before_leave).lower()}")
            print(f"LOADING_BEFORE_LEAVE={str(loading_before_leave).lower()}")
            print(f"NOTICE_CODE={notice_code}")
            print(f"NOTICE_KIND={notice_kind}")
            print(f"NOTICE_PRESENT={str(await page.locator('.workspace-agent-access .notice').count() > 0).lower()}")
            print(f"UNEXPECTED_API={unexpected_api}")
            passed = not late_plain_visible and normal_create_visible and normal_leave_cleared and unexpected_api == 0
            print(f"M11_TOKEN_UI={'PASS' if passed else 'FAIL'}")
            return 0 if passed else 1
        finally:
            release_create.set()
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser-executable", default=None)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.browser_executable)))
