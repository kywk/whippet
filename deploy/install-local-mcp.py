#!/usr/bin/env python3
"""Install a new isolated macOS MCP service; never upgrade existing deployments."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

SERVICE = 'io.whippet.mcp.local'
ROOT = Path.home() / '.local/share/whippet-mcp'
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts/local-mcp'))
from bridge import read_secret_file


def run(argv, **kwargs):
    return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          check=True, **kwargs).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server-binary', required=True)
    parser.add_argument('--manager-binary', required=True)
    args = parser.parse_args()
    for role in ('server', 'manager'):
        if not Path(getattr(args, role + '_binary')).is_file():
            raise RuntimeError('binary_missing')
    agents = Path.home() / 'Library/LaunchAgents'
    for role in ('server', 'manager'):
        if (agents / f'{SERVICE}.{role}.plist').exists():
            raise RuntimeError('existing_installation')
    existing = subprocess.run(['/opt/homebrew/bin/codex', 'mcp', 'get', 'whippet', '--json'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if existing.returncode == 0:
        raise RuntimeError('existing_mcp_registration')
    names = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
    volumes = run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).decode().splitlines()
    if 'whippet-mcp-local-db' in names or 'whippet-mcp-local-db' in volumes:
        raise RuntimeError('existing_database')
    for port in (19587, 19589):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    # New installation only; dedicated credentials never overwrite existing files.
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in ('bin', 'transport', 'artifacts', 'work', 'secrets'):
        (ROOT / directory).mkdir(exist_ok=True, mode=0o700)
    def save_secret(account, value):
        target = ROOT / 'secrets' / account
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
    for account in ('admin', 'manager', 'postgres'):
        save_secret(account, secrets.token_urlsafe(48))
    for role in ('server', 'manager'):
        shutil.copy2(getattr(args, role + '_binary'), ROOT / 'bin' / role)
    for name in ('bridge.py', 'set_keychain.py'):
        shutil.copy2(REPO / 'scripts/local-mcp' / name, ROOT / 'transport' / name)
    shutil.copy2(REPO / 'deploy/local-mcp-service.py', ROOT / 'service.py')
    shutil.copy2(REPO / 'contracts/tools/registry.json', ROOT / 'registry.json')
    shutil.copytree(REPO / 'runtimes/worker/skills', ROOT / 'skills', dirs_exist_ok=True)
    # Docker receives only the new database password through process environment.
    env = {'PATH': os.environ['PATH'], 'HOME': str(Path.home()),
           'POSTGRES_PASSWORD': read_secret_file(str(ROOT / 'secrets/postgres'))}
    run(['docker', 'run', '-d', '--name', 'whippet-mcp-local-db',
         '--label', 'whippet.installation=local-mcp', '--restart', 'unless-stopped',
         '-p', '127.0.0.1:19589:5432', '-v', 'whippet-mcp-local-db:/var/lib/postgresql/data',
         '-e', 'POSTGRES_USER=whippet', '-e', 'POSTGRES_DB=whippet',
         '-e', 'POSTGRES_PASSWORD', 'postgres:16'], env=env)
    print('LOCAL_MCP_DATABASE_CREATED=true', flush=True)
    agents.mkdir(parents=True, exist_ok=True)
    for role in ('server', 'manager'):
        label = f'{SERVICE}.{role}'
        plist = agents / f'{label}.plist'
        data = {'Label': label, 'ProgramArguments': [sys.executable, str(ROOT / 'service.py'),
                role, '--root', str(ROOT)], 'RunAtLoad': True, 'KeepAlive': True,
                'ThrottleInterval': 10, 'WorkingDirectory': str(ROOT),
                'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}
        plist.write_bytes(plistlib.dumps(data))
        plist.chmod(0o600)
        run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)])
    print('LOCAL_MCP_SERVICES_REGISTERED=true', flush=True)
    base = 'http://127.0.0.1:19587'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        try:
            with opener.open(base + '/readyz', timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError('server_not_ready')
    print('LOCAL_MCP_SERVER_READY=true', flush=True)
    admin = read_secret_file(str(ROOT / 'secrets/admin'))
    def post(path, body):
        request = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                  headers={'X-Whippet-Admin-Token': admin, 'Origin': base,
                           'Content-Type': 'application/json'}, method='POST')
        with opener.open(request, timeout=10) as response:
            return json.load(response)
    workspace = post('/api/workspaces', {'name': 'Local MCP'})
    issued = post(f'/api/workspaces/{workspace["id"]}/agent-tokens', {'name': 'Codex local'})
    save_secret('agent', issued['token'])
    run(['/opt/homebrew/bin/codex', 'mcp', 'add', 'whippet', '--', sys.executable,
         str(ROOT / 'transport/bridge.py'), '--url', base + '/mcp',
         '--secret-file', str(ROOT / 'secrets/agent')])
    print('LOCAL_MCP_INSTALLED=true')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No upstream bodies, environment, passwords, or exception text.
        print('LOCAL_MCP_INSTALLED=false', file=sys.stderr)
        sys.exit(1)
