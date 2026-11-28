#!/usr/bin/env python3
"""Start disposable PostgreSQL, production Web and Server for ADM-4 browser cases."""

import argparse
import base64
from contextlib import ExitStack
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time
from urllib.request import HTTPSHandler, ProxyHandler, build_opener
from uuid import uuid4
from zipfile import ZipFile, is_zipfile


REPO = Path(__file__).resolve().parents[2]
WORKSPACE = "00000000-0000-4000-8000-000000000001"
FIXTURE_KEYS = (b"adm-synthetic-key-a", b"adm-synthetic-key-b", b"adm-synthetic-key-wrong")


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kwargs)


def await_ready(check, description, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.2)
    raise RuntimeError(description)


def ports():
    with socket.socket() as api, socket.socket() as web:
        for endpoint in (api, web):
            endpoint.bind(("127.0.0.1", 0))
        return api.getsockname()[1], web.getsockname()[1]


def dispose_service(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def start(stack, command, env, cwd, output):
    log = stack.enter_context(output.open("w", encoding="utf-8"))
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    stack.callback(dispose_service, process)
    return process


def wait_http(url, process, name, cert=None):
    handlers = [ProxyHandler({})]
    if cert is not None:
        handlers.append(HTTPSHandler(context=ssl.create_default_context(cafile=str(cert))))
    opener = build_opener(*handlers)

    def ready():
        if process.poll() is not None:
            raise RuntimeError(f"{name} exited with status {process.returncode}; see its log")
        try:
            with opener.open(url, timeout=2) as response:
                return response.status == 200
        except OSError:
            return False

    await_ready(ready, f"{name} failed readiness; see its log")


def create_tls(root):
    cert, key = root / "server.crt", root / "server.key"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:adm-intent",
                    "-keyout", str(key), "-out", str(cert)], capture_output=True, check=True)
    key.chmod(0o600)
    return cert, key


def start_intent_fixture(stack, name, network, image, cert, tls_key, env, secret, *, wla=False):
    script = REPO / "scripts/test" / ("wla4-fixture.mjs" if wla else "adm4-intent-fixture.mjs")
    arguments = ["--intent"] if wla else []
    evidence = cert.parent / "intent-fixture"
    evidence.mkdir(mode=0o700)
    docker("run", "--rm", "--detach", "--pull=never", "--name", name, "--network", network,
           "--network-alias", "adm-intent", "--publish", "127.0.0.1::8443", "--env", "ADM4_INTENT_KEY",
           "--mount", f"type=bind,src={cert},dst=/adm-tls/server.crt,readonly",
           "--mount", f"type=bind,src={tls_key},dst=/adm-tls/server.key,readonly",
           "--mount", f"type=bind,src={script},dst=/adm-intent.mjs,readonly",
           "--mount", f"type=bind,src={evidence},dst=/adm-evidence",
           "--entrypoint", "node", image, "/adm-intent.mjs", *arguments,
           env={**env, "ADM4_INTENT_KEY": secret}, check=True)
    stack.callback(docker, "stop", name)
    await_ready(lambda: docker("exec", name, "node", "-e", "const s=require('node:net').connect(8443,'127.0.0.1');"
                               "s.on('connect',()=>s.end());s.on('error',()=>process.exit(1));").returncode == 0,
                "intent fixture failed readiness")
    address = docker("port", name, "8443/tcp", check=True).stdout.strip()
    return f"https://{address}/v1"


def container_server(stack, args, name, network, env, values, root):
    configured = {**values, "DATABASE_URL": "postgres://postgres@adm-db:5432/postgres?sslmode=disable",
                  "ARTIFACT_DIR": "/adm-run/artifacts", "WHIPPET_BIND_HOST": "0.0.0.0",
                  "WHIPPET_TOOL_REGISTRY_PATH": "/adm-registry.json", "WHIPPET_SKILLS_PATH": "/adm-skills",
                  "TLS_CERT_FILE": "/adm-run/server.crt", "TLS_KEY_FILE": "/adm-run/server.key",
                  "SSL_CERT_FILE": "/adm-run/server.crt"}
    command = ["docker", "run", "--rm", "--pull=never", "--name", name, "--network", network,
               "--publish", f"127.0.0.1:{configured['PORT']}:{configured['PORT']}",
               "--mount", f"type=bind,src={args.server.resolve()},dst=/adm-server,readonly",
               "--mount", f"type=bind,src={root},dst=/adm-run",
               "--mount", f"type=bind,src={REPO / 'contracts/tools/registry.json'},dst=/adm-registry.json,readonly",
               "--mount", f"type=bind,src={REPO / 'runtimes/worker/skills'},dst=/adm-skills,readonly"]
    for key in configured.keys() - env.keys():
        command.extend(("--env", key))
    process = start(stack, [*command, "--entrypoint", "/adm-server", args.postgres_image],
                    configured, REPO, root / "server.log")
    stack.callback(docker, "stop", name)
    return process


