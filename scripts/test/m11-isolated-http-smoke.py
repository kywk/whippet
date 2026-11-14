"""M11 real HTTP smoke; fresh schema and in-memory synthetic credentials only."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-binary", required=True)
    parser.add_argument("--postgres-container", required=True)
    parser.add_argument("--postgres-port", type=int, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    schema = "m11_http_" + uuid.uuid4().hex
    checks = {}
    process = None
    schema_created = False

    def check(name, condition):
        checks[name] = bool(condition)
        if not condition:
            raise RuntimeError("check_failed")

    def sql(statement):
        subprocess.run(
            ["docker", "exec", args.postgres_container, "psql", "-X", "-U",
             "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    try:
        sql("CREATE SCHEMA " + schema)
        schema_created = True
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        admin_key, manager_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        jar = http.cookiejar.CookieJar()
        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        anonymous = urllib.request.build_opener()

        def request(path, method="GET", body=None, headers=None, client=browser):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data, method=method)
            req.add_header("Content-Type", "application/json")
            for key, value in (headers or {}).items():
                req.add_header(key, value)
            try:
                response = client.open(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read(1 << 20)
                return response.status, json.loads(raw) if raw else None, response.headers

        with tempfile.TemporaryDirectory(prefix="whippet-m11-http-") as artifacts:
            environment = {
                "PATH": os.defpath,
                "DATABASE_URL": f"postgres://postgres@127.0.0.1:{args.postgres_port}/postgres?sslmode=disable&search_path={schema}",
                "MANAGER_TOKEN": manager_key,
                "WHIPPET_ADMIN_TOKEN": admin_key,
                "WHIPPET_PUBLIC_ORIGIN": base,
                "WHIPPET_BIND_HOST": "127.0.0.1",
                "PORT": str(port), "ARTIFACT_DIR": artifacts,
                "WHIPPET_TOOL_REGISTRY_PATH": str(root / "contracts/tools/registry.json"),
                "WHIPPET_SKILLS_PATH": str(root / "runtimes/worker/skills"),
            }
            process = subprocess.Popen(
                [args.server_binary], cwd=root, env=environment,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            ready = False
            for _ in range(100):
                if process.poll() is not None:
                    break
                try:
                    ready = request("/readyz")[0] == 200
                except (urllib.error.URLError, ConnectionError):
                    pass
                if ready:
                    break
                time.sleep(0.1)
            check("ready", ready)
            check("management_requires_auth", request("/api/workspaces", client=anonymous)[0] == 401)
            status, _, headers = request("/api/dev-login", "POST", headers={"X-Whippet-Admin-Token": admin_key})
            check("admin_login", status == 200)
            cookie = headers.get("Set-Cookie", "")
            check("opaque_httponly_cookie", "HttpOnly" in cookie and "SameSite=Strict" in cookie and admin_key not in cookie)
            admin_key = ""
            status, workspaces, _ = request("/api/workspaces")
            check("cookie_management", status == 200 and len(workspaces["items"]) > 0)
            workspace = workspaces["items"][0]["id"]
            path = f"/api/workspaces/{workspace}/agent-tokens"
            status, created, headers = request(path, "POST", {"name": "M11 HTTP smoke"}, {"Origin": base})
            check("create_token_once", status == 201 and headers.get("Cache-Control") == "no-store")
            token, token_id = created["token"], created["agentToken"]["id"]
            status, listed, _ = request(path)
            check("metadata_only", status == 200 and token not in json.dumps(listed))

            sequence = 0

            def mcp(method, params):
                nonlocal sequence
                sequence += 1
                return request("/mcp", "POST", {"jsonrpc": "2.0", "id": sequence, "method": method, "params": params},
                               {"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream"}, anonymous)

            status, initialized, _ = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "m11-smoke", "version": "1"}})
            check("mcp_initialize", status == 200 and "result" in initialized)
            status, tools, _ = mcp("tools/list", {})
            check("exact_m11_tools", status == 200 and sorted(t["name"] for t in tools["result"]["tools"]) == sorted([
                "catalog_get", "catalog_search", "browser_session_open", "browser_session_status",
                "browser_session_close", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
                "task_claim", "task_heartbeat", "task_tool_call", "task_submit",
            ]))
            status, result, _ = mcp("tools/call", {"name": "catalog_search", "arguments": {"query": "", "limit": 5}})
            check("catalog_read", status == 200 and not result["result"].get("isError", False) and "items" in result["result"]["structuredContent"])
            status, resources, _ = mcp("resources/list", {})
            check("skill_resources", status == 200 and len(resources["result"]["resources"]) > 0)
            status, _, _ = request("/api/workspaces", headers={"Authorization": "Bearer " + token})
            check("agent_cannot_use_management", status == 403)
            status, audit, _ = request(f"/api/workspaces/{workspace}/agent-tool-audit?limit=20")
            check("safe_tool_audit", status == 200 and any(i["toolName"] == "catalog_search" for i in audit["items"]) and token not in json.dumps(audit))
            check("revoke", request(path + "/" + token_id, "DELETE", headers={"Origin": base})[0] == 204)
            check("revoked_immediately_denied", mcp("tools/list", {})[0] == 401)
            check("logout", request("/api/dev-logout", "POST", headers={"Origin": base})[0] == 204)
            check("logout_invalidates_cookie", request("/api/workspaces")[0] == 401)
            process.terminate()
            process.wait(timeout=10)
            process = None
    except Exception as error:
        # Deliberately exclude exceptions, bodies, headers, and credential values.
        checks["failure_type"] = type(error).__name__
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if schema_created:
            try:
                sql("DROP SCHEMA " + schema + " CASCADE")
                checks["owned_schema_removed"] = True
            except Exception:
                checks["owned_schema_removed"] = False
        passed = bool(checks) and all(value is True for value in checks.values())
        print(json.dumps({"result": "PASS" if passed else "FAIL", "checks": checks}, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
