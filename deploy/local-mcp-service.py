#!/usr/bin/env python3
"""launchd entry point for the isolated macOS Whippet MCP installation.

Only dedicated local credentials enter child environment; no request logs.
"""
import argparse
import os
from pathlib import Path
import sys
import subprocess
import shutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('role', choices=['server', 'manager'])
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    sys.path.insert(0, str(root / 'transport'))
    from bridge import read_secret_file
    def credential(account):
        return read_secret_file(str(root / 'secrets' / account))
    env = {
        'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'HOME': str(Path.home()),
        'WHIPPET_TOOL_REGISTRY_PATH': str(root / 'registry.json'),
        'MANAGER_TOKEN': credential('manager'),
    }
    if args.role == 'server':
        from urllib.parse import quote
        password = quote(credential('postgres'), safe='')
        env.update({
            'DATABASE_URL': f'postgres://whippet:{password}@127.0.0.1:19589/whippet?sslmode=disable',
            'WHIPPET_ADMIN_TOKEN': credential('admin'),
            'WHIPPET_PUBLIC_ORIGIN': 'http://127.0.0.1:19587',
            'WHIPPET_BIND_HOST': '127.0.0.1', 'PORT': '19587',
            'ARTIFACT_DIR': str(root / 'artifacts'),
            'WHIPPET_SKILLS_PATH': str(root / 'skills'),
        })
    else:
        env.update({
            'SERVER_URL': 'http://127.0.0.1:19587',
            'MANAGER_ID': 'whippet-mcp-local',
            'WORK_DIR': str(root / 'work'),
            'WORKER_IMAGE': 'whippet-worker:m11w3', 'MAX_WORKERS': '1',
        })
        result = subprocess.run(
            [shutil.which('docker', path=env['PATH']), 'context', 'inspect', '--format',
             '{{.Endpoints.docker.Host}}'], env=env, capture_output=True,
            timeout=5, check=True, text=True)
        endpoint = result.stdout.strip()
        if not endpoint.startswith('unix:///') or '\n' in endpoint:
            raise ValueError('local Docker socket required')
        env['DOCKER_HOST'] = endpoint
    os.chdir(root)
    with open(os.devnull, 'r+b') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    binary = str(root / 'bin' / args.role)
    os.execve(binary, [binary], env)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # launchd retries; never serialize credentials or upstream diagnostics.
        sys.exit(1)
