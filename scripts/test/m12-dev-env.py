#!/usr/bin/env python3
"""Restore the retained builtin and local MCP baselines after a macOS reboot.

No create/seed/model Run. Secrets remain in their existing private state files.
start runs the builtin recipe in the foreground; keep its terminal/session open.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
PINS = Path('/Users/kywk/.local/share/whippet/maintenance/m12-mcp-pins.json')

class RestoreError(Exception):
    pass

def command(args: list[str], *, required: bool = True) -> str | None:
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, timeout=15)
    if result.returncode:
        if required:
            raise RestoreError('command_failed')
        return None
    return result.stdout.strip()

def recipe():
    path = REPO / 'scripts/test/m10z-recoverable-env.py'
    spec = importlib.util.spec_from_file_location('m12_baseline_recipe', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def healthy(url: str) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url + '/readyz', timeout=2) as response:
            return response.status == 200
    except Exception:
        return False

def check_mcp_pins() -> dict:
    if not PINS.is_file() or PINS.is_symlink():
        raise RestoreError('mcp_pins_missing')
    pins = json.loads(PINS.read_text())
    if pins.get('root') != '/Users/kywk/.local/share/whippet-mcp':
        raise RestoreError('mcp_state_identity_mismatch')
    root = Path(pins['root'])
    for relative, expected in pins['files'].items():
        path = root / relative
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RestoreError('mcp_source_pin_mismatch')
    actual = command(['docker', 'image', 'inspect', pins['workerTag'], '--format', '{{.Id}}'])
    if actual != pins['workerImage']:
        raise RestoreError('mcp_worker_pin_mismatch')
    return pins

def inspect_volume(name: str) -> None:
    if command(['docker', 'volume', 'inspect', name, '--format', '{{.Name}}'], required=False) != name:
        raise RestoreError('retained_volume_missing_restore_backup_first')

def start_mcp(pins: dict) -> None:
    # Existing volume/container only: never replace an installation or generate credentials.
    inspect_volume(pins['volume'])
    identity = command(['docker', 'inspect', pins['container'], '--format',
                        '{{.Image}}|{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'], required=False)
    if identity != pins['postgresImage'] + '|' + pins['volume']:
        raise RestoreError('mcp_database_identity_mismatch')
    info = command(['docker', 'inspect', pins['container'], '--format', '{{.State.Running}}'], required=False)
    if info is None:
        raise RestoreError('mcp_database_container_missing_restore_backup_first')
    if info == 'false':
        command(['docker', 'start', pins['container']])
    domain = 'gui/' + str(os.getuid())
    for label in pins['launchd']:
        target = domain + '/' + label
        plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
        if command(['launchctl', 'print', target], required=False) is None:
            command(['launchctl', 'bootstrap', domain, str(plist)])
    for _ in range(30):
        if healthy(pins['api']):
            return
        time.sleep(.5)
    for label in pins['launchd']:
        command(['launchctl', 'kickstart', '-k', domain + '/' + label])
    for _ in range(30):
        if healthy(pins['api']):
            return
        time.sleep(.5)
    raise RestoreError('mcp_not_ready')

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'start'])
    args = parser.parse_args()
    if command(['docker', 'info', '--format', '{{.ServerVersion}}'], required=False) is None:
        raise RestoreError('docker_unavailable_open_orbstack_first')
    module = recipe()
    try:
        module.load_state(module.STATE_DIR)
    except module.RecipeError as error:
        raise RestoreError('builtin_' + str(error)) from None
    pins = check_mcp_pins()
    inspect_volume(module.PG_VOLUME)
    info = module.status(module.STATE_DIR)
    manager = info['containers'][module.MANAGER_NAME]
    if manager.get('present') and not manager.get('identityValid'):
        raise RestoreError('builtin_manager_identity_mismatch')
    if args.action == 'status':
        print(json.dumps({'builtin': info, 'mcpReady': healthy(pins['api']),
                          'mcpPinsValid': True}, sort_keys=True))
        return
    start_mcp(pins)
    if all(info['ports'].values()):
        print(json.dumps({'status': 'ALREADY_RUNNING', 'mcpReady': True}))
        return
    if any(info['ports'].values()):
        raise RestoreError('partial_builtin_listener_state_check_owned_processes_first')
    argv = [sys.executable, str(REPO / 'scripts/test/m10z-recoverable-env.py'), 'start']
    if module._container(module.MANAGER_NAME) is None:
        model_file = module.STATE_DIR / 'model.env'
        if not model_file.is_file() or model_file.is_symlink():
            raise RestoreError('persisted_model_env_missing')
        argv += ['--model-env-file', str(model_file)]
    # Contents of model.env are handed only to Docker by the original recipe.
    process = subprocess.Popen(argv, cwd=REPO, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    try:
        result = process.wait()
    except KeyboardInterrupt:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
        process.wait(timeout=15)
        return
    if result:
        raise RestoreError('builtin_recipe_stopped')

if __name__ == '__main__':
    try:
        main()
    except (RestoreError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, RestoreError) else type(error).__name__
        print(json.dumps({'status': 'STOP', 'reason': reason}), file=sys.stderr)
        sys.exit(2)
