#!/usr/bin/env python3
"""Run only the additional M11 ABI case against an existing fixed snapshot."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    sys.exit('Provide the existing private snapshot directory.')
parent = Path(sys.argv[1]).resolve()
source = parent / 'source'
manifest_file = parent / 'manifest.json'
manifest = json.loads(manifest_file.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for rel, expected in manifest.items():
    if rel.startswith('scripts/test/'):
        continue
    if sha(source / rel) != expected:
        sys.exit('Snapshot integrity failed; no tests executed.')
dsn = urlsplit(os.environ.get('TEST_DATABASE_URL', ''))
if dsn.scheme not in ('postgres', 'postgresql') or not dsn.hostname:
    sys.exit('Explicit isolated PostgreSQL URL required; no tests executed.')
private = Path(tempfile.mkdtemp(prefix='whippet-m11-final-abi-', dir='/private/tmp'))
os.chmod(private, 0o700)
test = private / 'moduleabi_test.go'
test.write_bytes((root / 'scripts/test/m11-final-api-moduleabi_test.go').read_bytes())
overlay = private / 'overlay.json'
overlay.write_text(json.dumps({'Replace': {str(source / 'services/server/internal/server/m11_final_moduleabi_test.go'): str(test)}}))
env = os.environ.copy()
env['WHIPPET_SKILLS_PATH'] = str(source / 'runtimes/worker/skills')
env['WHIPPET_TOOL_REGISTRY_PATH'] = str(source / 'contracts/tools/registry.json')
cmd = ['go', 'test', '-json', '-vet=off', '-tags', 'integration', '-overlay', str(overlay), '-run', '^TestM11', '-skip', '^TestM11(Admin|Agent|Browser|External|Interactive|MCP)', '-count=1', './internal/server']
print('Private ABI overlay:', private, flush=True)
proc = subprocess.run(cmd, cwd=source / 'services/server', env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
status = {}
for line in proc.stdout.splitlines():
    try:
        event = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        continue
    name, action = event.get('Test', ''), event.get('Action')
    if name and action in ('pass', 'fail', 'skip'):
        status[name] = action
expected = {'TestM11FinalModuleABISnapshotAndDispatch': 'pass'}
result = {'result': 'PASS' if proc.returncode == 0 and status == expected else 'FAIL',
          'goExitCode': proc.returncode, 'tests': status,
          'sourceManifestSHA256': sha(manifest_file), 'abiTestSHA256': sha(test),
          'runFilter': '^TestM11', 'skipFilter': '^TestM11(Admin|Agent|Browser|External|Interactive|MCP)',
          'fixtureLimits': 'In-process Server and real isolated PostgreSQL; no Worker or Docker.'}
(private / 'result.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
print(json.dumps(result, indent=2, sort_keys=True))
sys.exit(0 if result['result'] == 'PASS' else 1)
