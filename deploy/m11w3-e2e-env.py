#!/usr/bin/env python3
"""Disposable real UI/MCP/Worker E2E environment; credentials stay in memory."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
import uuid

REPO = Path(__file__).resolve().parents[1]
PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server-binary', required=True)
    parser.add_argument('--manager-binary', required=True)
    parser.add_argument('--worker-image', required=True)
    parser.add_argument('--work-root', required=True)
    args = parser.parse_args()
    root = Path(args.work_root)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    processes = []
    db_name = 'whippet-m11w3-e2e-pg-' + uuid.uuid4().hex[:8]
    manager_id = 'm11w3-e2e-' + uuid.uuid4().hex
    stage = 'preflight'
    broker = None
    base = {'PATH': PATH, 'HOME': str(Path.home())}
    docker = shutil.which('docker', path=PATH)
    def command(argv, **kwargs):
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=True, **kwargs).stdout
    def start(argv, env=None, cwd=REPO):
        process = subprocess.Popen(argv, cwd=cwd, env=env or base,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(process)
        return process
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    web = 'http://127.0.0.1:19687'
    api = 'http://127.0.0.1:19689'
    target = 'http://host.docker.internal:19688'
    def wait_http(url):
        for _ in range(100):
            try:
                with opener.open(url, timeout=2) as response:
                    if response.status == 200:
                        return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError('http_not_ready')
    try:
        for port in (19687, 19688, 19689, 19690):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        docker_host = command([docker, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], env=base).decode().strip()
        if not docker_host.startswith('unix:///'):
            raise RuntimeError('local_docker_required')
        docker_env = {**base, 'DOCKER_HOST': docker_host}
        stage = 'database'
        command([docker, 'run', '-d', '--name', db_name, '--label', 'whippet.owner=t52',
                 '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                 '-p', '127.0.0.1::5432', 'postgres:16'], env=docker_env)
        port = command([docker, 'port', db_name, '5432'], env=docker_env).decode().strip().split(':')[-1]
        for _ in range(100):
            check = subprocess.run([docker, 'exec', db_name, 'pg_isready', '-U', 'postgres'],
                                   env=docker_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if check.returncode == 0:
                break
            time.sleep(0.2)
        admin_key, manager_key = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        stage = 'services'
        server_env = {**base, 'DATABASE_URL': f'postgres://postgres@127.0.0.1:{port}/postgres?sslmode=disable',
              'MANAGER_TOKEN': manager_key, 'WHIPPET_ADMIN_TOKEN': admin_key,
              'WHIPPET_BIND_HOST': '127.0.0.1', 'PORT': '19689', 'WHIPPET_PUBLIC_ORIGIN': web,
              'ARTIFACT_DIR': str(root / 'artifacts'), 'WHIPPET_TOOL_REGISTRY_PATH': str(REPO / 'contracts/tools/registry.json'),
              'WHIPPET_SKILLS_PATH': str(REPO / 'runtimes/worker/skills')}
        server = start([args.server_binary], server_env)
        wait_http(api + '/readyz')
        start([args.manager_binary], {**docker_env, 'SERVER_URL': api, 'MANAGER_TOKEN': manager_key,
              'MANAGER_ID': manager_id, 'WORKER_IMAGE': args.worker_image, 'WORK_DIR': str(root / 'work'),
              'MAX_WORKERS': '1', 'WHIPPET_TOOL_REGISTRY_PATH': str(REPO / 'contracts/tools/registry.json')})
        start(['python3', '-B', str(REPO / 'scripts/test/m11w3-ui-target.py'), '--host', '0.0.0.0', '--port', '19688'])
        start(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '19687'],
              {**base, 'WHIPPET_API_PROXY_TARGET': api}, REPO / 'apps/web')
        wait_http(web)
        wait_http('http://127.0.0.1:19688')
        stage = 'fixture'
        def post(path, body):
            request = urllib.request.Request(api + path, data=json.dumps(body).encode(), method='POST',
                      headers={'Content-Type': 'application/json', 'Origin': web, 'X-Whippet-Admin-Token': admin_key})
            with opener.open(request, timeout=10) as response:
                return json.load(response)
        workspace_name = 'M11 W3 MCP E2E'
        workspace = post('/api/workspaces', {'name': workspace_name})
        config = {'name': workspace_name, 'purpose': 'Isolated external author E2E',
                  'backgroundSummary': 'Synthetic order lookup fixture',
                  'targets': [{'name': 'Order lookup', 'purpose': 'Order lookup verification', 'origin': target}],
                  'dependencies': [], 'excludedOrigins': [], 'exclusions': '', 'loginRoles': [],
                  'defaultTestUrl': target, 'timeoutMs': 60000}
        encoded = json.dumps(config, separators=(',', ':')).replace("'", "''")
        sql = f"UPDATE workspaces SET canonical_config='{encoded}'::jsonb,lifecycle='active',scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id='{workspace['id']}'::uuid;"
        command([docker, 'exec', '-i', db_name, 'psql', '-X', '-q', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                env=docker_env, input=sql.encode())
        token = post(f"/api/workspaces/{workspace['id']}/agent-tokens", {'name': 'Isolated MCP author'})['token']
        stage = 'broker'
        token_socket = str(root / 'token.sock')
        broker = socket.socket(socket.AF_UNIX)
        broker.bind(token_socket)
        os.chmod(token_socket, 0o600)
        broker.listen(5)
        def serve_token():
            while True:
                try:
                    connection, _ = broker.accept()
                    with connection:
                        connection.settimeout(3)
                        connection.sendall(token.encode())
                except OSError:
                    return
        threading.Thread(target=serve_token, daemon=True).start()
        stage = 'browser_login'
        executable = command(['node', '-e', 'console.log(require("./runtimes/worker/node_modules/playwright").chromium.executablePath())'], cwd=REPO, env=base).decode().strip()
        start([executable, '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19690',
               '--user-data-dir=' + str(root / 'browser'), '--no-first-run', '--no-default-browser-check', 'about:blank'])
        wait_http('http://127.0.0.1:19690/json/version')
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:19690')
            context = browser.new_context()
            page = context.new_page()
            page.goto(web)
            page.wait_for_load_state('networkidle')
            page.get_by_label('管理 key（管理 gate 啟用時必填）').fill(admin_key)
            page.get_by_role('button', name='以開發管理員登入').click()
            page.get_by_role('button', name='以開發管理員登入').wait_for(state='hidden')
            # Keep this CDP connection/context alive while QA operates the same page.
            public = {'ready': True, 'webURL': web, 'apiURL': api, 'cdpURL': 'http://127.0.0.1:19690',
                      'workspaceName': workspace_name, 'workspaceId': workspace['id'], 'targetURL': target,
                      'tokenSocket': token_socket, 'databaseContainer': db_name, 'databasePort': int(port)}
            (root / 'ready.json').write_text(json.dumps(public))
            print('E2E_ENV_READY=true', flush=True)
            stage = 'waiting'
            while not (root / 'stop').exists():
                if (root / 'restart-server').exists():
                    (root / 'restart-server').unlink()
                    server.terminate()
                    server.wait(timeout=15)
                    server = start([args.server_binary], server_env)
                    wait_http(api + '/readyz')
                    page.reload()
                    page.wait_for_load_state('networkidle')
                    login = page.get_by_role('button', name='以開發管理員登入')
                    if login.is_visible():
                        page.get_by_label('管理 key（管理 gate 啟用時必填）').fill(admin_key)
                        login.click()
                        login.wait_for(state='hidden')
                    (root / 'server-restarted').write_text('true\n')
                    print('E2E_SERVER_RESTARTED=true', flush=True)
                page.wait_for_timeout(500)
            browser.close()
    except Exception:
        print('E2E_ENV_READY=false STAGE=' + stage, flush=True)
        raise SystemExit(1)
    finally:
        if broker is not None:
            broker.close()
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if docker:
            subprocess.run([docker, 'rm', '-f', db_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('E2E_ENV_STOPPED=true', flush=True)


if __name__ == '__main__':
    main()