def start_broker_observer(stack, root, env, api_url, cert):
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        port = connection.getsockname()[1]
    url = f"https://127.0.0.1:{port}"
    observer = start(stack, ["node", str(REPO / "scripts/test/adm4-broker-observer.mjs")],
                     {**env, "ADM4_BROKER_ROOT": str(root), "ADM4_BROKER_UPSTREAM": api_url,
                      "ADM4_BROKER_PORT": str(port)}, REPO, root / "broker-observer.log")
    wait_http(url + "/readyz", observer, "Manager test proxy", cert)
    return url


def start_browser_fixture(stack, name, image):
    program = (
        "require('node:http').createServer((_, response) => {"
        "response.setHeader('Content-Type', 'text/html');"
        "response.end('<h1>ADM-4 scoped browser fixture</h1>');"
        "}).listen(8080, '0.0.0.0');"
    )
    docker("run", "--rm", "--detach", "--pull=never", "--name", name, "--entrypoint", "node",
           image, "-e", program, check=True)
    stack.callback(docker, "stop", name, check=True)
    ip = docker("inspect", name, "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}",
                check=True).stdout.strip()
    return f"http://{ip}:8080"


def seed_a2(database, browser_origin="http://fixture.invalid"):
    """Only seed published specs and scope. Runs and leases use regular entrypoints."""
    config = json.dumps({
        "name": "預設 Workspace", "purpose": "ADM-4 isolated acceptance",
        "backgroundSummary": "Local Playwright fixture", "timeoutMs": 60000,
        "targets": [{"name": "Isolated fixture", "origin": browser_origin, "purpose": "Fixture only"}],
        "dependencies": [], "excludedOrigins": [], "loginRoles": [], "defaultTestUrl": browser_origin,
    }, ensure_ascii=False)
    sql = [
        "BEGIN;",
        "UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,"
        f"canonical_config=$adm_config${config}$adm_config$ WHERE id='{WORKSPACE}';",
    ]
    for i, delay in ((1, 0), (2, 20000)):
        test_id = f"10000000-0000-4000-8000-00000000000{i}"
        version = str(uuid4())
        script = (
            "import { test, expect } from '@playwright/test';\n"
            "test('ADM-4 local report fixture', async ({ page }) => {\n"
            "  await page.setContent('<h1>ADM-4 fixture ready</h1>');\n"
            "  await expect(page.getByRole('heading')).toHaveText('ADM-4 fixture ready');\n"
            f"  await page.waitForTimeout({delay});\n"
            "});"
        )
        digest = hashlib.sha256(script.encode()).hexdigest()
        sql.extend([
            "INSERT INTO test_versions(id,test_id,version,script,script_hash,timeout_ms,workspace_settings,script_origin)"
            f" SELECT '{version}','{test_id}',2,$adm_script${script}$adm_script$,'{digest}',60000,settings,'manual'"
            f" FROM workspaces WHERE id='{WORKSPACE}';",
            f"UPDATE tests SET published_version_id='{version}' WHERE id='{test_id}';",
        ])
    sql.append("COMMIT;")
    docker("exec", "-i", database, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
           input="\n".join(sql), check=True)


def remove_leftover_workers(manager):
    listing = docker("ps", "-aq", "--filter", f"label=whippet.manager.id={manager}", check=True)
    if listing.stdout.strip():
        docker("rm", "-f", *listing.stdout.split(), check=True)


