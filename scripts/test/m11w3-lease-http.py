"""Isolated Wave 3 external task lease QA over real MCP HTTP.

The PM supplies a fresh PostgreSQL container and a Wave 3 Server binary. This
fixture creates only its own schema and synthetic Workspace/Test data. It does
not exercise the Web UI or claim formal validation succeeded; that full path
has a separate owner. Output contains only fixed check names and booleans.
"""

import argparse
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid


FAILURES = {"arguments", "database", "server", "fixture", "mcp", "claim",
            "ownership", "cancel", "submit", "cas", "expiry", "revoke",
            "cleanup", "internal"}


class Failure(Exception):
    def __init__(self, stage):
        self.stage = stage if stage in FAILURES else "internal"


def require(value, stage):
    if not value:
        raise Failure(stage)


def free_port():
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        if port not in (19287, 19587):
            return port


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-binary", required=True)
    parser.add_argument("--postgres-container", required=True)
    parser.add_argument("--postgres-port", required=True, type=int)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    stage = "arguments"
    checks = {}
    server = None
    schema = "m11w3_lease_" + uuid.uuid4().hex
    schema_created = False
    owned_tmp = None
    path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    docker = shutil.which("docker")

    def check(name, condition, failure):
        checks[name] = bool(condition)
        require(condition, failure)

    def docker_cmd(*command, capture=False, input_bytes=None):
        done = subprocess.run([docker, *command], input=input_bytes,
                              env={"PATH": path},
                              stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=30, check=False)
        return done.returncode, done.stdout if capture else b""

    def sql(statement, capture=False):
        command = ("exec", "-i", args.postgres_container, "psql", "-X", "-q",
                   "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1")
        if capture:
            command += ("-A", "-t")
        code, output = docker_cmd(*command, capture=capture,
                                  input_bytes=statement.encode())
        require(code == 0, "database")
        return output.decode().strip() if capture else ""

    try:
        check("isolated_inputs", bool(
            docker and Path(args.server_binary).is_file()
            and args.postgres_container.startswith("whippet-m11w3-qa-pg-")
            and args.postgres_port > 0
        ), "arguments")
        code, raw = docker_cmd("inspect", "--format",
                               "{{json .NetworkSettings.Ports}}",
                               args.postgres_container, capture=True)
        ports = json.loads(raw) if code == 0 else {}
        mappings = ports.get("5432/tcp") or []
        check("postgres_loopback_only", bool(mappings) and all(
            item.get("HostIp") == "127.0.0.1"
            and item.get("HostPort") == str(args.postgres_port)
            for item in mappings), "arguments")

        stage = "database"
        sql("CREATE SCHEMA " + schema + ";")
        schema_created = True
        checks["fresh_schema"] = True
        owned_tmp = tempfile.TemporaryDirectory(prefix="whippet-m11w3-lease-")
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        admin = secrets.token_urlsafe(48)
        manager = secrets.token_urlsafe(48)
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def http(route, method="GET", body=None, headers=None):
            raw_body = None if body is None else json.dumps(
                body, separators=(",", ":")).encode()
            request = urllib.request.Request(base + route, data=raw_body,
                                             method=method)
            request.add_header("Content-Type", "application/json")
            for key, value in (headers or {}).items():
                request.add_header(key, value)
            try:
                response = client.open(request, timeout=35)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                payload = response.read(1 << 20)
                try:
                    parsed = json.loads(payload) if payload else None
                except (ValueError, UnicodeDecodeError):
                    parsed = None
                return response.status, parsed

        def admin_http(route, method="GET", body=None):
            return http(route, method, body,
                        {"X-Whippet-Admin-Token": admin, "Origin": base})

        stage = "server"
        server_env = {
            "PATH": path,
            "DATABASE_URL": (f"postgres://postgres@127.0.0.1:{args.postgres_port}"
                             f"/postgres?sslmode=disable&search_path={schema}"),
            "MANAGER_TOKEN": manager, "WHIPPET_ADMIN_TOKEN": admin,
            "WHIPPET_PUBLIC_ORIGIN": base, "WHIPPET_BIND_HOST": "127.0.0.1",
            "PORT": str(port), "ARTIFACT_DIR": owned_tmp.name,
            "WHIPPET_TOOL_REGISTRY_PATH": str(root / "contracts/tools/registry.json"),
            "WHIPPET_SKILLS_PATH": str(root / "runtimes/worker/skills"),
        }
        server = subprocess.Popen([args.server_binary], cwd=root, env=server_env,
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        ready = False
        for _ in range(100):
            if server.poll() is not None:
                break
            try:
                ready = http("/readyz")[0] == 200
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            if ready:
                break
            time.sleep(0.1)
        check("server_ready", ready, "server")

        stage = "fixture"
        status, workspace = admin_http("/api/workspaces", "POST",
                                       {"name": "M11W3 isolated lease QA"})
        workspace_id = workspace.get("id") if isinstance(workspace, dict) else None
        check("workspace_created", status == 201 and valid_uuid(workspace_id),
              "fixture")
        config = {
            "name": "M11W3 isolated lease QA", "purpose": "Synthetic external author",
            "backgroundSummary": "Disposable task fixture",
            "targets": [{"name": "fixture", "purpose": "task QA",
                         "origin": "http://127.0.0.1:18080"}],
            "dependencies": [], "excludedOrigins": [], "exclusions": "",
            "loginRoles": [], "defaultTestUrl": "http://127.0.0.1:18080",
            "timeoutMs": 60000,
        }
        quoted_config = json.dumps(config, separators=(",", ":")).replace("'", "''")
        sql("UPDATE " + schema + ".workspaces SET canonical_config='" + quoted_config
            + "'::jsonb,lifecycle='active',scope_status='confirmed',"
            "authorization_revision=authorization_revision+1 WHERE id='"
            + workspace_id + "'::uuid;")
        status, detail = admin_http(f"/api/workspaces/{workspace_id}")
        check("workspace_confirmed", status == 200 and isinstance(detail, dict)
              and detail.get("scopeStatus") == "confirmed"
              and detail.get("lifecycle") == "active", "fixture")
        revision = detail.get("revision")
        check("workspace_revision", isinstance(revision, int) and revision > 0,
              "fixture")
        status, detail = admin_http(
            f"/api/workspaces/{workspace_id}/author-engine", "PATCH",
            {"revision": revision, "authorEngine": "external"})
        check("external_engine_set", status == 200 and isinstance(detail, dict)
              and detail.get("authorEngine") == "external"
              and detail.get("revision") == revision + 1, "fixture")

        def new_token(workspace, name):
            status, value = admin_http(
                f"/api/workspaces/{workspace}/agent-tokens", "POST",
                {"name": name})
            require(status == 201 and isinstance(value, dict)
                    and isinstance(value.get("token"), str)
                    and valid_uuid(value.get("agentToken", {}).get("id")),
                    "fixture")
            return value["token"], value["agentToken"]["id"]

        token_a, token_a_id = new_token(workspace_id, "Wave3 A")
        token_b, _ = new_token(workspace_id, "Wave3 B")
        status, other_workspace = admin_http("/api/workspaces", "POST",
                                             {"name": "M11W3 other Workspace"})
        other_id = other_workspace.get("id") if isinstance(other_workspace, dict) else None
        check("other_workspace_created", status == 201 and valid_uuid(other_id),
              "fixture")
        token_c, _ = new_token(other_id, "Wave3 C")

        next_rpc = 0
        last_call = {}
        rpc_lock = threading.Lock()

        def mcp(token, method, params):
            nonlocal next_rpc
            with rpc_lock:
                delay = 1.05 - (time.monotonic() - last_call.get(token, 0))
                if delay > 0:
                    time.sleep(delay)
                last_call[token] = time.monotonic()
                next_rpc += 1
                rpc_id = next_rpc
            payload = {"jsonrpc": "2.0", "id": rpc_id,
                       "method": method, "params": params}
            return http("/mcp", "POST", payload,
                        {"Authorization": "Bearer " + token,
                         "Accept": "application/json, text/event-stream"})

        def call(token, name, arguments):
            return mcp(token, "tools/call", {"name": name,
                                              "arguments": arguments})

        def result(response):
            status, data = response
            value = data.get("result") if isinstance(data, dict) else None
            return (value.get("structuredContent") if status == 200
                    and isinstance(value, dict)
                    and value.get("isError") is not True else None)

        def rejected(response):
            status, data = response
            value = data.get("result") if isinstance(data, dict) else None
            return (status in (400, 401, 403, 404, 409)
                    or isinstance(data, dict) and "error" in data
                    or status == 200 and isinstance(value, dict)
                    and value.get("isError") is True)

        stage = "mcp"
        status, initialized = mcp(token_a, "initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "m11w3-lease-qa", "version": "1"},
        })
        check("mcp_initialized", status == 200 and isinstance(initialized, dict)
              and "result" in initialized, "mcp")
        status, listed = mcp(token_a, "tools/list", {})
        names = {item.get("name") for item in (listed or {}).get("result", {})
                 .get("tools", [])}
        check("four_task_tools_listed", status == 200 and {
            "task_claim", "task_heartbeat", "task_tool_call", "task_submit"
        }.issubset(names) and "publish" not in names, "mcp")

        def new_task(label):
            status, test = admin_http(f"/api/workspaces/{workspace_id}/tests",
                                      "POST", {"name": "Wave3 " + label,
                                               "description": "Synthetic"})
            test_id = test.get("id") if isinstance(test, dict) else None
            require(status == 201 and valid_uuid(test_id), "fixture")
            status, opened = admin_http(f"/api/tests/{test_id}/editing-session",
                                        "POST", {})
            session = opened.get("session") if isinstance(opened, dict) else None
            require(status in (200, 201) and isinstance(session, dict)
                    and valid_uuid(session.get("id")), "fixture")
            status, draft = admin_http(f"/api/tests/{test_id}/draft")
            require(status == 200 and isinstance(draft, dict)
                    and isinstance(draft.get("revision"), int), "fixture")
            status, submitted = admin_http(f"/api/tests/{test_id}/messages",
                                           "POST", {
                "editingSessionId": session["id"],
                "revision": draft["revision"],
                "content": "請建立合成頁面的可執行 Playwright 腳本。",
            })
            run = submitted.get("run") if isinstance(submitted, dict) else None
            require(status == 202 and isinstance(run, dict)
                    and valid_uuid(run.get("id")), "fixture")
            return test_id, session["id"], run["id"], draft

        def claim(token, request_id=None):
            return result(call(token, "task_claim",
                               {"requestId": request_id or str(uuid.uuid4())}))

        def identity(task):
            require(isinstance(task, dict) and all(valid_uuid(task.get(key))
                    for key in ("runId", "attemptId", "leaseId")), "claim")
            return {key: task[key] for key in ("runId", "attemptId", "leaseId")}

        def fresh_draft(test_id):
            status, draft = admin_http(f"/api/tests/{test_id}/draft")
            require(status == 200 and isinstance(draft, dict), "fixture")
            return draft

        def submit(token, ids, submit_id, output):
            return call(token, "task_submit", {**ids, "submitId": submit_id,
                                                "output": output})

        script = ("import { test, expect } from '@playwright/test';\n"
                  "test('synthetic', async ({ page }) => {\n"
                  "  await page.goto('http://127.0.0.1:18080/');\n"
                  "  await expect(page.locator('body')).toBeVisible();\n"
                  "});\n")

        stage = "claim"
        test1, session1, run1, draft1 = new_task("cancel")
        eligible = sql("SELECT count(*) FROM " + schema + ".runs WHERE id='"
                       + run1 + "'::uuid AND author_engine='external'"
                       " AND status='queued' AND kind='author'"
                       " AND author_payload->>'skillId'='test-author';",
                       capture=True)
        check("first_run_claim_eligible", eligible == "1", "claim")
        request1 = str(uuid.uuid4())
        first_response = call(token_a, "task_claim", {"requestId": request1})
        first = result(first_response)
        checks["first_claim_http_200"] = first_response[0] == 200
        first_data = first_response[1]
        first_envelope = first_data.get("result") if isinstance(first_data, dict) else None
        checks["first_claim_rpc_ok"] = (isinstance(first_data, dict)
                                        and "error" not in first_data)
        checks["first_claim_tool_ok"] = (isinstance(first_envelope, dict)
                                         and first_envelope.get("isError") is not True)
        checks["first_claim_has_structured"] = (isinstance(first_envelope, dict)
                                                 and "structuredContent" in first_envelope)
        checks["first_claim_structured"] = isinstance(first, dict)
        task1 = first.get("task") if isinstance(first, dict) else None
        check("first_claim_task_present", isinstance(task1, dict), "claim")
        ids1 = identity(task1)
        check("claim_binds_run", ids1["runId"] == run1
              and isinstance(task1.get("contextBundle"), dict), "claim")
        author = task1["contextBundle"].get("author")
        allowed = author.get("allowedTools") if isinstance(author, dict) else None
        check("claim_restricts_worker_local_tool", isinstance(allowed, list)
              and "read_draft" in allowed and "update_draft" not in allowed,
              "claim")
        repeated = claim(token_a, request1)
        check("claim_request_replay", isinstance(repeated, dict)
              and isinstance(repeated.get("task"), dict)
              and repeated["task"].get("leaseId") == ids1["leaseId"], "claim")
        second = claim(token_b)
        check("competing_token_no_task", isinstance(second, dict)
              and second.get("task") is None, "claim")

        stage = "ownership"
        check("other_token_heartbeat_denied", rejected(call(
            token_b, "task_heartbeat", ids1)), "ownership")
        check("other_workspace_heartbeat_denied", rejected(call(
            token_c, "task_heartbeat", ids1)), "ownership")
        bogus = {**ids1, "leaseId": str(uuid.uuid4())}
        check("wrong_lease_heartbeat_denied", rejected(call(
            token_a, "task_heartbeat", bogus)), "ownership")
        output = {"message": "合成候選", "script": script,
                  "requestValidation": False}
        check("other_token_submit_denied", rejected(submit(
            token_b, ids1, str(uuid.uuid4()), output)), "ownership")
        check("other_workspace_submit_denied", rejected(submit(
            token_c, ids1, str(uuid.uuid4()), output)), "ownership")
        check("wrong_lease_submit_denied", rejected(submit(
            token_a, bogus, str(uuid.uuid4()), output)), "ownership")
        live = result(call(token_a, "task_heartbeat", ids1))
        check("owner_heartbeat_live", isinstance(live, dict)
              and isinstance(live.get("state"), str) and bool(live["state"])
              and isinstance(live.get("expiresAt"), str)
              and isinstance(live.get("deadlineAt"), str), "ownership")
        nested = {**ids1, "callId": str(uuid.uuid4()), "name": "read_draft",
                  "arguments": {}}
        check("other_token_nested_tool_denied", rejected(call(
            token_b, "task_tool_call", nested)), "ownership")
        forbidden = {**nested, "callId": str(uuid.uuid4()),
                     "name": "update_draft", "arguments": {"script": script}}
        check("worker_local_tool_denied", rejected(call(
            token_a, "task_tool_call", forbidden)), "ownership")
        check("owner_read_draft_allowed", result(call(
            token_a, "task_tool_call", nested)) is not None, "ownership")

        stage = "cancel"
        status, _ = admin_http(f"/api/runs/{run1}/cancel", "POST", {})
        check("cancel_accepted", status in (200, 202), "cancel")
        check("cancelled_heartbeat_denied", rejected(call(
            token_a, "task_heartbeat", ids1)), "cancel")
        check("cancelled_submit_denied", rejected(submit(
            token_a, ids1, str(uuid.uuid4()), output)), "cancel")
        after_cancel = fresh_draft(test1)
        check("cancel_preserves_draft", after_cancel.get("revision") == draft1["revision"]
              and after_cancel.get("script") == draft1.get("script"), "cancel")

        stage = "submit"
        test2, _, run2, draft2 = new_task("submit")
        second = claim(token_a)
        task2 = second.get("task") if isinstance(second, dict) else None
        ids2 = identity(task2)
        check("next_task_claimed", ids2["runId"] == run2, "submit")
        poison = {**output, "requestValidation": True,
                  "selfTestPassed": True}
        check("self_report_rejected", rejected(submit(
            token_a, ids2, str(uuid.uuid4()), poison)), "submit")
        check("self_report_no_draft_write", fresh_draft(test2).get("revision")
              == draft2["revision"], "submit")
        submit_id = str(uuid.uuid4())
        good = {**output, "requestValidation": True}
        first_submit = result(submit(token_a, ids2, submit_id, good))
        check("submit_accepted", isinstance(first_submit, dict)
              and isinstance(first_submit.get("appliedRevision"), int)
              and valid_uuid(first_submit.get("validationRunId")), "submit")
        revision2 = first_submit["appliedRevision"]
        check("ai_draft_saved", fresh_draft(test2).get("revision") == revision2
              and fresh_draft(test2).get("scriptOrigin") == "ai", "submit")
        replay = result(submit(token_a, ids2, submit_id, good))
        check("submit_idempotent", replay == first_submit
              and fresh_draft(test2).get("revision") == revision2, "submit")
        changed = {**good, "message": "不同候選"}
        check("submit_same_id_changed_body_denied", rejected(submit(
            token_a, ids2, submit_id, changed)), "submit")
        check("submit_changed_body_no_revision", fresh_draft(test2).get("revision")
              == revision2, "submit")

        stage = "cas"
        test3, session3, run3, draft3 = new_task("CAS")
        third = claim(token_a)
        task3 = third.get("task") if isinstance(third, dict) else None
        ids3 = identity(task3)
        check("cas_task_claimed", ids3["runId"] == run3, "cas")
        manual = "// manual draft wins\n" + script
        status, saved = admin_http(f"/api/tests/{test3}/draft", "PUT", {
            "editingSessionId": session3, "revision": draft3["revision"],
            "script": manual,
        })
        check("manual_cas_write", status == 200 and isinstance(saved, dict)
              and saved.get("revision") == draft3["revision"] + 1, "cas")
        cas_result = result(submit(token_a, ids3, str(uuid.uuid4()), good))
        current = fresh_draft(test3)
        check("stale_submit_keeps_manual", isinstance(cas_result, dict)
              and cas_result.get("appliedRevision") is None
              and cas_result.get("validationRunId") is None
              and current.get("script") == manual
              and current.get("revision") == saved["revision"], "cas")

        stage = "expiry"
        test4, _, run4, draft4 = new_task("expiry")
        fourth = claim(token_a)
        task4 = fourth.get("task") if isinstance(fourth, dict) else None
        ids4 = identity(task4)
        check("expiry_task_claimed", ids4["runId"] == run4, "expiry")
        # The isolated fixture advances only this claim's short deadline. It
        # never changes the product's 120-second lease or author budget.
        # The table/column are fixed by Server migration 023.
        sql("UPDATE " + schema + ".external_author_claims SET expires_at=now()-interval '1 second'"
            " WHERE run_id='" + run4 + "'::uuid AND lease_id='"
            + ids4["leaseId"] + "'::uuid;")
        check("expired_heartbeat_denied", rejected(call(
            token_a, "task_heartbeat", ids4)), "expiry")
        check("expired_submit_denied", rejected(submit(
            token_a, ids4, str(uuid.uuid4()), output)), "expiry")
        check("expired_no_draft_write", fresh_draft(test4).get("revision")
              == draft4["revision"], "expiry")
        expired_converged = False
        for _ in range(80):
            state = sql("SELECT state FROM " + schema
                        + ".external_author_claims WHERE run_id='"
                        + run4 + "'::uuid;", capture=True)
            if state == "timed_out":
                expired_converged = True
                break
            time.sleep(0.25)
        check("expired_claim_converged", expired_converged, "expiry")

        stage = "revoke"
        test5, _, run5, draft5 = new_task("revoke")
        fifth = claim(token_a)
        task5 = fifth.get("task") if isinstance(fifth, dict) else None
        ids5 = identity(task5)
        check("revoke_task_claimed", ids5["runId"] == run5, "revoke")
        status, _ = admin_http(
            f"/api/workspaces/{workspace_id}/agent-tokens/{token_a_id}",
            "DELETE")
        check("token_revoked", status == 204, "revoke")
        check("revoked_heartbeat_denied", rejected(call(
            token_a, "task_heartbeat", ids5)), "revoke")
        check("revoked_submit_denied", rejected(submit(
            token_a, ids5, str(uuid.uuid4()), output)), "revoke")
        check("revoked_no_draft_write", fresh_draft(test5).get("revision")
              == draft5["revision"], "revoke")
        stage = "claim"
        _, _, race_run, _ = new_task("claim race")
        token_d, _ = new_token(workspace_id, "Wave3 D")
        barrier = threading.Barrier(3)
        race_results = {}

        def race_claim(label, token):
            try:
                barrier.wait()
                race_results[label] = claim(token)
            except Exception:
                race_results[label] = None

        race_b = threading.Thread(target=race_claim, args=("b", token_b))
        race_d = threading.Thread(target=race_claim, args=("d", token_d))
        race_b.start()
        race_d.start()
        barrier.wait()
        race_b.join(timeout=40)
        race_d.join(timeout=40)
        tasks = [value.get("task") if isinstance(value, dict) else None
                 for value in race_results.values()]
        check("competing_claim_single_winner", not race_b.is_alive()
              and not race_d.is_alive() and len(tasks) == 2
              and sum(isinstance(value, dict) and value.get("runId") == race_run
                      for value in tasks) == 1
              and sum(value is None for value in tasks) == 1, "claim")
        stage = "complete"
    except Failure as error:
        stage = error.stage
    except Exception:
        stage = "internal"
    finally:
        if server is not None:
            try:
                if server.poll() is None:
                    server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
                checks["owned_server_stopped"] = server.poll() is not None
            except Exception:
                checks["owned_server_stopped"] = False
        if schema_created:
            try:
                sql("DROP SCHEMA " + schema + " CASCADE;")
                checks["owned_schema_removed"] = True
            except Exception:
                checks["owned_schema_removed"] = False
        if owned_tmp is not None:
            try:
                owned_tmp.cleanup()
                checks["owned_temp_removed"] = True
            except Exception:
                checks["owned_temp_removed"] = False
        passed = stage == "complete" and bool(checks) and all(checks.values())
        print(json.dumps({"result": "PASS" if passed else "FAIL",
                          "stage": "complete" if passed else stage,
                          "checks": checks}, sort_keys=True))
        return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
