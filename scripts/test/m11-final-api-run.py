#!/usr/bin/env python3
"""M11 API QA: snapshot source, private Go overlay, isolated PG schemas.

Requires TEST_DATABASE_URL for an isolated PostgreSQL. Prints only fixed test
names and outcomes, never test output, environment contents, or credentials.
The W7 resolver's hardcoded local test DSN is replaced in the temporary copy
with the explicitly supplied TEST_DATABASE_URL; assertions are unchanged.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
TESTS = {
    'm11w4-summary-server_test.go': 'server/m11_final_w4_test.go',
    'm11w5-platform-server_test.go': 'server/m11_final_w5_test.go',
    'm11w6-interactive-server_test.go': 'server/m11_final_w6_test.go',
    'm11w7-security-resolver_test.go': 'server/m11_final_w7_resolver_test.go',
    'm11w7-security-live_test.go': 'server/m11_final_w7_live_test.go',
    'm11w7-security-gateway_test.go': 'gateway/m11_final_w7_gateway_test.go',
    'm11-final-api-moduleabi_test.go': 'server/m11_final_moduleabi_test.go',
}
EXPECTED = {
    'TestM11W4ModuleExternalSummary', 'TestM11W4BatchExternalSummary', 'TestM11W4TestExternalSummary',
    'TestM11W5PlatformModule', 'TestM11W5PlatformPlanner', 'TestM11W5PlatformPlannerForeignAttempt', 'TestM11W5PlatformWorkspace',
    'TestM11W6InteractiveModule', 'TestM11W6InteractivePlanAndBoundaries', 'TestM11W6InteractiveStaleCAS', 'TestM11W6InteractiveStaleSubmit',
    'TestM11W7SecurityResolver', 'TestM11W7SecurityLiveAuthority', 'TestM11W7SecurityLiveHTTPGate', 'TestM11W7SecurityLiveViewerMedia', 'TestM11W7SecurityGatewayWebSockets',
    'TestM11BrowserLeaseMCPWireAndPersistentDedupe', 'TestM11BrowserLeaseRevocationAndReconnectConverge',
    'TestM11AdminGateKeepsManagerAndHealthSeparate', 'TestM11MCPAndTokenManagementDisabledWithoutAdminKey', 'TestM11AdminCookieSupportsNativeGETAndLogout',
    'TestM11ExternalAuthorClaimAndImmutableSnapshot', 'TestM11ExternalBrowserBusyRetrySameCallIDMCP', 'TestM11InteractiveMCPAuthorAndWaitingPlan',
    'TestM11ExternalWorkspaceTaskHasNullTestID', 'TestM11ExternalTaskDefinitionsUsePinnedRegistryAndIntersection',
    'TestM11FinalModuleABISnapshotAndDispatch',
    'TestM11AgentTokenLifecycleHTTP', 'TestM11MCPRegistryReadScopeAndRevocation', 'TestM11MCPRateLimitUsesTokenBucket',
    'TestM11MCPCatalogDBFailureCannotReturnSuccessNull', 'TestM11MCPRejectsDuplicateAndOversizedRawArguments',
}

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    dsn = os.environ.get('TEST_DATABASE_URL', '')
    parsed = urlsplit(dsn)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
        sys.exit('Explicit isolated PostgreSQL URL required; no tests executed.')
    private = Path(tempfile.mkdtemp(prefix='whippet-m11-final-api-', dir='/private/tmp'))
    os.chmod(private, 0o700)
    snapshot = private / 'source'
    for rel in ('services/server/internal', 'services/server/migrations', 'contracts/tools', 'runtimes/worker/skills'):
        shutil.copytree(ROOT / rel, snapshot / rel, symlinks=False)
    for rel in ('services/server/go.mod', 'services/server/go.sum'):
        shutil.copy2(ROOT / rel, snapshot / rel)
    (private / 'overlay-tests').mkdir()
    replacements = {}
    manifest = {}
    for rel in ('services/server/internal', 'services/server/migrations', 'contracts/tools', 'runtimes/worker/skills'):
        for path in sorted((snapshot / rel).rglob('*')):
            if path.is_file():
                original = ROOT / path.relative_to(snapshot)
                if digest(path) != digest(original):
                    sys.exit('Source changed while snapshotting; no tests executed.')
                manifest[str(path.relative_to(snapshot))] = digest(path)
    for rel in ('services/server/go.mod', 'services/server/go.sum'):
        if digest(snapshot / rel) != digest(ROOT / rel):
            sys.exit('Source changed while snapshotting; no tests executed.')
        manifest[rel] = digest(snapshot / rel)
    for filename, target in TESTS.items():
        original = ROOT / 'scripts/test' / filename
        raw = original.read_bytes()
        manifest['scripts/test/' + filename] = hashlib.sha256(raw).hexdigest()
        if filename == 'm11w6-interactive-server_test.go':
            source = raw.decode()
            if source.count('func asString(') != 1:
                sys.exit('Unexpected W6 helper; no tests executed.')
            # W4 defines an identical helper. Rename only the W6 temporary
            # copy so both independent suites can share the same overlay.
            raw = source.replace('asString(', 'm11FinalW6AsString(').encode()
        if filename == 'm11w7-security-resolver_test.go':
            source = raw.decode()
            old = 'const dsn = "postgres://postgres:postgres@127.0.0.1:32777/postgres?sslmode=disable"'
            if source.count(old) != 1 or source.count('"net/http/httptest"') != 1:
                sys.exit('Unexpected W7 fixture; no tests executed.')
            source = source.replace('"net/http/httptest"', '"net/http/httptest"\n\t"os"', 1)
            source = source.replace(old, 'dsn := os.Getenv("TEST_DATABASE_URL")', 1)
            raw = source.encode()
        testcopy = private / 'overlay-tests' / filename
        testcopy.write_bytes(raw)
        replacements[str(snapshot / 'services/server/internal' / target)] = str(testcopy)
    # Recheck every copied input after collection so concurrent edits do not
    # silently produce a mixed source snapshot.
    for rel, expected in manifest.items():
        if digest(ROOT / rel) != expected:
            sys.exit('Source changed while snapshotting; no tests executed.')
    (private / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    overlay = private / 'overlay.json'
    overlay.write_text(json.dumps({'Replace': replacements}))
    cmd = ['go', 'test', '-json', '-vet=off', '-tags', 'integration', '-overlay', str(overlay), '-run', '^TestM11', '-count=1', './internal/server', './internal/gateway']
    print('Private snapshot:', private, flush=True)
    print('Executing ^TestM11 in server and gateway; raw output withheld.', flush=True)
    test_env = os.environ.copy()
    test_env['WHIPPET_SKILLS_PATH'] = str(snapshot / 'runtimes/worker/skills')
    test_env['WHIPPET_TOOL_REGISTRY_PATH'] = str(snapshot / 'contracts/tools/registry.json')
    proc = subprocess.run(cmd, cwd=snapshot / 'services/server', env=test_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    statuses = {}
    skipped = []
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        name = event.get('Test', '')
        action = event.get('Action')
        if name and action in ('pass', 'fail', 'skip'):
            if action == 'skip':
                skipped.append(name)
            if '/' not in name:
                statuses[name] = action
    missing = sorted(EXPECTED - statuses.keys())
    unexpected = sorted(statuses.keys() - EXPECTED)
    failed = sorted(k for k, v in statuses.items() if v != 'pass')
    success = proc.returncode == 0 and not skipped and not missing and not unexpected and not failed
    result = {'result': 'PASS' if success else 'FAIL', 'goExitCode': proc.returncode,
              'topLevelTests': dict(sorted(statuses.items())), 'missing': missing,
              'unexpected': unexpected, 'skipped': sorted(skipped),
              'sourceManifestSHA256': digest(private / 'manifest.json'),
              'runFilter': '^TestM11', 'packages': ['./internal/server', './internal/gateway'],
              'fixtureLimits': 'In-process HTTP/WebSocket and synthetic fixtures; no real Docker, UI, model or TLS handshake.'}
    (private / 'result.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    return 0 if success else 1

if __name__ == '__main__':
    sys.exit(main())
