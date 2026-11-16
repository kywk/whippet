#!/usr/bin/env python3
"""One explicit M12 candidate-container author smoke, then zero-model self-test +/-.

Existing private model.env is handed only to Docker. Outputs contain no env/key.
Never installs/deploys a baseline or writes Server DB. Requires a new directory.
"""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys
import uuid

REPO = Path(__file__).resolve().parents[2]
MODEL_ENV = Path('/Users/kywk/.local/share/whippet/m10z-20261115/model.env')

def write(path, data):
    with path.open('x') as target:
        json.dump(data, target, ensure_ascii=False, indent=2)
        target.write('\n')
    path.chmod(0o600)

def run(args, *, timeout=220):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if MODEL_ENV.is_symlink() or not MODEL_ENV.is_file() or stat.S_IMODE(MODEL_ENV.stat().st_mode) != 0o600:
        raise ValueError('controlled_model_configuration_unavailable')
    image = run(['docker', 'image', 'inspect', args.image, '--format', '{{.Id}}']).stdout.strip()
    if not image.startswith('sha256:'):
        raise ValueError('candidate_image_missing')
    out = args.out.resolve()
    out.mkdir(mode=0o700)
    skill = REPO / 'runtimes/worker/skills/test-author'
    manifest_bytes = (skill / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    registry_bytes = (REPO / 'contracts/tools/registry.json').read_bytes()
    registry = json.loads(registry_bytes)
    digest = lambda value: hashlib.sha256(value).hexdigest()
    ident = str(uuid.uuid4())
    scope = {'name': 'M12 synthetic setContent', 'purpose': 'candidate engine smoke', 'backgroundSummary': 'synthetic only',
             'targets': [{'name': 'synthetic', 'purpose': 'setContent fixture; do not navigate', 'origin': 'https://m12-fixture.invalid'}],
             'dependencies': [], 'excludedOrigins': [], 'exclusions': 'no navigation, login or filesystem', 'loginRoles': [], 'defaultTestUrl': '', 'timeoutMs': 25000}
    task = {'kind': 'author', 'runId': ident, 'attemptId': str(uuid.uuid4()), 'workspaceId': ident, 'testId': ident, 'script': '', 'scriptOrigin': 'ai', 'timeoutMs': 180000,
            'workspaceContext': {'schemaVersion': '1', 'workspaceId': ident, 'settingsRevision': 1, 'config': scope, 'roleRefs': []},
            'author': {'conversationId': ident, 'baseRevision': 1, 'messages': [{'role': 'user', 'content': '請新建單一 Playwright TypeScript 測試，使用 import { test, expect } from "@playwright/test"。只用 page.setContent 建立 <h1>Whippet ready</h1><button>Run test</button>，斷言 Run test 按鈕可見。不要導覽、不連外、不讀檔。完成 update_draft 自試後交付，不需要額外探索。'}],
                       'skillId': 'test-author', 'skillVersion': '1', 'editingSessionId': ident, 'contextRevision': 0, 'sourceVersion': None, 'conversationSummary': None,
                       'allowedTools': ['read_draft', 'update_draft', 'request_validation', 'browser_snapshot'], 'budget': manifest['budget'], 'model': manifest['model'],
                       'skills': [{'id': 'test-author', 'version': '1', 'sha256': digest((skill / 'SKILL.md').read_bytes()), 'manifestSha256': digest(manifest_bytes), 'referenceHashes': {r['id']: r['sha256'] for r in manifest['references']}}],
                       'toolRegistryVersion': registry['version'], 'toolRegistrySha256': digest(registry_bytes)}}
    write(out / 'input.json', task)
    write(out / 'intent.json', {'candidateImage': image, 'engine': 'vercel', 'model': manifest['model'], 'budget': {**manifest['budget'], 'maxOutputTokens': 8192}, 'registrySha256': digest(registry_bytes), 'noServerWrites': True})
    name = 'whippet-m12-w1-' + str(uuid.uuid4())
    code = 'const {readAIConfig,AI_DEFAULTS}=await import("./dist/ai/config.js");const c=readAIConfig(process.env);if(c.engine!=="vercel"||c.provider!=="opencode"||c.baseURL!==AI_DEFAULTS.baseURL||c.model!==AI_DEFAULTS.model||c.reasoningEffort!==AI_DEFAULTS.reasoningEffort)throw new Error("pinned_config_required");await import("./dist/author/main.js");'
    argv = ['docker', 'run', '--rm', '--name', name, '--label', 'whippet.m12-wave1=true', '--memory', '2g', '--cpus', '2', '--env-file', str(MODEL_ENV),
            '--env', 'WHIPPET_AI_ENGINE=vercel', '--env', 'WHIPPET_AI_PROVIDER=opencode', '--env', 'WHIPPET_WORK_DIR=/work',
            '--mount', 'type=bind,source=' + str(out) + ',target=/work', '--entrypoint', 'node', image, '--input-type=module', '-e', code]
    try:
        result = run(argv)
    finally:
        run(['docker', 'rm', '-f', name], timeout=15)
    # main emits only allowlisted structured progress and fixed error messages.
    (out / 'progress.jsonl').write_text(result.stdout)
    (out / 'progress.jsonl').chmod(0o600)
    artifact = json.loads((out / 'output/author.json').read_text()) if (out / 'output/author.json').is_file() else {}
    terminal = json.loads((out / 'output/result.json').read_text())
    script = artifact.get('script', '')
    if result.returncode != 0 or terminal['status'] != 'succeeded' or not script or artifact.get('partial') or 'Run test' not in script or 'toBeVisible' not in script:
        write(out / 'summary.json', {'passed': False, 'authorExit': result.returncode, 'terminal': terminal, 'candidatePresent': bool(script)})
        return 1
    check_code = '''import {readFile} from 'node:fs/promises';import {explorationBrowser} from './dist/author/tools.js';
const a=JSON.parse(await readFile('/work/output/author.json','utf8'));const b=explorationBrowser(process.env);
try{const good=await b.verifyDraft(a.script);const bad=await b.verifyDraft(a.script+"\\ntest('M12 deliberate failure',async()=>{expect('actual').toBe('expected');});\\n");
process.stdout.write(JSON.stringify({positive:{passed:good.passed,category:good.category},negative:{passed:bad.passed,category:bad.category},modelKeyAbsent:!process.env.OPENCODE_API_KEY&&!process.env.WHIPPET_AI_API_KEY}));}
finally{await b.close();}'''
    check_name = 'whippet-m12-check-' + str(uuid.uuid4())
    try:
        check = run(['docker', 'run', '--rm', '--name', check_name, '--label', 'whippet.m12-wave1=true', '--network', 'none', '--memory', '2g', '--mount', 'type=bind,source=' + str(out) + ',target=/work,readonly', '--entrypoint', 'node', image, '--input-type=module', '-e', check_code])
    finally:
        run(['docker', 'rm', '-f', check_name], timeout=15)
    checks = json.loads(check.stdout)
    passed = check.returncode == 0 and checks['positive']['passed'] and not checks['negative']['passed'] and checks['negative']['category'] == 'script_or_assertion' and checks['modelKeyAbsent']
    events = [json.loads(line).get('message', '') for line in result.stdout.splitlines() if line.startswith('{')]
    model_requests = sum(event.startswith('author:model:') and event.endswith(':started') for event in events)
    write(out / 'summary.json', {'passed': passed, 'candidateImage': image, 'terminal': terminal, 'modelRequests': model_requests, 'model': manifest['model'], 'checks': checks, 'scriptSha256': digest(script.encode()), 'noServerWrites': True})
    print(json.dumps({'passed': passed, 'modelRequests': model_requests, 'positivePassed': checks['positive']['passed'], 'intentionalAssertionFailed': not checks['negative']['passed'], 'modelKeyAbsentInValidation': checks['modelKeyAbsent']}))
    return 0 if passed else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"STOP","reason":"candidate_smoke_failed_details_hidden"}', file=sys.stderr)
        sys.exit(2)
