#!/usr/bin/env python3
"""Re-pin two planner skill files and test only their M11 consumers."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    sys.exit('Provide the previously verified private snapshot directory.')
parent = Path(sys.argv[1]).resolve()
old = parent / 'source'
manifest_path = parent / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
changed = {'runtimes/worker/skills/usecase-planner/manifest.json', 'runtimes/worker/skills/usecase-planner/references/external-mcp.md'}
for rel, expected in manifest.items():
    original = root / rel
    if not original.is_file():
        sys.exit('Manifest input missing; no tests executed.')
    if not rel.startswith('scripts/test/') and sha(old / rel) != expected:
        sys.exit('Previous snapshot integrity failed; no tests executed.')
    if rel not in changed and sha(original) != expected:
        sys.exit('An additional input changed; no tests executed.')
if any(sha(root / rel) == manifest[rel] for rel in changed):
    sys.exit('Expected planner changes missing; no tests executed.')
dsn = urlsplit(os.environ.get('TEST_DATABASE_URL', ''))
if dsn.scheme not in ('postgres', 'postgresql') or not dsn.hostname:
    sys.exit('Explicit isolated PostgreSQL URL required; no tests executed.')
private = Path(tempfile.mkdtemp(prefix='whippet-m11-final-planner-', dir='/private/tmp'))
os.chmod(private, 0o700)
source = private / 'source'
shutil.copytree(old, source)
for rel in changed:
    shutil.copy2(root / rel, source / rel)
    manifest[rel] = sha(source / rel)
    if sha(root / rel) != manifest[rel]:
        sys.exit('Planner input changed during snapshot; no tests executed.')
(private / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
replacements = {}
for filename, target in [('m11w5-platform-server_test.go','server/m11_final_w5_test.go'), ('m11w6-interactive-server_test.go','server/m11_final_w6_test.go')]:
    testcopy = private / filename
    shutil.copy2(parent / 'overlay-tests' / filename, testcopy)
    replacements[str(source / 'services/server/internal' / target)] = str(testcopy)
overlay = private / 'overlay.json'
overlay.write_text(json.dumps({'Replace': replacements}))
env = os.environ.copy()
env['WHIPPET_SKILLS_PATH'] = str(source / 'runtimes/worker/skills')
env['WHIPPET_TOOL_REGISTRY_PATH'] = str(source / 'contracts/tools/registry.json')
skip = '^TestM11(Admin|Agent|Browser|External|Interactive|MCPCatalogDB|MCPRate|MCPReject|MCPAnd|W5PlatformModule|W5PlatformWorkspace|W6InteractiveModule|W6InteractiveStale)'
cmd = ['go', 'test', '-json', '-vet=off', '-tags', 'integration', '-overlay', str(overlay), '-run', '^TestM11', '-skip', skip, '-count=1', './internal/server']
print('Private planner snapshot:', private, flush=True)
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
expected = {'TestM11MCPRegistryReadScopeAndRevocation', 'TestM11W5PlatformPlanner', 'TestM11W5PlatformPlannerForeignAttempt', 'TestM11W6InteractivePlanAndBoundaries'}
top = {k: v for k, v in status.items() if '/' not in k}
success = proc.returncode == 0 and set(top) == expected and all(v == 'pass' for v in status.values())
result = {'result': 'PASS' if success else 'FAIL', 'goExitCode': proc.returncode, 'tests': status,
          'sourceManifestSHA256': sha(private / 'manifest.json'), 'previousManifestSHA256': sha(manifest_path),
          'changedInputs': sorted(changed), 'runFilter': '^TestM11', 'skipFilter': skip,
          'fixtureLimits': 'In-process Server and synthetic planner fixtures with isolated PostgreSQL; no real Worker, Docker, UI or model.'}
(private / 'result.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
print(json.dumps(result, indent=2, sort_keys=True))
sys.exit(0 if success else 1)
