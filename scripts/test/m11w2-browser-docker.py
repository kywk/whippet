"""Opt-in M11 Wave 2 browser E2E. PM supplies isolated binaries, image and DB.

Runs one real HTTP -> MCP -> Server -> Manager -> Docker -> Worker path.
It never reads a deployment env file or prints HTTP bodies, credentials or logs.
The confirmed Workspace is a fixture in this run's disposable schema; this
does not verify the UI configuration/confirmation flow.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


SITE_JS = r"""
const http = require('node:http');
let clicks = 0;
const page = '<!doctype html><title>Whippet M11W2 fixture</title>' +
  '<h1>Whippet M11W2 fixture</h1><form method="post" action="/clicked">' +
  '<input id="note" name="note"><button id="go" type="submit">Go</button></form>';
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(page); return;
  }
  if (req.method === 'POST' && req.url === '/clicked') {
    req.resume(); req.on('end', () => {
      clicks++;
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      res.end('<!doctype html><title>Whippet M11W2 clicked</title><p>completed</p>');
    }); return;
  }
  if (req.method === 'GET' && req.url === '/count') {
    res.writeHead(200, {'content-type':'text/plain'}); res.end(String(clicks)); return;
  }
  res.writeHead(404); res.end();
}).listen(18080, '0.0.0.0');
"""

COUNT_JS = "fetch('http://127.0.0.1:18080/count').then(r=>r.text()).then(x=>process.stdout.write(x))"
TOOLS = sorted((
    "catalog_search", "catalog_get", "browser_session_open",
    "browser_session_status", "browser_session_close", "browser_navigate",
    "browser_snapshot", "browser_fill", "browser_click",
))
STATES = {"opening", "ready", "closing", "reclaim_pending", "closed"}
FAILURES = {
    "arguments", "docker", "database", "site", "server", "manager",
    "fixture", "token", "mcp", "open", "navigate", "snapshot",
    "fill", "click", "replay", "close", "capacity", "cleanup", "internal",
}


class Failure(Exception):
    def __init__(self, code):
        self.code = code if code in FAILURES else "internal"


def require(condition, code):
    if not condition:
        raise Failure(code)


def local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-binary", required=True)
    parser.add_argument("--manager-binary", required=True)
    parser.add_argument("--worker-image", required=True)
    parser.add_argument("--postgres-container", required=True,
                        help="Fresh isolated container named whippet-m11w2-qa-pg-<unique>")
    parser.add_argument("--postgres-port", required=True, type=int,
                        help="Its 5432 port published only on host 127.0.0.1")
    parser.add_argument("--docker-host", default="",
                        help="Local unix socket; omitted uses current Docker context")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    checks = {}
    stage = "arguments"
    server = manager = None
    token = None
    lease = None
    manager_id = None
    site_name = "whippet-m11w2-qa-site-" + uuid.uuid4().hex
    schema = "m11w2_browser_" + uuid.uuid4().hex
    schema_created = site_created = False
    owned_tmp = None
    docker_bin = shutil.which("docker")
    process_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    docker_env = {"PATH": process_path}
    docker_host = args.docker_host

    def docker(*command, input_bytes=None, capture=False):
        completed = subprocess.run(
            [docker_bin, *command], input=input_bytes, env=docker_env,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=25, check=False,
        )
        return completed.returncode, completed.stdout if capture else b""

    def sql(statement):
        code, _ = docker("exec", "-i", args.postgres_container, "psql", "-X", "-q",
                         "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
                         input_bytes=statement.encode())
        require(code == 0, "database")

    def sql_number(statement):
        code, output = docker("exec", "-i", args.postgres_container, "psql", "-X", "-A", "-t",
                              "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
                              capture=True, input_bytes=statement.encode())
        require(code == 0 and output.strip().isdigit(), "database")
        return int(output.strip())

    def check(name, condition, failure):
        checks[name] = bool(condition)
        require(condition, failure)

    try:
        if docker_bin and not docker_host:
            context = subprocess.run(
                [docker_bin, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                env={"PATH": process_path, "HOME": pwd.getpwuid(os.getuid()).pw_dir},
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=False,
            )
            docker_host = context.stdout.decode().strip() if context.returncode == 0 else ""
        check("local_docker_socket", docker_host.startswith("unix://")
              and Path(docker_host.removeprefix("unix://")).is_socket(), "arguments")
        docker_env["DOCKER_HOST"] = docker_host
        check("inputs", bool(
            docker_bin and Path(args.server_binary).is_file()
            and Path(args.manager_binary).is_file()
            and args.worker_image and args.postgres_port > 0
            and args.postgres_container.startswith("whippet-m11w2-qa-pg-")
        ), "arguments")
        stage = "docker"
        code, _ = docker("image", "inspect", args.worker_image)
        check("worker_image_present", code == 0, "docker")
        code, raw = docker("inspect", "--format", "{{json .NetworkSettings.Ports}}",
                           args.postgres_container, capture=True)
        require(code == 0, "database")
        ports = json.loads(raw)
        mappings = ports.get("5432/tcp") or []
        check("postgres_loopback_only", bool(mappings) and all(
            x.get("HostIp") == "127.0.0.1" and x.get("HostPort") == str(args.postgres_port)
            for x in mappings), "database")

        stage = "database"
        sql("CREATE SCHEMA " + schema + ";")
        schema_created = True
        checks["fresh_schema"] = True

        owned_tmp = tempfile.TemporaryDirectory(prefix="whippet-m11w2-browser-")
        owned = owned_tmp.name
        owned_dir = Path(owned)
        artifacts = owned_dir / "artifacts"
        work = owned_dir / "manager-work"
        artifacts.mkdir(mode=0o700)
        work.mkdir(mode=0o700)
        manager_id = "m11w2-qa-" + uuid.uuid4().hex
        server_port = local_port()
        base = f"http://127.0.0.1:{server_port}"
        manager_key = secrets.token_urlsafe(48)
        admin_key = secrets.token_urlsafe(48)

        stage = "site"
        code, _ = docker("run", "--detach", "--pull=never", "--network=bridge",
                         "--name", site_name, "--label", "whippet.qa=m11w2",
                         "--read-only", args.worker_image, "node", "-e", SITE_JS)
        check("site_container_created", code == 0, "site")
        site_created = True
        code, raw = docker("inspect", "--format",
                           "{{json .NetworkSettings.Networks}}", site_name, capture=True)
        networks = json.loads(raw) if code == 0 else {}
        site_ip = networks.get("bridge", {}).get("IPAddress", "")
        check("site_private_bridge", site_ip.startswith("172.") or site_ip.startswith("192.168.")
              or site_ip.startswith("10."), "site")
        site_origin = f"http://{site_ip}:18080"

        def http(path, method="GET", body=None, headers=None):
            data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
            request = urllib.request.Request(base + path, data=data, method=method)
            request.add_header("Content-Type", "application/json")
            for key, value in (headers or {}).items():
                request.add_header(key, value)
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    payload = response.read(1 << 20)
                    return response.status, json.loads(payload) if payload else None
            except urllib.error.HTTPError as error:
                error.close()  # Never read or print error HTTP bodies.
                return error.code, None

        stage = "server"
        server_env = {
            "PATH": process_path,
            "DATABASE_URL": (
                f"postgres://postgres@127.0.0.1:{args.postgres_port}/postgres"
                f"?sslmode=disable&search_path={schema}"
            ),
            "MANAGER_TOKEN": manager_key,
            "WHIPPET_ADMIN_TOKEN": admin_key,
            "WHIPPET_PUBLIC_ORIGIN": base,
            "WHIPPET_BIND_HOST": "127.0.0.1",
            "PORT": str(server_port),
            "ARTIFACT_DIR": str(artifacts),
            "WHIPPET_TOOL_REGISTRY_PATH": str(root / "contracts/tools/registry.json"),
            "WHIPPET_SKILLS_PATH": str(root / "runtimes/worker/skills"),
        }
        server = subprocess.Popen([args.server_binary], cwd=root, env=server_env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready = False
        for _ in range(100):
            if server.poll() is not None:
                break
            try:
                ready = http("/readyz")[0] == 200
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            if ready:
                break
            time.sleep(0.1)
        check("server_ready", ready, "server")

        stage = "manager"
        manager_env = {
            "PATH": process_path,
            "DOCKER_HOST": docker_host,
            "SERVER_URL": base,
            "MANAGER_TOKEN": manager_key,
            "MANAGER_ID": manager_id,
            "WORKER_IMAGE": args.worker_image,
            "WORK_DIR": str(work),
            "MAX_WORKERS": "1",
            "WHIPPET_TOOL_REGISTRY_PATH": str(root / "contracts/tools/registry.json"),
        }
        manager = subprocess.Popen([args.manager_binary], cwd=root, env=manager_env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        check("manager_started", manager.poll() is None, "manager")
        manager_attached = False
        for _ in range(100):
            if manager.poll() is not None:
                break
            manager_attached = sql_number("SELECT count(*) FROM " + schema + ".managers WHERE id='" +
                                          manager_id + "';") == 1
            if manager_attached:
                break
            time.sleep(0.1)
        check("manager_registered", manager_attached, "manager")

        stage = "fixture"
        status, workspace = http("/api/workspaces", "POST", {"name": "M11W2 isolated QA"},
                                 {"X-Whippet-Admin-Token": admin_key, "Origin": base})
        workspace_id = workspace.get("id") if isinstance(workspace, dict) else None
        check("workspace_created", status == 201 and bool(workspace_id), "fixture")
        config = {
            "name": "M11W2 isolated QA", "purpose": "Anonymous browser lease QA",
            "backgroundSummary": "Disposable in-memory synthetic page",
            "targets": [{"name": "fixture", "purpose": "browser QA", "origin": site_origin}],
            "dependencies": [], "excludedOrigins": [], "exclusions": "",
            "loginRoles": [], "defaultTestUrl": site_origin, "timeoutMs": 60000,
        }
        config_sql = json.dumps(config, separators=(",", ":")).replace("'", "''")
        sql("UPDATE " + schema + ".workspaces SET canonical_config='" + config_sql +
            "'::jsonb,lifecycle='active',scope_status='confirmed',"
            "authorization_revision=authorization_revision+1 WHERE id='" +
            workspace_id + "'::uuid;")
        checks["confirmed_workspace_test_fixture"] = True
        status, scoped = http(f"/api/workspaces/{workspace_id}", headers={
            "X-Whippet-Admin-Token": admin_key,
        })
        check("fixture_scope_active", status == 200 and isinstance(scoped, dict)
              and scoped.get("lifecycle") == "active"
              and scoped.get("scopeStatus") == "confirmed", "fixture")

        stage = "token"
        token_path = f"/api/workspaces/{workspace_id}/agent-tokens"
        status, created = http(token_path, "POST", {"name": "M11W2 browser QA"},
                               {"X-Whippet-Admin-Token": admin_key, "Origin": base})
        token = created.get("token") if isinstance(created, dict) else None
        check("agent_token_created", status == 201 and bool(token), "token")

        sequence = 0

        def mcp(method, params):
            nonlocal sequence
            sequence += 1
            payload = {
                "jsonrpc": "2.0", "id": sequence, "method": method, "params": params,
            }
            headers = {"Authorization": "Bearer " + token,
                       "Accept": "application/json, text/event-stream"}
            for _ in range(25):
                status, response = http("/mcp", "POST", payload, headers)
                if status != 429:
                    return status, response
                time.sleep(1.05)
            return 429, None

        def call(name, arguments, identity=None, failure="mcp"):
            params = {"name": name, "arguments": arguments}
            if identity is not None:
                params["_meta"] = {"whippet": identity}
            status, response = mcp("tools/call", params)
            result = response.get("result") if isinstance(response, dict) else None
            require(status == 200 and isinstance(result, dict)
                    and result.get("isError") is not True
                    and isinstance(result.get("structuredContent"), dict), failure)
            return result["structuredContent"]

        stage = "mcp"
        status, initialized = mcp("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "m11w2-qa", "version": "1"},
        })
        check("mcp_initialized", status == 200 and isinstance(initialized, dict)
              and "result" in initialized, "mcp")
        status, listed = mcp("tools/list", {})
        names = sorted(tool.get("name") for tool in
                       (listed or {}).get("result", {}).get("tools", []))
        check("exact_wave2_tools", status == 200 and names == TOOLS, "mcp")

        def state_result(value, failure):
            require(isinstance(value, dict)
                    and set(value) == {"sessionId", "leaseId", "state", "reclaimed"}
                    and isinstance(value["reclaimed"], bool)
                    and value["state"] in STATES
                    and all(isinstance(value[k], str) for k in ("sessionId", "leaseId")), failure)
            return value

        def wait_state(current, wanted, failure):
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                current = state_result(call("browser_session_status", {
                    "sessionId": current["sessionId"], "leaseId": current["leaseId"],
                }, failure=failure), failure)
                if (current["state"], current["reclaimed"]) == wanted:
                    return current
                if current["state"] == "closed" and wanted[0] != "closed":
                    break
                time.sleep(0.25)
            raise Failure(failure)

        stage = "open"
        first_request = str(uuid.uuid4())
        lease = state_result(call("browser_session_open", {"requestId": first_request},
                                  failure="open"), "open")
        check("first_open_not_reclaimed", not lease["reclaimed"], "open")
        lease = wait_state(lease, ("ready", False), "open")
        checks["first_ready"] = True
        same = state_result(call("browser_session_open", {"requestId": first_request},
                                 failure="open"), "open")
        check("request_id_replay_same_lease", same["sessionId"] == lease["sessionId"]
              and same["leaseId"] == lease["leaseId"], "open")

        def browser(name, arguments, call_id=None, failure="mcp"):
            identity = {"sessionId": lease["sessionId"], "leaseId": lease["leaseId"],
                        "callId": call_id or str(uuid.uuid4())}
            return call(name, arguments, identity, failure)

        stage = "navigate"
        nav = browser("browser_navigate", {"url": site_origin}, failure="navigate")
        check("navigate_reached_fixture", "Whippet M11W2 fixture" in json.dumps(nav),
              "navigate")
        stage = "snapshot"
        snapshot = browser("browser_snapshot", {}, failure="snapshot")
        check("snapshot_sees_form", "Whippet M11W2 fixture" in json.dumps(snapshot)
              and "Go" in json.dumps(snapshot), "snapshot")
        stage = "fill"
        browser("browser_fill", {"selector": "#note", "value": "synthetic"},
                failure="fill")
        checks["fill_accepted"] = True
        stage = "click"
        click_id = str(uuid.uuid4())
        first = browser("browser_click", {"selector": "#go"}, click_id, "click")

        def count():
            code, output = docker("exec", site_name, "node", "-e", COUNT_JS,
                                  capture=True)
            require(code == 0 and output.strip().isdigit(), "click")
            return int(output.strip())

        check("first_click_count_one", count() == 1, "click")
        stage = "replay"
        second = browser("browser_click", {"selector": "#go"}, click_id, "replay")
        check("call_id_replay_same_result", second == first, "replay")
        check("call_id_replay_no_second_click", count() == 1, "replay")

        stage = "close"
        closed = state_result(call("browser_session_close", {
            "sessionId": lease["sessionId"], "leaseId": lease["leaseId"],
        }, failure="close"), "close")
        check("close_did_not_fake_reclaim", closed["state"] != "closed"
              or closed["reclaimed"], "close")
        closed = wait_state(closed, ("closed", True), "close")
        checks["docker_reclaimed"] = True
        worker_name = ("whippet-" + hashlib.sha256(manager_id.encode()).hexdigest()[:12]
                       + "-session-" + lease["leaseId"].lower())
        code, _ = docker("inspect", worker_name)
        check("worker_container_absent", code != 0, "close")
        lease = None

        stage = "capacity"
        second_lease = state_result(call("browser_session_open", {
            "requestId": str(uuid.uuid4()),
        }, failure="capacity"), "capacity")
        check("capacity_new_lease", second_lease["sessionId"] != closed["sessionId"]
              and not second_lease["reclaimed"], "capacity")
        lease = wait_state(second_lease, ("ready", False), "capacity")
        checks["capacity_restored"] = True
        state_result(call("browser_session_close", {
            "sessionId": lease["sessionId"], "leaseId": lease["leaseId"],
        }, failure="capacity"), "capacity")
        wait_state(lease, ("closed", True), "capacity")
        checks["second_lease_reclaimed"] = True
        lease = None

    except Failure as error:
        stage = error.code
    except Exception:
        stage = "internal"  # No free-form errors, HTTP bodies or subprocess output.
    finally:
        if lease is not None and token is not None and server is not None and server.poll() is None:
            try:
                call("browser_session_close", {"sessionId": lease["sessionId"],
                                                "leaseId": lease["leaseId"]}, failure="cleanup")
                wait_state(lease, ("closed", True), "cleanup")
            except Exception:
                checks["owned_lease_reclaimed_on_failure"] = False
        for process in (manager, server):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        if lease is not None and manager_id is not None:
            try:
                worker_name = ("whippet-" + hashlib.sha256(manager_id.encode()).hexdigest()[:12]
                               + "-session-" + lease["leaseId"].lower())
                code, raw = docker("inspect", "--format", "{{json .Config.Labels}}",
                                   worker_name, capture=True)
                if code != 0:
                    checks["owned_worker_absent_after_failure"] = True
                else:
                    labels = json.loads(raw)
                    owned_worker = labels.get("whippet.manager.id") == manager_id and \
                        labels.get("whippet.session.id") == lease["sessionId"] and \
                        labels.get("whippet.lease.id") == lease["leaseId"]
                    remove_code, _ = docker("rm", "--force", worker_name) if owned_worker else (1, b"")
                    checks["owned_worker_absent_after_failure"] = owned_worker and remove_code == 0
            except Exception:
                checks["owned_worker_absent_after_failure"] = False
        if site_created:
            try:
                code, _ = docker("rm", "--force", site_name)
                checks["owned_site_removed"] = code == 0
            except Exception:
                checks["owned_site_removed"] = False
        if schema_created:
            try:
                sql("DROP SCHEMA " + schema + " CASCADE;")
                checks["owned_schema_removed"] = True
            except Exception:
                checks["owned_schema_removed"] = False
        if owned_tmp is not None:
            owned_tmp.cleanup()
        passed = bool(checks) and all(checks.values()) and stage == "capacity"
        print(json.dumps({"result": "PASS" if passed else "FAIL",
                          "stage": "complete" if passed else stage,
                          "checks": checks}, sort_keys=True))
        return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
