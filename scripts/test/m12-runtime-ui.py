#!/usr/bin/env python3
"""One M12.2 UI flow against an isolated candidate Server and fresh tmpfs PG.

Requires a prebuilt native Server, existing postgres:16-alpine image, Web npm
dependencies and Python Playwright. No Manager, model, Vault or baseline state.
GET/PATCH 503s are injected at the browser boundary; CAS and profile removal
use the real API/DB. All credentials are synthetic and remain in memory.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import traceback
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parents[2]
SKILLS = ("test-author", "workspace-author", "acceptance-summary", "module-authoring", "usecase-planner")
PROFILE = {"id": "qa-pinned", "engine": "vercel", "provider": "openai-responses",
           "baseURL": "https://provider.example/v1", "model": "synthetic-model",
           "reasoningEffort": "high", "contextWindowTokens": 131072, "contextInputTokens": 32768}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True).strip()


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_http(url, process):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and process.poll() is None:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.1)
    raise RuntimeError("candidate_not_ready")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-binary", type=Path, required=True)
    parser.add_argument("--browser-executable", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(mode=0o700, parents=True)
    checks, writes = {}, []
    stage = "setup"
    pg = "whippet-m12-wave3-pg-" + uuid.uuid4().hex[:10]
    server = web = None
    pg_started = False
    web_port, api_port = free_port(), free_port()
    web_url, api_url = f"http://127.0.0.1:{web_port}", f"http://127.0.0.1:{api_port}"
    admin_key, manager_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks[name] = True

    try:
        image = run("docker", "image", "inspect", "postgres:16-alpine", "--format", "{{.Id}}")
        run("docker", "run", "-d", "--rm", "--pull=never", "--name", pg,
            "--label", "whippet.m12-wave3=true", "--memory", "256m", "--cpus", "1",
            "--tmpfs", "/var/lib/postgresql/data:rw", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
            "-p", "127.0.0.1::5432", image)
        pg_started = True
        pg_port = int(run("docker", "port", pg, "5432/tcp").rsplit(":", 1)[1])
        for _ in range(100):
            result = subprocess.run(["docker", "exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            time.sleep(0.1)
        check("isolated_pg_ready", result.returncode == 0)
        environment = {
            "PATH": os.defpath, "PORT": str(api_port), "WHIPPET_BIND_HOST": "127.0.0.1",
            "DATABASE_URL": f"postgres://postgres@127.0.0.1:{pg_port}/postgres?sslmode=disable",
            "WHIPPET_ADMIN_TOKEN": admin_key, "MANAGER_TOKEN": manager_key,
            "WHIPPET_PUBLIC_ORIGIN": web_url, "ARTIFACT_DIR": str(args.out / "artifacts"),
            "WHIPPET_TOOL_REGISTRY_PATH": str(REPO / "contracts/tools/registry.json"),
            "WHIPPET_SKILLS_PATH": str(REPO / "runtimes/worker/skills"),
            "WHIPPET_AI_RUNTIME_PROFILES_JSON": json.dumps([PROFILE]),
        }

        def start_server():
            process = subprocess.Popen([str(args.server_binary.resolve())], cwd=REPO, env=environment,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_http(api_url + "/readyz", process)
            return process

        server = start_server()
        # Deliberately omit all user VITE/model/secret environment settings.
        web_env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
                   "WHIPPET_API_PROXY_TARGET": api_url}
        web = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(web_port)],
                               cwd=REPO / "apps/web", env=web_env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_http(web_url, web)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.browser_executable.resolve()))
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.set_default_timeout(12000)
            page.on("request", lambda request: writes.append(request.post_data_json)
                    if request.method == "PATCH" and request.url.endswith("/agent-runtime") else None)

            def login():
                nonlocal stage
                flow = stage
                stage = flow + ":open"
                page.goto(web_url)
                page.wait_for_load_state("networkidle")
                stage = flow + ":login"
                page.get_by_label("管理 key（管理 gate 啟用時必填）").fill(admin_key)
                page.get_by_role("button", name="以開發管理員登入", exact=True).click()
                stage = flow + ":workspace"
                page.get_by_role("combobox", name="Workspace", exact=True).wait_for()
                stage = flow + ":settings"
                page.get_by_role("button", name="Workspace 設定", exact=True).click()
                stage = flow + ":tab"
                page.get_by_role("tab", name="正式設定與能力", exact=True).click()
                stage = flow

            stage = "initial_load"
            # Hold exactly the runtime read to observe loading, then inject one
            # unavailable response. All retry and save requests reach the Server.
            held = []
            pattern = "**/api/workspaces/*/agent-runtime"
            page.route(pattern, lambda route: held.append(route), times=1)
            login()
            panel = page.get_by_role("region", name="Agent runtime 設定", exact=True)
            expect(panel.get_by_role("status")).to_have_text("正在讀取 runtime 設定…")
            check("loading_visible", len(held) == 1)
            held[0].fulfill(status=503, json={"error": {"code": "qa_unavailable", "message": "合成載入錯誤"}})
            expect(panel.get_by_role("alert")).to_contain_text("無法讀取 runtime 設定")
            check("load_error_no_fabricated_form", panel.get_by_role("combobox").count() == 0)
            panel.get_by_role("button", name="重新載入 runtime 設定", exact=True).click()
            default = panel.get_by_label("Workspace 預設 profile", exact=True)
            expect(default).to_have_value("builtin")
            page.wait_for_load_state("networkidle")
            workspace_id = page.get_by_role("combobox", name="Workspace", exact=True).input_value()
            path = f"/api/workspaces/{workspace_id}/agent-runtime"
            anonymous = playwright.request.new_context(base_url=web_url)
            check("existing_admin_gate", anonymous.get(path).status == 401)
            anonymous.dispose()

            def read():
                response = context.request.get(web_url + path)
                check("runtime_read_200", response.status == 200)
                return response.json()

            def change(selection):
                value = read()
                response = context.request.patch(web_url + path, data={"revision": value["revision"], **selection}, headers={"Origin": web_url})
                check("concurrent_management_write", response.status == 200)
                return response.json()

            def save(status):
                with page.expect_response(lambda response: response.url.endswith(path) and response.request.method == "PATCH") as response:
                    panel.get_by_role("button", name="儲存 runtime 設定", exact=True).click()
                check(f"save_http_{status}", response.value.status == status)

            initial = read()
            check("server_profile_whitelist", set(default.locator("option").evaluate_all("items => items.map(item => item.value)")) == {"builtin", "vercel", "qa-pinned"})
            check("no_freeform_runtime_inputs", panel.get_by_role("textbox").count() == 0 and panel.locator("input").count() == 0)
            check("builtin_blank_fields_inherit", panel.locator(".runtime-profile-details dd").filter(has_text="沿用主 skill").count() == 18)
            for skill in SKILLS:
                expect(panel.locator(f"#runtime-{skill}")).to_have_value("")
            default.scroll_into_view_if_needed()
            page.screenshot(path=str(args.out / "runtime-initial.png"))

            stage = "save_reread"
            desired = {"profileId": "qa-pinned", "skillProfiles": {
                "test-author": "vercel", "workspace-author": "builtin",
                "module-authoring": "builtin", "usecase-planner": "vercel"}}
            default.select_option(desired["profileId"])
            for skill, profile in desired["skillProfiles"].items():
                panel.locator(f"#runtime-{skill}").select_option(profile)
            summary = panel.locator(".runtime-skill").filter(has=page.locator("#runtime-acceptance-summary"))
            expect(summary).to_contain_text("synthetic-model")
            expect(summary).to_contain_text("openai-responses")
            expect(summary.locator("dd").last).to_have_text("high")
            save(200)
            expect(panel.get_by_role("status").filter(has_text="Runtime 設定已儲存")).to_be_visible()
            persisted = read()
            check("selection_persisted", persisted["selection"] == desired and persisted["revision"] == initial["revision"] + 1)
            check("patch_exact_shape", writes[-1] == {"revision": initial["revision"], **desired})
            check("task_routing_unchanged", context.request.get(web_url + f"/api/workspaces/{workspace_id}").json()["authorEngine"] == "builtin")
            login()
            expect(default).to_have_value("qa-pinned")
            for skill in SKILLS:
                expect(panel.locator(f"#runtime-{skill}")).to_have_value(desired["skillProfiles"].get(skill, ""))
            check("reload_preserves_inherit_override", True)

            stage = "real_cas_conflict"
            default.select_option("builtin")
            concurrent = change({"profileId": "vercel", "skillProfiles": {}})
            before = len(writes)
            save(409)
            review = panel.get_by_label("目前 runtime 設定", exact=True)
            expect(review).to_contain_text("vercel")
            expect(panel.get_by_role("alert")).to_contain_text("本次未儲存")
            expect(default).to_have_value("builtin")
            expect(default).to_be_disabled()
            expect(panel.get_by_role("button", name="儲存 runtime 設定", exact=True)).to_be_disabled()
            feedback = panel.get_by_role("group", name="Runtime 設定需要處理", exact=True)
            expect(feedback).to_be_focused()
            expect(feedback).to_be_in_viewport(ratio=1)
            check("cas_feedback_focused_and_visible", True)
            page.wait_for_load_state("networkidle")
            check("cas_no_silent_retry", len(writes) == before + 1 and read() == concurrent)
            page.screenshot(path=str(args.out / "runtime-cas-conflict.png"))
            panel.get_by_role("button", name="保留我的選擇並繼續編輯", exact=True).click()
            expect(default).to_be_enabled()
            check("review_is_not_a_write", len(writes) == before + 1)
            save(200)
            expect(panel.get_by_role("status").filter(has_text="Runtime 設定已儲存")).to_be_visible()
            after_conflict = read()
            check("explicit_save_uses_current_cas", writes[-1]["revision"] == concurrent["revision"] and after_conflict["selection"]["profileId"] == "builtin")

            stage = "save_error_and_failed_reread"
            default.select_option("vercel")
            page.route(pattern, lambda route: route.fulfill(status=503, json={"error": {"code": "qa_unavailable", "message": "合成儲存錯誤"}}), times=2)
            before = len(writes)
            save(503)
            expect(panel.get_by_role("alert").filter(has_text="最新設定尚未取得")).to_be_visible()
            expect(default).to_have_value("vercel")
            expect(panel.get_by_role("button", name="採用目前設定", exact=True)).to_be_disabled()
            expect(panel.get_by_role("button", name="保留我的選擇並繼續編輯", exact=True)).to_be_disabled()
            check("failed_refresh_blocks_decision", len(writes) == before + 1)
            panel.get_by_role("button", name="重新載入 runtime 設定", exact=True).click()
            expect(panel.get_by_role("alert").filter(has_text="最新設定尚未取得")).to_have_count(0)
            expect(default).to_have_value("vercel")
            panel.get_by_role("button", name="採用目前設定", exact=True).click()
            expect(default).to_have_value("builtin")
            check("save_error_preserves_without_retry", len(writes) == before + 1 and read() == after_conflict)

            stage = "removed_profile"
            change({"profileId": "qa-pinned", "skillProfiles": {"test-author": "qa-pinned"}})
            stop(server)
            environment.pop("WHIPPET_AI_RUNTIME_PROFILES_JSON")
            server = start_server()
            login()
            expect(default).to_have_value("qa-pinned")
            expect(default.locator("option:checked")).to_be_disabled()
            expect(panel.locator("#runtime-test-author")).to_have_value("qa-pinned")
            expect(panel.get_by_text("選擇包含目前不可用的 profile，修正後才能儲存；現有設定未被替換。", exact=True)).to_be_visible()
            expect(panel.get_by_role("button", name="儲存 runtime 設定", exact=True)).to_be_disabled()
            check("removed_profile_not_substituted", read()["selection"] == {"profileId": "qa-pinned", "skillProfiles": {"test-author": "qa-pinned"}})
            default.scroll_into_view_if_needed()
            page.screenshot(path=str(args.out / "runtime-unavailable.png"))
            default.select_option("builtin")
            expect(panel.get_by_role("button", name="儲存 runtime 設定", exact=True)).to_be_disabled()
            panel.locator("#runtime-test-author").select_option("")
            save(200)
            expect(panel.get_by_role("status").filter(has_text="Runtime 設定已儲存")).to_be_visible()
            check("removed_profile_explicit_repair", read()["selection"] == {"profileId": "builtin", "skillProfiles": {}})
            # Check narrow layout in the same flow; do not run a second E2E.
            page.set_viewport_size({"width": 390, "height": 844})
            page.get_by_role("button", name="提案與登入資料", exact=True).click()
            page.get_by_role("tab", name="正式設定與能力", exact=True).click()
            default.scroll_into_view_if_needed()
            check("narrow_layout_no_overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            page.screenshot(path=str(args.out / "runtime-narrow.png"))
            browser.close()
        stage = "zero_model_cleanup"
        count = run("docker", "exec", pg, "psql", "-XAt", "-U", "postgres", "-c", "SELECT count(*) FROM runs;")
        check("no_model_or_other_runs", count == "0")
    except Exception as error:
        # Do not print Playwright traces, headers or values from login fields.
        checks["failure_stage"] = stage
        checks["failure_type"] = type(error).__name__
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).resolve() == Path(__file__).resolve()]
        checks["failure_line"] = frames[-1].lineno if frames else None
    finally:
        stop(web)
        stop(server)
        if pg_started:
            subprocess.run(["docker", "rm", "-f", pg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        checks["candidate_processes_stopped"] = (not web or web.poll() is not None) and (not server or server.poll() is not None)
        checks["candidate_container_removed"] = not run("docker", "ps", "-aq", "--filter", "name=^/" + pg + "$")
    result = {"passed": "failure_stage" not in checks and all(value is True for value in checks.values()),
              "checks": checks, "uiPatchCount": len(writes), "modelRequests": 0}
    (args.out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