def scan_managed_evidence(root, sentinels=FIXTURE_KEYS, *, embedded_reports=False):
    scanned, hits = [], []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.name in {"server.key", "keys-scan.json"}:
            continue
        name = str(path.relative_to(root))
        scanned.append(name)
        raw = path.read_bytes()
        if any(key in raw for key in sentinels):
            hits.append(name)
        archives = [path] if path.suffix == ".zip" and is_zipfile(path) else []
        if embedded_reports and path.suffix == ".html":
            for encoded in re.findall(rb'<template id="playwrightReportBase64">data:application/zip;base64,([A-Za-z0-9+/=]+)</template>', raw):
                archives.append(BytesIO(base64.b64decode(encoded, validate=True)))
        for source in archives:
            with ZipFile(source) as archive:
                for member in archive.infolist():
                    payload = archive.read(member)
                    if any(key in payload for key in sentinels):
                        hits.append(f"{name}/{member.filename}")
    (root / "keys-scan.json").write_text(json.dumps({"scanned": scanned, "hits": hits}, indent=2) + "\n")
    if hits:
        raise AssertionError(f"Synthetic Key exposure in {len(hits)} persisted files. See keys-scan.json.")


def run(args):
    if args.wla:
        sys.dont_write_bytecode = True
        from wla4_acceptance import configure, prepare

    token = uuid4().hex[:12]
    database, manager = f"whippet-adm4-db-{token}", f"whippet-adm4-manager-{token}"
    root = args.out.resolve()
    root.mkdir(mode=0o700)
    api_port, web_port = ports()
    scheme = "https" if args.tls else "http"
    api_url, web_url = f"{scheme}://127.0.0.1:{api_port}", f"http://127.0.0.1:{web_port}"
    admin_key, manager_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"
    }}
    registry = str(REPO / "contracts/tools/registry.json")
    with ExitStack() as stack:
        if args.wla:
            stack.callback(scan_managed_evidence, root, (b"wla4-secret-", b"wla4-provider-key"), embedded_reports=True)
        network = f"whippet-adm4-net-{token}"
        db_network = []
        if args.server_in_docker:
            docker("network", "create", network, check=True)
            stack.callback(docker, "network", "rm", network, check=True)
            db_network = ["--network", network, "--network-alias", "adm-db"]
        docker("run", "--rm", "--detach", "--pull=never", "--name", database, "--tmpfs",
               "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
               *db_network, "--publish", "127.0.0.1::5432", args.postgres_image, check=True)
        stack.callback(docker, "stop", database, check=True)
        pg_port = docker("port", database, "5432/tcp", check=True).stdout.strip().rsplit(":", 1)[-1]
        await_ready(lambda: docker("exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "postgres").returncode == 0,
                    "test PostgreSQL failed readiness")
        server_env = {**env, "DATABASE_URL": f"postgres://postgres@127.0.0.1:{pg_port}/postgres?sslmode=disable",
                      "ARTIFACT_DIR": str(root / "artifacts"), "PORT": str(api_port), "WHIPPET_BIND_HOST": "127.0.0.1",
                      "WHIPPET_ADMIN_TOKEN": admin_key, "MANAGER_TOKEN": manager_key, "WHIPPET_PUBLIC_ORIGIN": web_url,
                      "WHIPPET_SECRET_MASTER_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
                      "WHIPPET_TOOL_REGISTRY_PATH": registry,
                      "WHIPPET_SKILLS_PATH": str(REPO / "runtimes/worker/skills")}
        cert = None
        web_env = {**env, "WHIPPET_API_PROXY_TARGET": api_url}
        worker = (docker("image", "inspect", args.worker_image, "--format", "{{.Id}}", check=True).stdout.strip()
                  if args.worker_image else None)
        manager_env = {**env, "SERVER_URL": api_url, "MANAGER_TOKEN": manager_key, "MANAGER_ID": manager,
                       "MAX_WORKERS": "2", "WORK_DIR": str(root / "manager-work"),
                       "WHIPPET_TOOL_REGISTRY_PATH": registry}
        if args.tls:
            cert, tls_key = create_tls(root)
            stack.callback(tls_key.unlink, missing_ok=True)
            server_env.update(TLS_CERT_FILE=str(cert), TLS_KEY_FILE=str(tls_key))
            web_env["NODE_EXTRA_CA_CERTS"] = str(cert)
            manager_env["SERVER_CA_FILE"] = str(cert)
        if args.wla:
            configure(server_env, manager_env, docker, worker, final=args.wla == "final")
        if args.live_ai or args.live_a3 or args.wla:
            intent_key = secrets.token_urlsafe(32)
            intent_url = start_intent_fixture(stack, f"whippet-adm4-intent-{token}", network, worker,
                                              cert, tls_key, env, intent_key, wla=bool(args.wla))
            # The site-admin Agent proposal uses the Server-side provider.
            server_env.update(WHIPPET_AUTHOR_INTENT_BASE_URL="https://adm-intent:8443/v1",
                              WHIPPET_AUTHOR_INTENT_MODEL="adm-intent-fixture",
                              WHIPPET_AUTHOR_INTENT_API_KEY=intent_key)
            manager_env.update(WHIPPET_AUTHOR_INTENT_CA_FILE=str(cert), WHIPPET_AUTHOR_INTENT_BASE_URL=intent_url,
                              WHIPPET_AUTHOR_INTENT_MODEL="adm-intent-fixture",
                              WHIPPET_AUTHOR_INTENT_API_KEY=intent_key)
        if args.fixture_profiles:
            server_env["WHIPPET_AI_RUNTIME_PROFILES_JSON"] = json.dumps([
                {"id": f"adm-{engine}", "engine": engine, "provider": "opencode", "model": "fixture-model",
                 "baseURL": "https://opencode.ai/inference/go/openai/v1", "reasoningEffort": "low",
                 "contextWindowTokens": 32768, "contextInputTokens": 16384}
                for engine in ("builtin", "vercel", "pi")
            ])
        if args.server_in_docker:
            server = container_server(stack, args, f"whippet-adm4-server-{token}", network, env, server_env, root)
        else:
            server = start(stack, [str(args.server.resolve())], server_env, REPO, root / "server.log")
        wait_http(api_url + "/readyz", server, "Server", cert)
        web = start(stack, ["node", "node_modules/vite/bin/vite.js", "preview",
                            "--host", "127.0.0.1", "--port", str(web_port), "--strictPort"],
                    web_env, args.web_root, root / "web.log")
        wait_http(web_url, web, "Web")
        driver_env = {**env, "ADM_SMOKE_ADMIN_KEY": admin_key}
        if args.manager:
            if args.wla:
                services = (docker, start, wait_http, await_ready)
                driver_env.update(prepare(stack, args.wla, services, root, env, token, database,
                                          worker, api_url, cert, manager_env, focus=args.wla_focus))
            if args.live_a2:
                seed_a2(database)
            if args.live_a3:
                origin = start_browser_fixture(stack, f"whippet-adm4-target-{token}", worker)
                seed_a2(database, origin)
                driver_env["ADM4_BROWSER_ORIGIN"] = origin
            if args.managed_case == "boundary":
                broker_url = start_broker_observer(stack, root, env, api_url, cert)
                manager_env["SERVER_URL"] = broker_url
                driver_env.update(ADM4_BROKER_URL=broker_url, ADM4_BROKER_CA=str(cert))
            stack.callback(remove_leftover_workers, manager)
            manager_env["WORKER_IMAGE"] = worker
            manager_bin = str(args.manager.resolve())
            manager_process = start(stack, [manager_bin], manager_env, REPO, root / "manager.log")
            if args.live_a3:
                driver_env.update(ADM4_MANAGER_PID=str(manager_process.pid), ADM4_MANAGER_BIN=manager_bin,
                                  ADM4_MANAGER_ENV=json.dumps(manager_env))
            (root / "runtime.json").write_text(json.dumps({"managerId": manager, "workerImage": args.worker_image,
                                                           "workerDigest": worker, "tls": args.tls}) + "\n")
        driver = args.driver or REPO / "scripts/test" / ("wla4_acceptance.py" if args.wla else "adm1-ui-smoke.py")
        test_args = [sys.executable, str(driver.resolve()), "--base-url", web_url,
                     "--evidence-dir", str(root)]
        if args.browser_executable:
            test_args += ["--browser-executable", str(args.browser_executable)]
        if args.live_a2:
            test_args += ["--live-a2"]
        if args.live_ai:
            test_args += ["--live-ai", "--managed-case", args.managed_case]
        if args.live_a3:
            test_args += ["--live-a3"]
        if args.wla:
            test_args += ["--wave", args.wla]
            if args.wla_focus:
                test_args += ["--focus", args.wla_focus]
        try:
            subprocess.run(test_args, env=driver_env, check=True, timeout=900 if args.wla == "final" else 420)
        finally:
            if args.live_a2 or args.live_a3 or args.live_ai:
                queries = {
                    "run-attempts.json": "SELECT coalesce(jsonb_agg(jsonb_build_object('runId',id,'attemptId',attempt_id,"
                    "'status',status) ORDER BY queue_seq), '[]'::jsonb) FROM runs",
                    "browser-leases.json": "SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',l.session_id,"
                    "'state',l.state,'reclaimed',l.reclaimed,'calls',"
                    "(SELECT count(*) FROM agent_browser_calls c WHERE c.session_id=l.session_id))), '[]'::jsonb)"
                    " FROM agent_browser_leases l",
                }
                if args.live_ai:
                    queries["managed-bindings.json"] = """
                        SELECT coalesce(jsonb_agg(jsonb_build_object('runId',b.run_id,'workspaceId',b.workspace_id,
                          'attemptId',r.attempt_id,'agentId',b.agent_id,'version',b.secret_version,'status',r.status,
                          'engine',r.author_payload->'runtime'->>'engine','provider',r.author_payload->'runtime'->>'provider')
                          ORDER BY r.queue_seq),'[]'::jsonb)
                        FROM site_ai_run_bindings b JOIN runs r ON r.id=b.run_id
                    """
                    queries["managed-provisions.json"] = """
                        SELECT coalesce(jsonb_agg(jsonb_build_object('operationId',id,'agentId',agent_id,
                          'version',secret_version,'status',result_status,'code',result_code,'reclaimed',reclaimed)
                          ORDER BY created_at),'[]'::jsonb) FROM site_ai_provisions
                    """
                for name, query in queries.items():
                    result = docker("exec", database, "psql", "-X", "-At", "-U", "postgres", "-c", query)
                    if result.returncode == 0:
                        (root / name).write_text(result.stdout)
            if args.live_ai:
                scan_managed_evidence(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, required=True, help="built Server executable")
    parser.add_argument("--server-in-docker", action="store_true", help="run a Linux build with the isolated Docker CA")
    parser.add_argument("--web-root", type=Path, required=True, help="isolated apps/web with production dist and dependencies")
    parser.add_argument("--out", type=Path, required=True, help="new evidence and working directory")
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--postgres-image", default="postgres:16")
    stages = parser.add_mutually_exclusive_group()
    stages.add_argument("--live-a2", action="store_true", help="use Manager and a real Docker Worker for archive drain and cancel")
    stages.add_argument("--live-ai", action="store_true", help="use the synthetic Worker for proposals, probes and authors")
    stages.add_argument("--live-a3", action="store_true", help="exercise real Manager and MCP resource concurrency")
    stages.add_argument("--wla", choices=("w1", "final"), help="run Workspace login acceptance against isolated services")
    parser.add_argument("--wla-focus", choices=("a2", "a3", "a4", "a5", "a6", "builtin", "vercel", "pi", "mcp-interactive", "mcp-claim", "login-live"),
                        help="run one final acceptance case and its prerequisites")
    parser.add_argument("--manager", type=Path)
    parser.add_argument("--worker-image", help="existing Docker image provided by Runtime")
    parser.add_argument("--tls", action="store_true", help="use HTTPS for Server and WSS for Manager")
    parser.add_argument("--fixture-profiles", action="store_true", help="enable the Runtime synthetic Worker profiles")
    parser.add_argument("--managed-case", choices=("full", "boundary", "revoked", "proposal"), default="full")
    parser.add_argument("--driver", type=Path, help="browser driver accepting the same environment and options as adm1-ui-smoke.py")
    args = parser.parse_args()
    if args.live_a2 and not (args.manager and args.worker_image):
        parser.error("--live-a2 requires --manager and --worker-image")
    if (args.live_ai or args.live_a3) and not (args.manager and args.worker_image and args.tls and args.fixture_profiles):
        parser.error("AI scenarios require --manager, --worker-image, --tls and --fixture-profiles")
    if (args.live_ai or args.live_a3) and not args.server_in_docker:
        parser.error("AI scenarios require --server-in-docker for the isolated HTTPS classifier")
    if args.server_in_docker and not args.tls:
        parser.error("--server-in-docker requires --tls")
    if args.wla and (not (args.manager and args.worker_image and args.server_in_docker and args.tls)
                     or args.fixture_profiles or args.driver):
        parser.error("--wla requires --manager, --worker-image, --server-in-docker and --tls, using its own profiles and driver")
    if args.wla_focus and args.wla != "final":
        parser.error("--wla-focus requires --wla final")
    if args.managed_case != "full" and not args.live_ai:
        parser.error("--managed-case requires --live-ai")
    if bool(args.manager) != bool(args.worker_image):
        parser.error("--manager and --worker-image must be set together")
    if not (args.web_root / "dist/index.html").is_file():
        parser.error("--web-root must contain a production build")
    run(args)


if __name__ == "__main__":
    main()
